"""
Smoke-тест всего HTTP-слоя: реально поднимает приложение и гоняет каждый роут.
Закрывает главный известный пробел проекта («FastAPI-эндпоинты написаны, но не
прогнаны»): теперь они прогнаны.

Проверяется и то, чем эти роуты защищены: доступ к чужим деньгам решается
токеном сессии, а не полем запроса, поэтому сюда входят и отказные пути
(forged-токен, чужая подписка, вход кошельком с чужой подписью).

HTTP идёт через httpx.AsyncClient + ASGITransport, а не через TestClient: у
TestClient на каждый запрос свой event loop в отдельном потоке, а соединение
asyncpg привязано к циклу, в котором открыто, — второй запрос подряд получал бы
соединение из мёртвого цикла. Здесь запрос, приложение и проверка базы живут в
одном цикле теста, то есть пул работает ровно так же, как под uvicorn.

Запуск: WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test \\
        python -m unittest test_api_smoke -v
"""

import asyncio
import hashlib
import math
import hmac
import json
import logging
import threading
import time
import unittest
import uuid
from urllib.parse import urlencode

# Тестовое окружение (секрет сессии, фиктивный токен бота, ведро rate limit)
# задаёт testsupport — он должен быть импортирован раньше app и config, потому
# что config читает env один раз при импорте. Раньше эти строки дублировались
# здесь, и прогон `pytest test_db.py test_api_smoke.py` падал уже из-за порядка
# импортов: config успевает импортироваться тестом базы раньше, чем этот модуль
# успевает их подменить.
import testsupport  # noqa: E402  (импортируется первым из проектных модулей)

import httpx  # noqa: E402
import agent_db  # noqa: E402
import app  # noqa: E402
import api.auth as api_auth  # noqa: E402
import audit_log as al  # noqa: E402
import db  # noqa: E402
import session  # noqa: E402
from subscription import Tier  # noqa: E402

# httpx пишет в лог каждый запрос; на этом прогоне это 60 строк шума, а предмет
# теста — ответы роутов, не сам факт запроса.
logging.getLogger("httpx").setLevel(logging.WARNING)


class NullRateLimiter:
    """Всегда пропускает. Сам лимитер проверен в test_rate_limiter.py; здесь
    он не предмет теста, а помеха — тесты не поднимают Redis."""

    async def allow(self, key, cost=1.0):
        return True

    async def retry_after(self, key, cost=1.0):
        return 0.0

    async def ping(self):
        return True


app._rate_limiter = NullRateLimiter()


class HttpCase(testsupport.PgCase):
    """Клиент + чистая база на каждый тест: таблицы переживают тест, а тесты
    пишут в одну и ту же wake_test."""

    # индекс аккаунта Lighter, который «отвечает» подменённый lighter_rest
    wallet_account_index = 7

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app.app), base_url="http://testserver"
        )
        self.addAsyncCleanup(self.client.aclose)

    async def sign_in_telegram(self, telegram_id: int) -> dict:
        """Вход виджетом — самый дешёвый способ получить настоящий токен.

        Хелпер отдаёт заголовки, потому что почти каждый приватный роут теперь
        читает субъекта из Authorization; собирать токен вручную через
        session.issue() здесь нельзя — тест проверял бы не то, что выдаёт вход."""
        r = await self.client.post(
            "/auth/telegram", json=telegram_login_payload(user_id=telegram_id)
        )
        self.assertEqual(r.status_code, 200, r.text)
        return auth(r.json()["token"])

    def patch_wallet_infra(self) -> None:
        """Подменяет ровно три вещи, которых в песочнице нет: Redis, где лежит
        challenge (fakeredis), ответ Lighter про индекс аккаунта по адресу и
        средства этого аккаунта (кап маржи в плане копирования). Всё остальное,
        включая восстановление адреса из подписи, идёт кодом прода.

        Маржа подменяется числом, а не отказом: у подписчика с подтверждённым
        аккаунтом она есть, и кап по ней проверяется там, где он действительно
        что-то ограничивает, — в test_margin_cap_uses_the_venue_number.

        Повторный вызов ничего не пересохраняет: иначе cleanup второго вызова
        вернул бы первый fake вместо настоящего клиента."""
        if hasattr(self, "_wallet_originals"):
            return
        import fakeredis.aioredis
        import lighter_rest
        import wallet_auth

        self._wallet_originals = (
            wallet_auth._client,
            api_auth.get_account_index_by_l1,
            lighter_rest.get_account_equity,
        )
        wallet_auth._client = fakeredis.aioredis.FakeRedis(decode_responses=True)
        api_auth.get_account_index_by_l1 = lambda address, network=None: (
            self.wallet_account_index
        )
        lighter_rest.get_account_equity = lambda index, network=None: 250_000.0

        def restore():
            (
                wallet_auth._client,
                api_auth.get_account_index_by_l1,
                lighter_rest.get_account_equity,
            ) = self._wallet_originals

        self.addCleanup(restore)

    async def wallet_challenge(self, l1_address: str) -> str:
        self.patch_wallet_infra()
        r = await self.client.post(
            "/auth/wallet/challenge", json={"l1_address": l1_address}
        )
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["message"]

    async def sign_in_wallet(
        self, account_index: int = 7, account=None
    ) -> tuple[dict, object]:
        """Вход кошельком по-настоящему: challenge подписывается тем же ключом,
        из которого кошелёк получил адрес.

        Возвращает (заголовки, аккаунт): аккаунт нужен тестам на подпись, где
        подписывает не тот, кто запрашивал вход.
        """
        from eth_account import Account

        self.patch_wallet_infra()
        self.wallet_account_index = account_index
        account = account or Account.create()
        message = await self.wallet_challenge(account.address)
        signature = sign_challenge(message, account.key)

        r = await self.client.post(
            "/auth/wallet/verify", json={"message": message, "signature": signature}
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["user_id"], account.address)
        self.assertEqual(body["lighter_account_index"], account_index)
        return auth(body["token"]), account


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def sign_challenge(message: str, private_key) -> str:
    """Подпись challenge так же, как её делает кошелёк по personal_sign: EIP-191 с
    тем же encode_defunct, что использует проверка на бэкенде.

    Формат ответа — 0x-_prefixed hex: ровно то, что отдаёт браузерный кошелёк и
    что принимает recover_message.
    """
    from eth_account import Account
    from eth_account.messages import encode_defunct

    signature = Account.sign_message(
        encode_defunct(text=message), private_key=private_key
    ).signature
    return "0x" + signature.hex()


def forged_token(user_id: str = "tg_999") -> str:
    """Токен правильной формы, но с подделанной подписью.

    Именно так выглядит атака из консоли браузера: структуру wk1 придумывать не
    нужно, достаточно взять выданный токен и поменять один символ."""
    token, _ = session.issue(user_id)
    prefix, payload, signature = token.split(".")
    flipped = ("a" if signature[-1] != "a" else "b") + signature[:-1]
    return f"{prefix}.{payload}.{flipped}"


def telegram_login_payload(
    user_id: int = 4242, first_name: str = "Test", auth_date: int | None = None
) -> dict:
    """Подписывает данные так же, как это делает Telegram Login Widget (HMAC-SHA256 по
    отсортированным k=v строкам, ключ — sha256 от токена бота)."""
    payload = {
        "id": user_id,
        "first_name": first_name,
        "username": "smoke_user",
        "auth_date": auth_date if auth_date is not None else int(time.time()),
    }
    check_string = "\n".join(f"{k}={payload[k]}" for k in sorted(payload))
    secret = hashlib.sha256(testsupport.BOT_TOKEN.encode()).digest()
    payload["hash"] = hmac.new(
        secret, check_string.encode(), hashlib.sha256
    ).hexdigest()
    return payload


def mini_app_init_data(
    user_id: int = 4343,
    first_name: str = "Mini",
    auth_date: int | None = None,
    token: str | None = None,
) -> str:
    """Строка initData ровно так, как её подписывает Telegram внутри мини-аппа:
    HMAC-SHA256 по отсортированным k=v, ключ — HMAC-SHA256("WebAppData", токен бота).
    Ключ выводится иначе, чем у Login Widget, поэтому это отдельный хелпер."""
    token = token or testsupport.BOT_TOKEN
    params = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "query_id": "AAH-smoke",
        "user": json.dumps(
            {
                "id": user_id,
                "first_name": first_name,
                "username": f"smoke_mini_{user_id}",
                "language_code": "en",
            },
            ensure_ascii=False,
        ),
    }
    check_string = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    params["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(params)


class TestApiSmoke(HttpCase):
    async def test_health_routes(self):
        health = (await self.client.get("/health")).json()
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["network"], app.settings.wake_lighter_network)
        self.assertTrue(health["dry_run"])
        self.assertEqual((await self.client.get("/docs")).status_code, 200)
        self.assertEqual((await self.client.get("/openapi.json")).status_code, 200)

    async def test_rate_limiter_middleware_really_wraps_the_routes(self):
        """Ведро по IP стоит перед всеми роутами: на нулевом восполнении второй
        запрос подряд обязан получить 429, а не результат роута. Без этой проверки
        завышенная ёмкость ведра в заголовке файла могла бы означать «лимитер
        вообще не подключён»."""

        class FakeRateLimiter:
            def __init__(self):
                self._calls = 0

            async def allow(self, key, cost=1.0):
                self._calls += 1
                return self._calls == 1

            async def retry_after(self, key, cost=1.0):
                return 1.0

            async def close(self):
                pass

        original = app._rate_limiter
        app._rate_limiter = FakeRateLimiter()
        try:
            self.assertEqual(
                (await self.client.get("/predict/markets")).status_code, 200
            )
            r = await self.client.get("/predict/markets")
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)
        finally:
            app._rate_limiter = original
        self.assertEqual((await self.client.get("/predict/markets")).status_code, 200)

    async def test_copy_trading_cycle(self):
        # подписчик — вход кошельком: строка follows без подтверждённого индекса
        # Lighter не может ни зазеркалить, ни заплатить, поэтому POST /follows её
        # не заводит (отказ проверен ниже, отдельным тестом)
        leader_headers, _ = await self.sign_in_wallet(999)
        follower_headers, follower_account = await self.sign_in_wallet(777)
        follower_id = follower_account.address

        r = await self.client.post(
            "/leaders",
            json={"handle": "@smoke", "fee_bps": 8},
            headers=leader_headers,
        )
        self.assertEqual(r.status_code, 200, r.text)
        leader_id = r.json()["leader_id"]

        r = await self.client.get("/leaders")
        self.assertIn(leader_id, [x["id"] for x in r.json()])

        r = await self.client.post(
            "/follows",
            json={"leader_id": leader_id, "allocation_usd": 500},
            headers=follower_headers,
        )
        self.assertEqual(r.status_code, 200, r.text)
        follow_id = r.json()["follow_id"]

        r = await self.client.get("/follows", headers=follower_headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)
        self.assertEqual(r.json()[0]["follower_id"], follower_id)

        r = await self.client.get(f"/follows/by-leader/{leader_id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["follower_count"], 1)
        self.assertEqual(r.json()["total_aum_usd"], 500)
        self.assertNotIn(
            "follows",
            r.json(),
            "публичная витрина — агрегат; список людей с их суммами читает только "
            "владелец лидера (GET /leaders/{id}/followers)",
        )
        console = await self.client.get(
            f"/leaders/{leader_id}/followers", headers=leader_headers
        )
        self.assertEqual(console.status_code, 200)
        self.assertEqual([f["follower_id"] for f in console.json()], [follower_id])
        stranger = await self.client.get(
            f"/leaders/{leader_id}/followers", headers=follower_headers
        )
        self.assertEqual(
            stranger.status_code, 403, "чужую консоль подписчиков не читают"
        )

        r = await self.client.post(
            f"/follows/{follow_id}/pause", headers=follower_headers
        )
        self.assertEqual(r.status_code, 200)
        r = await self.client.get("/follows", headers=follower_headers)
        self.assertEqual(r.json()[0]["paused"], 1)
        r = await self.client.post(
            f"/follows/{follow_id}/resume", headers=follower_headers
        )
        self.assertEqual(r.status_code, 200)

        # чужая подписка не отдаётся, не ставится на паузу и не удаляется: у
        # второго входа свой субъект токена, а follower_id подставить нечем
        stranger = await self.sign_in_telegram(5002)
        r = await self.client.post(f"/follows/{follow_id}/pause", headers=stranger)
        self.assertEqual(r.status_code, 404)
        r = await self.client.delete(f"/follows/{follow_id}", headers=stranger)
        self.assertEqual(r.status_code, 404)
        r = await self.client.get("/follows", headers=stranger)
        self.assertEqual(r.json(), [])

        # комиссию лидера меняет только тот, чей вход привязал этот аккаунт:
        # второй кошелёк — свой, другой индекс, и он чужого лидера не трогает
        other_headers, _ = await self.sign_in_wallet(998)
        r = await self.client.patch(
            f"/leaders/{leader_id}/fee", json={"fee_bps": 12}, headers=other_headers
        )
        self.assertEqual(r.status_code, 403)
        r = await self.client.patch(
            f"/leaders/{leader_id}/fee", json={"fee_bps": 12}, headers=leader_headers
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["fee_bps"], 12)

        # подписка без подтверждённого кошелька лидера не публикуется: индекс
        # аккаунта — не то, что клиент может прислать сам. Сеанс берётся
        # телеграмный: у него индекса и нет (подписчику он нужен так же — см.
        # test_follow_requires_a_linked_lighter_account)
        no_wallet_headers = await self.sign_in_telegram(5003)
        r = await self.client.post(
            "/leaders", json={"handle": "@no-wallet"}, headers=no_wallet_headers
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "LIGHTER_ACCOUNT_NOT_LINKED")

        r = await self.client.post(
            "/simulate-mirror",
            json={
                "leader_id": leader_id,
                "market_id": 1,
                "side": "long",
                "is_increase": True,
                "size_delta": 0.5,
                "price": 100000,
                "price_decimals": 2,
                "leader_equity_usd": 50000,
            },
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["orders"]), 1)

        # side — Literal, а не «== "long", иначе short»: с опечаткой прогон
        # показывал план для противоположной ноги, и оператор проверял не то.
        for bad_side in ("Long", "buy", ""):
            r = await self.client.post(
                "/simulate-mirror",
                json={
                    "leader_id": leader_id,
                    "market_id": 1,
                    "side": bad_side,
                    "is_increase": True,
                    "size_delta": 0.5,
                    "price": 100000,
                    "price_decimals": 2,
                    "leader_equity_usd": 50000,
                },
                headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
            )
            self.assertEqual(
                r.status_code, 422, f"сторона {bad_side!r} не должна молча стать short"
            )

        # price_decimals обязателен: дефолт 0 означал бы ордер с ценой на два
        # порядка меньше рынка.
        r = await self.client.post(
            "/simulate-mirror",
            json={
                "leader_id": leader_id,
                "market_id": 1,
                "side": "long",
                "is_increase": True,
                "size_delta": 0.5,
                "price": 100000,
                "leader_equity_usd": 50000,
            },
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        self.assertEqual(r.status_code, 422, "цена без масштаба рынка — не план, а 500")

        # Границы по знаку и порядку: mirror_engine делит на price и на equity,
        # а NaN/inf до этой правки доходили до JSON и роняли 500 уже на
        # сериализации ответа. Значения ниже заведомо конечные — httpx сам
        # отказывается кодировать inf в запрос.
        for bad in ({"price": 0}, {"price": 1e12}, {"size_delta": -1}):
            r = await self.client.post(
                "/simulate-mirror",
                json={
                    "leader_id": leader_id,
                    "market_id": 1,
                    "side": "long",
                    "is_increase": True,
                    "size_delta": 0.5,
                    "price": 100000,
                    "price_decimals": 2,
                    "leader_equity_usd": 50000,
                    **bad,
                },
                headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
            )
            self.assertEqual(r.status_code, 422, f"вход {bad} обязан быть 422")

        r = await self.client.post(
            "/simulate-mirror",
            json={
                "leader_id": leader_id,
                "market_id": 1,
                "side": "long",
                "is_increase": True,
                "size_delta": 0.5,
                "price": 100000,
                "price_decimals": 2,
                "leader_equity_usd": 50000,
            },
        )
        self.assertEqual(
            r.status_code,
            403,
            "ответ перечисляет аллокации подписчиков — это не публичные данные",
        )

        r = await self.client.delete(f"/follows/{follow_id}", headers=follower_headers)
        self.assertEqual(r.status_code, 200)

        # Отписка — tombstone, а не DELETE строки: на подписке висит FK
        # mirror_log, и жёсткое удаление давало бы 500 на обычной кнопке.
        # Список своего подписчика её больше не отдаёт, публичный AUM — тоже.
        r = await self.client.get("/follows", headers=follower_headers)
        self.assertEqual(
            r.json(), [], "отменённая подписка не должна оставаться в списке"
        )
        r = await self.client.get(f"/follows/by-leader/{leader_id}")
        self.assertEqual(r.json()["follower_count"], 0)
        self.assertEqual(r.json()["total_aum_usd"], 0)

    async def test_leader_publication_is_backend_state(self):
        """Рубильник публикации — в базе, а не в памяти вкладки.

        До колонки leaders.active выключение публикации существовало только как
        useState: строка leaders оставалась активной, и единственный вход
        mirror_engine (active_follows_for_leader) продолжал отдавать подписчиков
        выключившегося лидера. Проверка на «движок больше ничего не планирует»
        сделана через POST /simulate-mirror — тот же путь, которым идёт план по
        реальным подпискам из базы."""
        leader_headers, _ = await self.sign_in_wallet(900)
        # подписчик с подтверждённым индексом: без кошелька /follows отказывает,
        # а этот тест про рубильник публикации
        follower_headers, _ = await self.sign_in_wallet(901)

        r = await self.client.post(
            "/leaders", json={"handle": "@switch", "fee_bps": 8}, headers=leader_headers
        )
        self.assertEqual(r.status_code, 200, r.text)
        leader_id = r.json()["leader_id"]
        self.assertTrue(r.json()["active"])

        r = await self.client.post(
            "/follows",
            json={"leader_id": leader_id, "allocation_usd": 1000},
            headers=follower_headers,
        )
        self.assertEqual(r.status_code, 200, r.text)

        simulate = {
            "leader_id": leader_id,
            "market_id": 1,
            "side": "long",
            "is_increase": True,
            "size_delta": 0.5,
            "price": 100000,
            "price_decimals": 2,
            "leader_equity_usd": 50000,
        }
        curator = {"X-Curator-Token": testsupport.CURATOR_TOKEN}

        r = await self.client.post("/simulate-mirror", json=simulate, headers=curator)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            len(r.json()["orders"]), 1, "по активному лидеру подписчик копируется"
        )

        r = await self.client.patch(
            f"/leaders/{leader_id}/active",
            json={"active": False},
            headers=leader_headers,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["active"])

        # Витрина лидера закрывает, своя карточка — показывает: иначе фронт не
        # отличит «выключен» от «никогда не публиковался».
        r = await self.client.get("/leaders")
        self.assertNotIn(leader_id, [x["id"] for x in r.json()])
        r = await self.client.get("/leaders/mine", headers=leader_headers)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["leader"]["active"])

        r = await self.client.post("/simulate-mirror", json=simulate, headers=curator)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(
            r.json()["orders"],
            [],
            "выключенный лидер не имеет права двигать счета подписчиков",
        )

        # Включается тем же POST /leaders: второй клик по включателю на уже
        # существующей записи обязан публиковать, а не молча вернуть старый id.
        r = await self.client.post(
            "/leaders", json={"handle": "@switch", "fee_bps": 8}, headers=leader_headers
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["leader_id"], leader_id)
        self.assertTrue(r.json()["active"])
        r = await self.client.post("/simulate-mirror", json=simulate, headers=curator)
        self.assertEqual(len(r.json()["orders"]), 1, "публикация возобновилась")

        # Право на переключение — владение лидером, а не знание его id.
        stranger_headers, _ = await self.sign_in_wallet(901)
        r = await self.client.patch(
            f"/leaders/{leader_id}/active",
            json={"active": False},
            headers=stranger_headers,
        )
        self.assertEqual(r.status_code, 403)
        r = await self.client.patch(
            "/leaders/нет-такого/active", json={"active": False}, headers=leader_headers
        )
        self.assertEqual(r.status_code, 404)

        # Вход без подтверждённого кошелька: своего лидера нет в природе.
        r = await self.client.get("/leaders/mine", headers=follower_headers)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["leader"])

        # active — булево поле модели, а не разбор строки: «yes»/«1» не должны
        # превращаться в «выключить».
        for bad in ("yes", "1", ""):
            r = await self.client.patch(
                f"/leaders/{leader_id}/active",
                json={"active": bad},
                headers=leader_headers,
            )
            self.assertEqual(r.status_code, 422, f"active={bad!r} — не bool")

    async def test_predict_cycle(self):
        curator = {"X-Curator-Token": testsupport.CURATOR_TOKEN}
        trader = await self.sign_in_telegram(6001)

        r = await self.client.post(
            "/predict/markets/price",
            json={
                "question": "BTC above 100k?",
                "lighter_market_id": 1,
                "threshold": 100000,
                "comparator": ">=",
                "resolve_at": 1999999999,
                "b": 100,
            },
        )
        self.assertEqual(
            r.status_code,
            403,
            "создание price-рынка без куратора — прямой путь к рынку, который зарезолвят под свою позицию",
        )

        r = await self.client.post(
            "/predict/markets/price",
            json={
                "question": "BTC above 100k?",
                "lighter_market_id": 1,
                "threshold": 100000,
                "comparator": ">=",
                "resolve_at": 1999999999,
                "b": 100,
            },
            headers=curator,
        )
        self.assertEqual(r.status_code, 200)
        market_id = r.json()["market_id"]

        # ручной триггер автоматической резолюции: без токена — отказ; с токеном —
        # отказ, потому что дедлайн рынка (2033 год) ещё не наступил. Сетевой запрос
        # к Lighter при этом не делается: обе проверки идут до него.
        r = await self.client.post(
            f"/predict/markets/{market_id}/resolve-price", json={}
        )
        self.assertEqual(
            r.status_code,
            403,
            "исход по внешней цене решают не деньгами позиции, а оператор",
        )
        r = await self.client.post(
            f"/predict/markets/{market_id}/resolve-price", json={}, headers=curator
        )
        self.assertEqual(r.status_code, 409, "до resolve_at закрывать рынок нельзя")

        # Цена берётся на дедлайне рынка, а не в момент вызова: подменяя
        # get_price_at, проверяем, что именно resolve_at доходит до оракула.
        # Рынок с прошедшим дедлайном заводится через слой данных: HTTP-создание
        # дедлайн в прошлом честно отклоняет, а резолвить такой рынок нужно.
        import lighter_rest
        import predict_db as pdb

        seen: list = []

        def fake_price_at(market_index, when_s, network=None):
            seen.append((market_index, when_s, network))
            return 130_000

        deadline = int(time.time()) - 600
        past_id = "smoke-resolve-past"
        await pdb.create_market(
            past_id,
            "price",
            "ETH above 2000?",
            deadline,
            100,
            lighter_market_id=0,
            threshold=2000,
            comparator=">",
        )
        original = lighter_rest.get_price_at
        lighter_rest.get_price_at = fake_price_at
        try:
            r = await self.client.post(
                f"/predict/markets/{past_id}/resolve-price", json={}, headers=curator
            )
        finally:
            lighter_rest.get_price_at = original
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["outcome"], "yes")
        self.assertEqual(seen[0][0], 0, "оракулу передан market_id рынка")
        self.assertEqual(
            seen[0][1],
            r.json()["resolve_at"],
            "цена запрошена на дедлайн рынка, а не на момент вызова",
        )
        self.assertEqual(
            seen[0][2],
            app.settings.wake_lighter_network,
            "сеть оракула берётся из процесса, а не из тела запроса",
        )
        row = (await self.client.get(f"/predict/markets/{past_id}")).json()
        self.assertTrue(
            str(row["resolved_by"]).startswith("curator:"),
            "ручная резолюция обязана быть подписана оператором, а не «auto»: иначе "
            "в базе ручной выбор цены неотличим от тика резолвера",
        )
        refused = await self.client.post(
            f"/predict/markets/{past_id}/resolve-price",
            json={"network": "testnet"},
            headers=curator,
        )
        self.assertEqual(
            refused.status_code,
            422,
            "сеть для чтения цены запросом не выбирается — рынок резолвится тем же "
            "Lighter, на котором живут ордера",
        )
        self.assertEqual(
            (await self.client.get(f"/predict/markets/{past_id}")).json()["outcome"],
            row["outcome"],
            "отказ в валидации тела ничего не меняет в уже вынесенном исходе",
        )

        audit = await al.recent_actions(action="market_resolution", limit=10)
        self.assertIn(
            past_id,
            [a["resource"] for a in audit],
            "автоматическая резолюция без записи в аудит — это исход без ответа «почему»",
        )

        def dead(market_index, when_s, network=None):
            raise RuntimeError("Lighter API недоступен")

        dead_id = "smoke-resolve-dead"
        await pdb.create_market(
            dead_id,
            "price",
            "ETH above 2000?",
            int(time.time()) - 60,
            100,
            lighter_market_id=0,
            threshold=2000,
            comparator=">",
        )
        lighter_rest.get_price_at = dead
        try:
            r = await self.client.post(
                f"/predict/markets/{dead_id}/resolve-price", json={}, headers=curator
            )
        finally:
            lighter_rest.get_price_at = original
        self.assertEqual(r.status_code, 502, "без цены рынок остаётся открытым")
        self.assertEqual(
            (await self.client.get(f"/predict/markets/{dead_id}")).json()["status"],
            "open",
        )

        # javascript: в качестве «источника» превращается в ссылку в интерфейсе.
        r = await self.client.post(
            "/predict/markets/event",
            json={"question": "Схема ссылки?", "resolve_at": 1999999999, "b": 100},
            headers=curator,
        )
        scheme_id = r.json()["market_id"]
        r = await self.client.post(
            f"/predict/markets/{scheme_id}/resolve-event",
            json={
                "outcome": "yes",
                "resolved_by": "curator@test",
                "evidence_url": "javascript:alert(1)",
            },
            headers=curator,
        )
        self.assertEqual(r.status_code, 400, "не http(s) схема в evidence_url не исход")
        self.assertEqual(
            (await self.client.get(f"/predict/markets/{scheme_id}")).json()["status"],
            "open",
            "отклонённая резолюция не имеет права закрыть рынок",
        )

        r = await self.client.post(
            "/predict/markets/event",
            json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100},
        )
        self.assertEqual(
            r.status_code, 403, "event-market без токена куратора должен быть запрещён"
        )

        r = await self.client.post(
            "/predict/markets/event",
            json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100},
            headers=curator,
        )
        self.assertEqual(r.status_code, 200)
        event_id = r.json()["market_id"]

        r = await self.client.get("/predict/markets")
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(len(r.json()), 2)

        r = await self.client.get(
            f"/predict/markets/{market_id}/preview?outcome=yes&shares=5"
        )
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["cost_usd"], 0)

        # preview — тот же расчёт, что и сделка: ноль и чужой исход должны
        # отклоняться, иначе в карточке рынка появляется цена, которой нет
        self.assertEqual(
            (
                await self.client.get(
                    f"/predict/markets/{market_id}/preview?outcome=yes&shares=0"
                )
            ).status_code,
            400,
        )
        self.assertEqual(
            (
                await self.client.get(
                    f"/predict/markets/{market_id}/preview?outcome=grey&shares=5"
                )
            ).status_code,
            422,
        )

        # сделка без входа невозможна: до токена trade брал user_id из тела, и
        # «сыграть на чужом месте» стоило одну строку JSON
        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": 10},
        )
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "SESSION_REQUIRED")

        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": 10},
            headers=auth(forged_token("tg_6001")),
        )
        self.assertEqual(
            r.status_code, 401, "токен правильной формы, но не с нашей подписью"
        )
        self.assertEqual(r.json()["error"]["code"], "SESSION_BAD_SIGNATURE")

        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": 10},
            headers=trader,
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertGreater(r.json()["cost_usd"], 0)
        buy_cost = r.json()["cost_usd"]

        # продажа половины позиции: cost отрицательный, юзеру возвращаются деньги
        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": -4},
            headers=trader,
        )
        self.assertEqual(r.status_code, 200)
        self.assertLess(r.json()["cost_usd"], 0)
        sell_cost = r.json()["cost_usd"]

        # каждая состоявшаяся сделка попадает в аудит: без этого разбирать
        # «кто и когда нажал» было бы нечем. Актёр — субъект токена, а не строка
        # из запроса.
        audit = await al.recent_actions(actor="tg_6001", action="trade_executed")
        self.assertEqual(len(audit), 2)
        self.assertTrue(all(row["success"] == 1 for row in audit))

        # отказ тоже аудится — попытка продать больше, чем есть, это то, что
        # стоит увидеть постфактум
        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": -1000},
            headers=trader,
        )
        self.assertEqual(r.status_code, 400)
        failed = [
            row
            for row in await al.recent_actions(actor="tg_6001", action="trade_executed")
            if row["success"] == 0
        ]
        self.assertEqual(len(failed), 1)

        # объём считается по |cost| обеих состоявшихся сделок — это сделки через
        # Wake, не рыночный объём
        r = await self.client.get("/predict/markets")
        row = next(m for m in r.json() if m["id"] == market_id)
        self.assertEqual(row["trade_count"], 2)
        self.assertAlmostEqual(row["volume_usd"], buy_cost + abs(sell_cost), delta=1e-6)

        # позиции трейдера: 6 shares YES, средняя входа = уплаченное минус возвращенное
        r = await self.client.get("/predict/positions", headers=trader)
        self.assertEqual(r.status_code, 200)
        pos = next(p for p in r.json() if p["market_id"] == market_id)
        self.assertEqual(pos["shares"], 6)
        self.assertEqual(pos["outcome"], "yes")
        self.assertFalse(pos["claimed"])

        # чужой вход своих позиций не видит: список строится по субъекту токена
        stranger = await self.sign_in_telegram(6002)
        r = await self.client.get("/predict/positions", headers=stranger)
        self.assertEqual(
            r.status_code, 200, "пустой список своих позиций — это норма, а не ошибка"
        )
        self.assertNotIn(market_id, [p["market_id"] for p in r.json()])

        r = await self.client.post(
            f"/predict/markets/{market_id}/resolve-event",
            json={
                "outcome": "yes",
                "resolved_by": "curator",
                "evidence_url": "https://example.com",
            },
        )
        self.assertEqual(
            r.status_code, 403, "resolve-event без токена куратора должен быть запрещён"
        )

        r = await self.client.post(
            f"/predict/markets/{market_id}/resolve-event",
            json={
                "outcome": "yes",
                "resolved_by": "curator",
                "evidence_url": "https://example.com",
            },
            headers=curator,
        )
        self.assertEqual(r.status_code, 200)

        # исход выносится один раз: переписать его = переписать выплаты
        r = await self.client.post(
            f"/predict/markets/{market_id}/resolve-event",
            json={
                "outcome": "no",
                "resolved_by": "curator",
                "evidence_url": "https://example.com",
            },
            headers=curator,
        )
        self.assertEqual(r.status_code, 409)

        # резолюция записана в аудит — с тем же исходом, что лёг в базу
        resolution_rows = await al.recent_actions(
            actor="curator", action="market_resolution"
        )
        self.assertEqual([row["resource"] for row in resolution_rows], [market_id])

        # чужой выигрыш не забирается: у stranger по этому рынку нет позиции, и
        # пока claim принимал user_id в query, он получил бы 6.0 за tg_6001
        r = await self.client.post(
            f"/predict/markets/{market_id}/claim", headers=stranger
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payout_usd"], 0.0)

        r = await self.client.post(
            f"/predict/markets/{market_id}/claim", headers=trader
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payout_usd"], 6.0)

        # повторная выплата по тому же рынку — 0: позиция уже закрыта выплатой
        r = await self.client.post(
            f"/predict/markets/{market_id}/claim", headers=trader
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payout_usd"], 0.0)

        # payout 0 — это исполненный claim, а не сбой. Пока success считался как
        # payout > 0, проигравшая ставка и повторный claim ложились в аудит
        # success=0 и наполняли GET /audit?failed_only нормальными операциями:
        # фильтр, по которому ищут настоящее, переставал читаться.
        claims = [
            row
            for row in await al.recent_actions(action="predict_claim")
            if row["resource"] == market_id
        ]
        self.assertEqual(len(claims), 3)
        self.assertTrue(all(row["success"] == 1 for row in claims))

        # резолванный рынок виден только по фильтру, открытый список его больше не отдаёт
        r = await self.client.get("/predict/markets?status=resolved")
        self.assertIn(market_id, [m["id"] for m in r.json()])
        r = await self.client.get("/predict/markets?status=open")
        self.assertNotIn(market_id, [m["id"] for m in r.json()])
        r = await self.client.get("/predict/markets?status=bogus")
        self.assertEqual(
            r.status_code,
            422,
            "неизвестный статус — не «пустой список», а явная ошибка",
        )

        # после резолюции позиция остаётся видимой, но claimable становится 0 после выплаты
        r = await self.client.get("/predict/positions", headers=trader)
        pos = next(p for p in r.json() if p["market_id"] == market_id)
        self.assertTrue(pos["claimed"])
        self.assertEqual(pos["claimable_usd"], 0.0)
        self.assertEqual(pos["market_outcome"], "yes")

        # event-рынок резолвится тем же путём
        r = await self.client.post(
            f"/predict/markets/{event_id}/resolve-event",
            json={
                "outcome": "no",
                "resolved_by": "curator",
                "evidence_url": "https://example.com",
            },
            headers=curator,
        )
        self.assertEqual(r.status_code, 200)

    async def test_funding_arb(self):
        r = await self.client.post(
            "/funding-arb/check",
            json={
                "market_id": 1,
                "symbol": "BTC",
                "hourly_rate": 0.0001,
                "direction": "long",
            },
        )
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["opportunity"])
        self.assertGreater(r.json()["opportunity"]["annualized_yield"], 0.8)

        r = await self.client.post(
            "/funding-arb/size",
            json={
                "capital_usd": 1000,
                "price": 100000,
                "perp_size_decimals": 3,
                "spot_size_decimals": 3,
                "perp_min_base_amount": 0.001,
                "spot_min_base_amount": 0.001,
            },
        )
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["position"])

    async def test_mirror_plan_is_capped_by_the_venue_margin(self):
        """POST /simulate-mirror планирует по средствам, которые отвечает Lighter, а
        не по тем, которые подписчик вписал в форму: кап `маржа × max_leverage` на
        заявленной марже не ограничивает ничем, и оператор видел бы план, который
        биржа отклонит. Тот же источник, что у живого листенера.

        Арифметика: доля риска лидера 0.5×2000/50000 = 2%, desired = 2% от $20 000
        = $400; средства аккаунта $100 при max_leverage 3 дают кап $300, то есть
        0.15 ETH вместо 0.2."""
        import lighter_rest

        leader_headers, _ = await self.sign_in_wallet(810)
        follower_headers, follower_account = await self.sign_in_wallet(811)
        r = await self.client.post(
            "/leaders", json={"handle": "@cap", "fee_bps": 8}, headers=leader_headers
        )
        leader_id = r.json()["leader_id"]
        r = await self.client.post(
            "/follows",
            json={"leader_id": leader_id, "allocation_usd": 20_000},
            headers=follower_headers,
        )
        self.assertEqual(r.status_code, 200, r.text)
        curator = {"X-Curator-Token": testsupport.CURATOR_TOKEN}
        simulate = {
            "leader_id": leader_id,
            "market_id": 1,
            "side": "long",
            "is_increase": True,
            "size_delta": 0.5,
            "price": 2000,
            "price_decimals": 2,
            "leader_equity_usd": 50_000,
        }

        original = lighter_rest.get_account_equity
        lighter_rest.get_account_equity = lambda index, network=None: 100.0
        try:
            body = (
                await self.client.post(
                    "/simulate-mirror", json=simulate, headers=curator
                )
            ).json()
        finally:
            lighter_rest.get_account_equity = original
        self.assertEqual(len(body["orders"]), 1)
        self.assertAlmostEqual(body["orders"][0]["base_amount"], 0.15)

        lighter_rest.get_account_equity = lambda index, network=None: None
        try:
            body = (
                await self.client.post(
                    "/simulate-mirror", json=simulate, headers=curator
                )
            ).json()
        finally:
            lighter_rest.get_account_equity = original
        self.assertEqual(body["orders"], [], "без подтверждённых средств плана нет")
        self.assertEqual(
            [(s["follower_id"], s["reason"]) for s in body["skipped"]],
            [(follower_account.address, "margin_unverified")],
            "причина отказа от копирования обязана быть в ответе, а не в молчании",
        )


class TestFundingLiveRoutes(HttpCase):
    """GET-роуты funding читают живой Lighter, поэтому прогоняются на фикстурах с
    ФОРМОЙ ответа, снятой с mainnet 2026-10-02: market_id и rate — числа, а не
    строки; каждая площадка подписывает актив голым базовым именем ("BTC");
    market_id-фильтр в query игнорируется, ответ всегда полный. Сами ставки
    меняются каждый час, поэтому числа здесь свои — важны типы и форма.
    Сеть не трогается: подменяется функция lighter_rest, а не HTTP-слой."""

    RATES = [
        {"exchange": "lighter", "market_id": 1, "rate": 0.00008, "symbol": "BTC"},
        {"exchange": "lighter", "market_id": 0, "rate": -0.0003, "symbol": "ETH"},
        {"exchange": "hyperliquid", "market_id": 1, "rate": 0.0001, "symbol": "BTC"},
        {"exchange": "bybit", "market_id": 1, "rate": -0.0000153, "symbol": "BTC"},
    ]
    BOOKS = [
        {
            "market_id": 0,
            "symbol": "ETH",
            "market_type": "perp",
            "status": "active",
            "min_base_amount": "0.0050",
            "supported_size_decimals": 3,
        },
        {
            "market_id": 2048,
            "symbol": "ETH/USDC",
            "market_type": "spot",
            "status": "active",
            "min_base_amount": "0.0010",
            "supported_size_decimals": 4,
        },
        {
            "market_id": 1,
            "symbol": "BTC",
            "market_type": "perp",
            "status": "active",
            "min_base_amount": "0.00007",
            "supported_size_decimals": 5,
        },
    ]

    async def asyncSetUp(self):
        await super().asyncSetUp()
        import lighter_rest

        self._rates = lighter_rest.get_funding_rates
        self._books = lighter_rest.get_order_books
        lighter_rest.get_funding_rates = lambda network=None: list(self.RATES)
        lighter_rest.get_order_books = lambda network="perp": list(self.BOOKS)
        self.addCleanup(setattr, lighter_rest, "get_funding_rates", self._rates)
        self.addCleanup(setattr, lighter_rest, "get_order_books", self._books)

    async def test_rates_ranked_longs_first_then_by_size(self):
        body = (await self.client.get("/funding/rates")).json()
        self.assertEqual(
            body["epoch_hours"], 1, "годовая считается на часовой эпох, не на 8-часовой"
        )
        got = body["rates"]
        # ETH с -0.0003 по модулю больше BTC с 0.00008, но стоит ниже: там
        # платят шорты, и cash-and-carry без займа на нём не строится. Ранжировать
        # по модулю означало бы открывать список невозможной возможностью.
        self.assertEqual(
            [x["market_id"] for x in got], [1, 0], "сначала те, где платят лонги"
        )
        self.assertEqual([x["direction"] for x in got], ["long", "short"])
        self.assertAlmostEqual(got[0]["annualized"], 0.00008 * 24 * 365, places=9)
        self.assertEqual(got[0]["signed_rate"], 0.00008)
        self.assertEqual(got[1]["signed_rate"], -0.0003)
        # Имя рынка берётся из строки той же площадки: поле symbol — то, что
        # реально отдаёт Lighter (голый базовый актив), base — нормализованный
        # тикер для сопоставлений на фронте.
        self.assertEqual([x["symbol"] for x in got], ["BTC", "ETH"])
        self.assertEqual([x["base"] for x in got], ["BTC", "ETH"])
        # В ответе только строки Lighter: две из четырёх фикстурых строк принадлежат
        # чужим площадкам, и примесь их ставок дала бы total=4.
        self.assertEqual(body["total"], 2)

    async def test_positive_only_leaves_capturable_side(self):
        got = (await self.client.get("/funding/rates?positive_only=true")).json()[
            "rates"
        ]
        self.assertEqual([x["market_id"] for x in got], [1])
        self.assertTrue(all(x["direction"] == "long" for x in got))

    async def test_rates_limit_and_502(self):
        self.assertEqual(
            len((await self.client.get("/funding/rates?limit=1")).json()["rates"]), 1
        )
        self.assertEqual(
            (await self.client.get("/funding/rates?limit=0")).status_code, 422
        )
        self.assertEqual(
            (await self.client.get("/funding/rates?limit=1000")).status_code, 422
        )

        import lighter_rest

        def boom(network=None):
            raise RuntimeError("Lighter API недоступен")

        lighter_rest.get_funding_rates = boom
        r = await self.client.get("/funding/rates")
        self.assertEqual(
            r.status_code,
            502,
            "мёртвый апстрим — явная ошибка, не пустой список ставок",
        )
        self.assertIn("Lighter", r.json()["error"]["message"])

    async def test_venues_group_by_asset_and_accept_typed_spelling(self):
        """/funding/venues полезен ровно одним: ставки одного актива рядом, по
        площадкам. Площадки в живом ответе подписывают актив голым именем, так что
        нормализация нужна для ВВОДА — юзер впишет "BTC-PERP" или "btcusdt" со
        сторонней биржи, и такой запрос обязан найти те же строки, что и "BTC"."""
        expected = [
            {
                "venue": "bybit",
                "symbol": "BTC",
                "market_id": 1,
                "signed_rate": -0.0000153,
            },
            {
                "venue": "hyperliquid",
                "symbol": "BTC",
                "market_id": 1,
                "signed_rate": 0.0001,
            },
            {
                "venue": "lighter",
                "symbol": "BTC",
                "market_id": 1,
                "signed_rate": 0.00008,
            },
        ]
        for typed in ("btc", "BTC-PERP", "btcusdt", "BTC/USDC"):
            r = await self.client.get(f"/funding/venues?symbol={typed}")
            self.assertEqual(r.status_code, 200, typed)
            body = r.json()
            self.assertEqual(body["base"], "BTC", typed)
            self.assertEqual(
                sorted(body["venues"], key=lambda v: v["venue"]), expected, typed
            )
            rates = [v["signed_rate"] for v in body["venues"]]
            self.assertEqual(
                rates, sorted(rates, reverse=True), "отсортировано по убыванию ставки"
            )

        r = await self.client.get("/funding/venues?symbol=NOPE")
        self.assertEqual(r.status_code, 404)

    async def test_carry_markets_lists_real_pairs_with_sizing_inputs(self):
        r = await self.client.get("/funding/carry-markets")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["quote"], "USDC")
        self.assertEqual(body["count"], 1, "только ETH имеет обе ноги в этой книге")
        eth = body["markets"][0]
        self.assertEqual((eth["perp_market_id"], eth["spot_market_id"]), (0, 2048))
        self.assertEqual(
            (eth["perp_min_base_amount"], eth["spot_min_base_amount"]), (0.005, 0.001)
        )
        self.assertEqual((eth["perp_size_decimals"], eth["spot_size_decimals"]), (3, 4))
        self.assertEqual(eth["hourly_rate"], 0.0003)
        self.assertAlmostEqual(eth["annualized"], 0.0003 * 24 * 365, places=9)

    async def test_carry_market_without_funding_row_is_reported_not_dropped(self):
        """Пара существует на книге независимо от того, есть ли по ней ставка:
        убрать её из списка — значит соврать про количество рынков."""
        import lighter_rest

        lighter_rest.get_funding_rates = lambda network=None: []
        body = (await self.client.get("/funding/carry-markets")).json()
        self.assertEqual(body["count"], 1)
        self.assertIsNone(body["markets"][0]["hourly_rate"])
        self.assertIsNone(body["markets"][0]["annualized"])


class TestMarketsOverview(HttpCase):
    """Главный экран сайта и /markets в боте обязаны показывать ОДНИ числа,
    поэтому роут проверяется на фикстурах с формой живого ответа mainnet
    (2026-10-02): market_id и decimals — числа, price/volume — из свечей,
    funding-строки — голые базовые имена. Сеть не трогается."""

    ROWS = [
        {
            "market_id": 1,
            "symbol": "BTC",
            "base": "BTC",
            "price": 84408.7,
            "change_24h": -0.002,
            "quote_volume_24h": 847_800_000.0,
            "open_interest_base": 370.84,
            "min_base_amount": 0.00007,
            "size_decimals": 5,
            "taker_fee": 0.0,
            "maker_fee": 0.0,
        },
        {
            "market_id": 0,
            "symbol": "ETH",
            "base": "ETH",
            "price": 2660.34,
            "change_24h": -0.0138,
            "quote_volume_24h": 350_500_000.0,
            "open_interest_base": 152_300.0,
            "min_base_amount": 0.005,
            "size_decimals": 3,
            "taker_fee": 0.0,
            "maker_fee": 0.0,
        },
        {
            "market_id": 120,
            "symbol": "LIT",
            "base": "LIT",
            "price": 3.11,
            "change_24h": 0.05,
            "quote_volume_24h": 20_300_000.0,
            "open_interest_base": 4_100_000.0,
            "min_base_amount": 1.0,
            "size_decimals": 0,
            "taker_fee": 0.0,
            "maker_fee": 0.0,
        },
    ]
    # BTC и LIT пришли из ответа Lighter, ETH — нет: роут обязан показать отсутствие
    # ставки пустым полем, а не выкинуть рынок из обзора.
    RATES = [
        {"exchange": "lighter", "market_id": 1, "rate": 0.00008, "symbol": "BTC"},
        {"exchange": "lighter", "market_id": 120, "rate": -0.00012, "symbol": "LIT"},
        {"exchange": "binance", "market_id": 1, "rate": 0.0001, "symbol": "BTC"},
    ]

    async def asyncSetUp(self):
        await super().asyncSetUp()
        import lighter_rest

        self._overview = lighter_rest.get_market_overview
        self._rates = lighter_rest.get_funding_rates
        lighter_rest.get_market_overview = lambda symbols=None, network=None: {
            "network": network or "mainnet",
            "ranked_by": "quote_volume_24h",
            "count": len(self.ROWS),
            "rows": [dict(r) for r in self.ROWS],
            "no_market": ["TON"],
            "no_data": ["MATIC"],
        }
        lighter_rest.get_funding_rates = lambda network=None: list(self.RATES)
        self.addCleanup(setattr, lighter_rest, "get_market_overview", self._overview)
        self.addCleanup(setattr, lighter_rest, "get_funding_rates", self._rates)

    async def test_rows_carry_funding_and_keep_gap_visible(self):
        r = await self.client.get("/markets/overview")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(
            body["epoch_hours"], 1, "годовая считается на часовой эпох, не на 8-часовой"
        )
        self.assertEqual(body["ranked_by"], "quote_volume_24h")
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["no_market"], ["TON"])
        self.assertEqual(body["no_data"], ["MATIC"])
        # Порядок — за lighter_rest (по $-обороту), роут его не переиначивает.
        self.assertEqual([x["market_id"] for x in body["rows"]], [1, 0, 120])

        by_id = {x["market_id"]: x for x in body["rows"]}
        self.assertAlmostEqual(
            by_id[1]["funding_annualized"], 0.00008 * 24 * 365, places=9
        )
        self.assertEqual(
            by_id[1]["funding_payer"], "long", "положительная ставка — платят лонги"
        )
        # Отрицательная ставка остаётся беззнаковой в hourly и говорит, кто платит.
        self.assertEqual(by_id[120]["funding_hourly"], 0.00012)
        self.assertEqual(by_id[120]["funding_payer"], "short")
        # Рынок без строки funding виден, но ставка — null, а не 0.
        self.assertIsNone(by_id[0]["funding_hourly"])
        self.assertIsNone(by_id[0]["funding_annualized"])
        self.assertIsNone(by_id[0]["funding_payer"])
        # Ставки чужих площадок в Lighter-обзор не подмешиваются: binance-строка
        # того же BTC игнорируется, и лёгкая ошибка в venue дала бы 0.0001.
        self.assertEqual(by_id[1]["funding_hourly"], 0.00008)

    async def test_dead_upstream_is_502_not_empty_overview(self):
        import lighter_rest

        def boom(symbols=None, network=None):
            raise RuntimeError("Lighter API недоступен")

        lighter_rest.get_market_overview = boom
        r = await self.client.get("/markets/overview")
        self.assertEqual(r.status_code, 502)
        self.assertIn("Lighter", r.json()["error"]["message"])


class TestPortfolioAndAgent(HttpCase):
    """Агент и подписка: тир читается из базы, субъект — из токена, а трайл и
    дневной объём переживают рестарт процесса, потому что живут в PostgreSQL.

    Ряд цен и шаг рынка агент теперь берёт из Lighter сам, поэтому тест
    подменяет lighter_rest.get_candles / get_order_books — ровно те два вызова,
    которые появились в роуте вместо recent_prices из тела запроса."""

    STEP = {
        "market_id": 1,
        "resolution": "1h",
        "candles": 5,
        "base_size_usd": 100,
    }

    CLOSES = [99000, 99500, 100000, 100500, 101000]

    def setUp(self):
        super().setUp()
        import lighter_rest

        original_books = lighter_rest.get_order_books
        original_candles = lighter_rest.get_candles

        lighter_rest.get_order_books = lambda network=None: [
            {
                "market_id": "1",
                "symbol": "ETH",
                "status": "active",
                "market_type": "perp",
                "supported_size_decimals": 4,
                "supported_price_decimals": 2,
            }
        ]
        lighter_rest.get_candles = lambda mid, resolution="1h", count=24, network=None: [
            {"c": c, "o": c, "h": c, "l": c, "V": 1, "t": i}
            for i, c in enumerate(self.CLOSES[:count])
        ]
        self.addCleanup(setattr, lighter_rest, "get_order_books", original_books)
        self.addCleanup(setattr, lighter_rest, "get_candles", original_candles)

    async def test_two_steps_at_once_cannot_double_spend(self):
        """Два параллельных шага одного пользователя читают один и тот же
        `risk_state_today` до того, как первый успеет что-нибудь записать, и
        исполняют оба: лимит дневного объёма и лимит позиции по рынку обходятся
        двойным тапом. Замок держится на время всего шага, поэтому второй запрос
        получает 409, а не план; чужому пользователю он не мешает, и после
        завершения шага замок снимается."""
        import lighter_rest

        user = await self.sign_in_telegram(7007)
        other = await self.sign_in_telegram(7008)
        for headers in (user, other):
            self.assertEqual(
                (
                    await self.client.post("/subscription/trial", headers=headers)
                ).status_code,
                200,
            )

        real = lighter_rest.get_candles
        release = threading.Event()
        entered = threading.Event()

        def slow(*args, **kwargs):
            entered.set()
            release.wait(5)
            return real(*args, **kwargs)

        lighter_rest.get_candles = slow
        try:
            first = asyncio.create_task(
                self.client.post("/agent/step", json=self.STEP, headers=user)
            )
            for _ in range(250):  # ждать нельзя блокировать цикл: запрос живёт в нём
                if entered.is_set():
                    break
                await asyncio.sleep(0.02)
            else:
                self.fail("шаг не дошёл до чтения свечей")
            busy = await self.client.post("/agent/step", json=self.STEP, headers=user)
            self.assertEqual(
                busy.status_code,
                409,
                "параллельный шаг того же пользователя обязан ждать, а не решать",
            )
            self.assertEqual(busy.json()["error"]["code"], "AGENT_STEP_IN_PROGRESS")
            elsewhere = await self.client.post(
                "/agent/step", json=self.STEP, headers=other
            )
            self.assertEqual(
                elsewhere.status_code,
                200,
                "замок лежит на пользователе, а не на всём роуте",
            )
            release.set()
            self.assertEqual((await first).status_code, 200)
        finally:
            release.set()
            lighter_rest.get_candles = real

        after = await self.client.post("/agent/step", json=self.STEP, headers=user)
        self.assertEqual(after.status_code, 200, "замок обязан быть снят после шага")
        memory = await agent_db.load_memory("tg_7007")
        self.assertEqual(
            len(memory.trades),
            1,
            "двойной тап не удваивает сделку: дневной объём считается по строкам",
        )

    async def test_subscription_trial_and_agent_step(self):
        user = await self.sign_in_telegram(7001)
        user_id = "tg_7001"

        # без строки подписки человек существует как free: терминал открыт, агента нет
        r = await self.client.get("/subscription", headers=user)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["tier"], "none")
        self.assertFalse(r.json()["has_ai_agent"])

        # шаг агента без трайла запрещён на сервере: проверка на фронте — подсказка,
        # а до роута можно дойти curl'ом
        r = await self.client.post("/agent/step", json=self.STEP, headers=user)
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "FEATURE_NOT_AVAILABLE")

        r = await self.client.post("/agent/step", json=self.STEP)
        self.assertEqual(r.status_code, 401)

        r = await self.client.post("/subscription/trial", headers=user)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["tier"], "free_trial")
        self.assertTrue(r.json()["has_ai_agent"])

        # строку собрал домен, а не репозиторий: у выданного трайла trial_started_at
        # — тот же момент, что и начало подписки (subscription.start_trial), и
        # держится она за одну метку времени
        trial = await agent_db.get_subscription(user_id)
        self.assertEqual(trial.tier, Tier.FREE_TRIAL)
        self.assertEqual(trial.started_at, trial.trial_started_at)
        self.assertLess(abs(time.time() - trial.started_at), 60)

        # повторный трайл не двигает trial_started_at: иначе 14 дней продлеваются
        # кликом, и это же больше не обнуляется деплоем
        first = await agent_db.get_subscription(user_id)
        r = await self.client.post("/subscription/trial", headers=user)
        self.assertEqual(r.json()["tier"], "free_trial")
        second = await agent_db.get_subscription(user_id)
        self.assertEqual(first.trial_started_at, second.trial_started_at)

        # momentum +2% по фикстурированному ряду — правило открывает long
        r = await self.client.post("/agent/step", json=self.STEP, headers=user)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["action"], "long")
        self.assertEqual(
            body["execution"]["status"], "dry_run", "WAKE_DRY_RUN по умолчанию"
        )
        self.assertGreater(body["volume_today_usd"], 0)

        # сделка записана в базу, а не в словарь процесса: память, набранная за
        # шаг, дописывается после него
        rows = await agent_db.load_memory(user_id)
        self.assertEqual(len(rows.trades), 1)
        self.assertEqual(rows.trades[0].market_id, 1)
        self.assertEqual(rows.trades[0].side, "long")

        # дневной объём выводится из тех же строк: второй вызов видит то, что
        # первый оставил в PostgreSQL
        r = await self.client.get("/agent/memory", headers=user)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["open_trades"]), 1)
        self.assertEqual(r.json()["volume_today_usd"], body["volume_today_usd"])

        # тот же ряд при открытой позиции в ту же сторону — hold: шаг ничего не
        # исполняет, и execution остаётся пустым, а не выдуманным статусом
        r = await self.client.post("/agent/step", json=self.STEP, headers=user)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["execution"])
        after_hold = await agent_db.load_memory(user_id)
        self.assertEqual(len(after_hold.trades), 1, "hold не записывает вторую сделку")

        # Response говорит, каким рядом считать приходилось: без этого нельзя
        # сверить решение агента с тем, что человек видит на графике.
        self.assertEqual(
            body.get("data", {}).get("candles_used"),
            5,
            "ответ обязан показывать окно, которое бэкенд реально взял из Lighter",
        )
        self.assertEqual(body["data"]["symbol"], "ETH")

        # Битый ряд от Lighter — 502, а не «hold» и не решение по нулям.
        import lighter_rest

        lighter_rest.get_candles = lambda mid, resolution="1h", count=24, network=None: [
            {"c": 0, "o": 0, "h": 0, "l": 0, "V": 0, "t": 0}
        ]
        r = await self.client.post("/agent/step", json=self.STEP, headers=user)
        self.assertEqual(r.status_code, 502, "по пустому или битому ряду не решают")
        self.assertEqual(r.json()["error"]["code"], "MARKET_DATA_UNUSABLE")

        # Рынка нет в книге — 404, а не ордер с угаданными decimals.
        r = await self.client.post(
            "/agent/step", json={**self.STEP, "market_id": 999}, headers=user
        )
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()["error"]["code"], "MARKET_NOT_FOUND")

        # Невалидный горизонт — 422 на границе, а не тихий 1m-ряд.
        r = await self.client.post(
            "/agent/step", json={**self.STEP, "resolution": "7m"}, headers=user
        )
        self.assertEqual(r.status_code, 422)

    async def test_upgrade_requires_curator(self):
        user = await self.sign_in_telegram(7002)

        r = await self.client.post("/subscription/tg_7002/upgrade")
        self.assertEqual(
            r.status_code, 403, "своего входа мало: платёжного процесса здесь нет"
        )

        # подписки ещё нет — апгрейд её не создаёт, точка входа в подписку одна
        r = await self.client.post(
            "/subscription/tg_7002/upgrade",
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        self.assertEqual(r.status_code, 404)

        await self.client.post("/subscription/trial", headers=user)
        trial = await agent_db.get_subscription("tg_7002")
        r = await self.client.post(
            "/subscription/tg_7002/upgrade",
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["tier"], "pro")

        # апгрейд меняет тир и не трогает часы подписки: переставленный
        # started_at сделал бы трёхлетнего клиента вчерашним, и в базе это
        # заметнее, чем в домене, — там строка живёт между апгрейдами
        after = await agent_db.get_subscription("tg_7002")
        self.assertEqual(after.tier, Tier.PRO)
        self.assertEqual(after.started_at, trial.started_at)
        self.assertEqual(after.trial_started_at, trial.trial_started_at)

        r = await self.client.get("/subscription", headers=user)
        self.assertEqual(r.json()["tier"], "pro")
        self.assertTrue(r.json()["has_ai_agent"])

    async def test_portfolio_risk(self):
        r = await self.client.post(
            "/portfolio/risk",
            json={
                "positions": [
                    {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1000},
                    {"market_id": 2, "symbol": "ETH", "signed_notional_usd": -500},
                ],
                "returns_by_market": {
                    "1": [0.01, -0.02, 0.015],
                    "2": [0.005, -0.01, 0.02],
                },
            },
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertLessEqual(
            body["portfolio_dollar_volatility"], body["naive_dollar_volatility"]
        )

        r = await self.client.post(
            "/portfolio/hedge",
            json={
                "target": {
                    "market_id": 1,
                    "symbol": "BTC",
                    "signed_notional_usd": 1000,
                },
                "candidates": [[2, "ETH"]],
                "returns_by_market": {
                    "1": [0.01, -0.02, 0.015],
                    "2": [0.005, -0.01, 0.02],
                },
            },
        )
        self.assertEqual(r.status_code, 200)

    async def test_portfolio_rejects_series_that_are_not_returns(self):
        """Порядок величины на входе — не косметика. Конечное 1e300 проходит
        проверку на NaN, а (x - mean) ** 2 на нём — OverflowError, то есть 500.
        Хуже тот же ряд на 1e154: там умножение даёт inf, variance = inf - inf =
        nan, а max(0.0, nan) в Python — 0.0, то есть панель отвечала «риск
        портфеля 0$» вместо отказа."""
        for series in ([1e300, -1e300], [1e154, 1e154, -1e154]):
            r = await self.client.post(
                "/portfolio/risk",
                json={
                    "positions": [
                        {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1e12},
                        {"market_id": 2, "symbol": "ETH", "signed_notional_usd": 1e12},
                    ],
                    "returns_by_market": {"1": series, "2": [0.01, -0.02, 0.03]},
                },
            )
            with self.subTest(max_value=max(abs(x) for x in series)):
                self.assertEqual(r.status_code, 422, r.text)
                self.assertEqual(r.json()["error"]["code"], "VALIDATION_ERROR")


class TestTelegramAuth(HttpCase):
    """Вход через Telegram — один из двух способов попасть в Wake (второй — кошелёк),
    поэтому проверяется и подпись, и запись в followers. Читается через репозиторий
    db.follower_by_l1: у Telegram-входа l1_address = "tg:<id>", тем же путём идёт и
    прод."""

    async def followers_row(self, telegram_id: int):
        return await db.follower_by_l1(f"tg:{telegram_id}")

    async def test_valid_signature_creates_follower(self):
        r = await self.client.post("/auth/telegram", json=telegram_login_payload())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["user_id"], "tg_4242")

        row = await self.followers_row(4242)
        self.assertIsNotNone(row)
        self.assertEqual(row["id"], "tg_4242")

    async def test_repeat_login_does_not_duplicate(self):
        first = await self.client.post(
            "/auth/telegram", json=telegram_login_payload(user_id=4243)
        )
        second = await self.client.post(
            "/auth/telegram", json=telegram_login_payload(user_id=4243)
        )
        self.assertEqual(first.json()["user_id"], second.json()["user_id"])
        self.assertEqual(
            (await self.followers_row(4243))["id"],
            "tg_4243",
            "повторный вход должен вести к той же записи, а не к второй",
        )

    async def test_tampered_signature_rejected(self):
        payload = telegram_login_payload(user_id=4244)
        payload["first_name"] = "Attacker"  # меняем поле, подпись остаётся от старого
        r = await self.client.post("/auth/telegram", json=payload)
        self.assertEqual(r.status_code, 401)
        self.assertIsNone(await self.followers_row(4244))

    async def test_stale_auth_date_rejected(self):
        payload = telegram_login_payload(
            user_id=4245, auth_date=int(time.time()) - 90000
        )
        r = await self.client.post("/auth/telegram", json=payload)
        self.assertEqual(
            r.status_code, 401, "старше суток — подписывать такой вход уже нельзя"
        )
        self.assertIsNone(await self.followers_row(4245))


class TestTelegramMiniApp(HttpCase):
    """Мини-апп открывается кнопкой из бота, и вход там идёт по initData, а не по
    виджету. Подпись проверяется на токене бота — то есть подделать её можно только
    зная этот токен, а не правкой ответа в браузере."""

    async def followers_row(self, telegram_id: int):
        return await db.follower_by_l1(f"tg:{telegram_id}")

    async def test_valid_init_data_creates_follower(self):
        r = await self.client.post(
            "/auth/telegram/init",
            json={"init_data": mini_app_init_data(user_id=4350)},
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["user_id"], "tg_4350")
        self.assertGreater(body["expires_at"], time.time())
        self.assertEqual((await self.followers_row(4350))["id"], "tg_4350")

        # выданный токен рабочий: имя пользователя ответ не отдаёт, а вот вход
        # с этого момента существует
        r = await self.client.get("/subscription", headers=auth(body["token"]))
        self.assertEqual(r.status_code, 200)

    async def test_widget_and_miniapp_login_share_one_follower(self):
        await self.client.post(
            "/auth/telegram", json=telegram_login_payload(user_id=4351)
        )
        r = await self.client.post(
            "/auth/telegram/init",
            json={"init_data": mini_app_init_data(user_id=4351)},
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["user_id"], "tg_4351")
        self.assertEqual(
            (await self.followers_row(4351))["id"],
            "tg_4351",
            "два входа одного человека не плодят два аккаунта",
        )

    async def test_foreign_token_signature_rejected(self):
        init_data = mini_app_init_data(user_id=4352, token="999999:not-our-bot-token")
        r = await self.client.post("/auth/telegram/init", json={"init_data": init_data})
        self.assertEqual(r.status_code, 401)
        self.assertIsNone(await self.followers_row(4352))

    async def test_tampered_user_field_rejected(self):
        # Подписанную строку пересобираем с чужим id, оставив старый hash: ровно то,
        # что делает правка initData в консоли браузера.
        from urllib.parse import parse_qsl

        pairs = dict(parse_qsl(mini_app_init_data(user_id=4353)))
        user = json.loads(pairs["user"])
        user["id"] = 1
        pairs["user"] = json.dumps(user, ensure_ascii=False)
        r = await self.client.post(
            "/auth/telegram/init", json={"init_data": urlencode(pairs)}
        )
        self.assertEqual(
            r.status_code, 401, "редакция initData в браузере не даёт вход"
        )
        self.assertIsNone(await self.followers_row(1))

    async def test_stale_init_data_rejected(self):
        init_data = mini_app_init_data(user_id=4354, auth_date=int(time.time()) - 90000)
        r = await self.client.post("/auth/telegram/init", json={"init_data": init_data})
        self.assertEqual(r.status_code, 401)
        self.assertIsNone(await self.followers_row(4354))

    async def test_empty_init_data_rejected(self):
        r = await self.client.post("/auth/telegram/init", json={"init_data": ""})
        self.assertEqual(r.status_code, 400)


class TestHardening(HttpCase):
    """Шаг «Security & Core» проверяется по факту ответа, а не по чтению кода:
    /ready обязан отличаться от /health, security-заголовки — стоять на каждом
    ответе, CORS — эхом только свои origin'ы, любая ошибка — в едином формате."""

    async def test_ready_checks_real_dependencies(self):
        r = await self.client.get("/ready")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "ready")
        # PostgreSQL настоящий: SELECT 1 действительно выполняется против базы.
        self.assertEqual(body["checks"]["database"], "ok")
        # NullRateLimiter.ping() подменяет Redis, но контракт ответа тот же.
        self.assertEqual(body["checks"]["redis"], "ok")

    async def test_security_headers_on_every_response(self):
        r = await self.client.get("/health")
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")
        self.assertEqual(r.headers["x-frame-options"], "DENY")
        self.assertEqual(
            r.headers["referrer-policy"], "strict-origin-when-cross-origin"
        )
        self.assertIn("default-src 'self'", r.headers["content-security-policy"])

    async def test_cors_echoes_allowed_origin_and_silences_foreign(self):
        r = await self.client.options(
            "/health",
            headers={
                "Origin": app.settings.cors_origins_list[0],
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertEqual(
            r.headers.get("access-control-allow-origin"),
            app.settings.cors_origins_list[0],
            "свой origin получает эхо и право на запрос",
        )

        r = await self.client.options(
            "/health",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "GET",
            },
        )
        self.assertNotIn(
            "access-control-allow-origin",
            r.headers,
            "чужой origin не получает разрешение",
        )

    async def test_validation_error_in_unified_format(self):
        r = await self.client.post("/auth/telegram", json={"id": "not-an-int"})
        self.assertEqual(r.status_code, 422)
        err = r.json()["error"]
        self.assertEqual(err["code"], "VALIDATION_ERROR")
        self.assertTrue(err["details"], "422 без details бесполезен для отладки")

    async def test_unknown_error_format_uses_status_phrase_code(self):
        """HTTPException со строковым detail (наш собственный код вне auth) тоже
        обязан попасть в единый формат: {error: {code, message}}, а не FastAPI
        дефолтный {"detail": ...}."""
        r = await self.client.post(
            "/predict/markets/price",
            json={
                "question": "BTC above 100k?",
                "lighter_market_id": 1,
                "threshold": 100000,
                "comparator": ">=",
                "resolve_at": 1999999999,
                "b": 100,
            },
            headers={"X-Curator-Token": "wrong"},
        )
        self.assertEqual(r.status_code, 403)
        err = r.json()["error"]
        self.assertTrue(err["code"])
        self.assertNotIn("detail", r.json())


class TestFailureResponseContract(HttpCase):
    """Отказ обязан долетать до клиента читаемым.

    Прежний порядок middleware (лимитер, добавленный последним, оказывался самым
    внешним) и обработчик Exception на ServerErrorMiddleware давали связный
    результат: 429, 500 и 400 на ValueError выходили БЕЗ access-control-allow-origin
    и без security-заголовков. Браузер такой ответ JavaScript не отдаёт вовсе, то
    есть страница вместо «притормози, Retry-After: 6» показывала «бэкенд лежит» —
    ровно в тот момент, когда бэкенд был жив и отвечал.

    Здесь проверяются и заголовки на каждом виде отказа, и сам порядок слоёв:
    порядок — это не стиль, а единственный механизм, который эти заголовки
    обеспечивает, и переставить его может любой новый middleware ниже."""

    def origin(self) -> str:
        return app.settings.cors_origins_list[0]

    async def test_middleware_stack_is_ordered_outermost_first(self):
        from starlette.middleware.base import BaseHTTPMiddleware
        from starlette.middleware.cors import CORSMiddleware

        stack = app.app.user_middleware
        self.assertIs(stack[0].cls, CORSMiddleware, "CORS обязан быть внешним")
        names = [
            m.kwargs["dispatch"].__name__
            if issubclass(m.cls, BaseHTTPMiddleware)
            else m.cls.__name__
            for m in stack
        ]
        self.assertEqual(
            names,
            [
                "CORSMiddleware",
                "security_headers_middleware",
                "error_envelope_middleware",
                "rate_limit_middleware",
            ],
            "порядок слоёв = порядок, в котором ответ идёт наружу через них",
        )

    async def test_rate_limited_response_is_browser_readable(self):
        class Denied:
            async def allow(self, key, cost=1.0):
                return False

            async def retry_after(self, key, cost=1.0):
                return 5.0

            async def ping(self):
                return True

            async def close(self):
                pass

        original = app._rate_limiter
        app._rate_limiter = Denied()
        try:
            r = await self.client.get(
                "/predict/markets", headers={"Origin": self.origin()}
            )
        finally:
            app._rate_limiter = original
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["error"]["code"], "RATE_LIMITED")
        self.assertEqual(r.headers.get("access-control-allow-origin"), self.origin())
        self.assertEqual(r.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(r.headers["retry-after"], "6")
        self.assertIn(
            "retry-after",
            r.headers.get("access-control-expose-headers", "").lower(),
            "без expose фронт видит 429, но не видит, сколько ждать",
        )

    async def test_internal_error_carries_headers_and_stays_in_one_format(self):
        import lighter_rest

        original = lighter_rest.get_market_overview
        lighter_rest.get_market_overview = lambda *a, **k: (_ for _ in ()).throw(
            ZeroDivisionError("деление на ноль в статистике рынка")
        )
        self.addCleanup(setattr, lighter_rest, "get_market_overview", original)
        r = await self.client.get(
            "/markets/overview", headers={"Origin": self.origin()}
        )
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["error"]["code"], "INTERNAL_ERROR")
        self.assertEqual(r.headers.get("access-control-allow-origin"), self.origin())
        self.assertEqual(r.headers.get("x-content-type-options"), "nosniff")
        self.assertIn("default-src 'self'", r.headers["content-security-policy"])

    async def test_value_error_response_is_signed_too(self):
        """400 на ValueError — тоже ответ, собранный вне роута, и он обязан нести
        те же заголовки: фронт читает error.code, а без ACAO он читает не его, а
        «Failed to fetch»."""
        import lighter_rest

        original = lighter_rest.get_market_overview
        lighter_rest.get_market_overview = lambda *a, **k: (_ for _ in ()).throw(
            ValueError("неизвестная сеть Lighter")
        )
        self.addCleanup(setattr, lighter_rest, "get_market_overview", original)
        r = await self.client.get(
            "/markets/overview", headers={"Origin": self.origin()}
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], "VALIDATION_ERROR")
        self.assertEqual(r.headers.get("access-control-allow-origin"), self.origin())
        self.assertEqual(r.headers.get("x-content-type-options"), "nosniff")


class TestAuditRead(HttpCase):
    """Аудит до этого только писали: две функции-читателя в audit_log не
    вызывались ни откуда, а docs/RAILWAY_DEPLOY.md советовал оператору «посмотрите
    поле ip в строке sign_in» — совет, невыполнимый без доступа к базе.

    GET /audit закрыт токеном куратора: это чужие входы и чужие сделки, и
    выдавать их по токену сессии значит показать подписчику историю авторизаций
    соседа."""

    CURATOR = {"X-Curator-Token": testsupport.CURATOR_TOKEN}

    async def test_requires_curator_token(self):
        r = await self.client.get("/audit")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "CURATOR_TOKEN_INVALID")

    async def test_returns_newest_first_with_decoded_details(self):
        await al.log_action(
            al.AuditEntry(
                actor="tg_777001",
                action="sign_in",
                resource="follower:tg_777001",
                details={"via": "widget", "ip": "203.0.113.9"},
            )
        )
        await al.log_action(
            al.AuditEntry(
                actor="tg_777001",
                action="key_access",
                resource="follower:tg_777001",
                success=False,
                details={"reason": "wrong_key"},
            )
        )
        r = await self.client.get(
            "/audit", params={"actor": "tg_777001"}, headers=self.CURATOR
        )
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["ceiling"], al.MAX_ROWS)
        self.assertEqual(
            [row["action"] for row in body["rows"]], ["key_access", "sign_in"]
        )
        first = body["rows"][0]
        self.assertEqual(
            first["details"],
            {"reason": "wrong_key"},
            "details наружу — объект, а не строка внутри JSON",
        )
        self.assertEqual(first["success"], 0, "неудача различима без второго запроса")

    async def test_failed_only_filter_and_window(self):
        await al.log_action(
            al.AuditEntry(actor="tg_777002", action="sign_in", success=False)
        )
        await al.log_action(al.AuditEntry(actor="tg_777002", action="sign_in"))
        failed = (
            await self.client.get(
                "/audit",
                params={"actor": "tg_777002", "failed_only": "true"},
                headers=self.CURATOR,
            )
        ).json()["rows"]
        self.assertEqual([row["success"] for row in failed], [0])
        future = (
            await self.client.get(
                "/audit",
                params={"actor": "tg_777002", "since": time.time() + 3600},
                headers=self.CURATOR,
            )
        ).json()["rows"]
        self.assertEqual(future, [], "окно в будущем не должно ничего находить")

    async def test_limit_cannot_ask_for_the_whole_table(self):
        """Потолок на роуте, а не только в слое: limit=10**6 означал бы
        выгрузку всей таблицы в память процесса на один запрос."""
        r = await self.client.get(
            "/audit", params={"limit": 10**6}, headers=self.CURATOR
        )
        self.assertEqual(r.status_code, 422)
        self.assertEqual(r.json()["error"]["code"], "VALIDATION_ERROR")


class TestSessionGuards(HttpCase):
    """«Кто этот человек» решает токен, а не запрос, поэтому сюда попадает и всё,
    что на токен не похоже: пусто, мусор, подделанная подпись, истёкший срок."""

    PRIVATE_GETS = [
        "/follows",
        "/mirror-log",
        "/subscription",
        "/agent/memory",
        "/predict/positions",
    ]

    async def test_private_reads_refuse_everything_but_a_session(self):
        for path in self.PRIVATE_GETS:
            r = await self.client.get(path)
            self.assertEqual(r.status_code, 401, path)
            self.assertEqual(r.json()["error"]["code"], "SESSION_REQUIRED", path)

        r = await self.client.get("/subscription", headers={"Authorization": "Bearer "})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "SESSION_REQUIRED")

        for token, code in [
            ("not-a-token", "SESSION_MALFORMED"),
            ("wk1.abc.def", "SESSION_BAD_SIGNATURE"),
            (forged_token("tg_6001"), "SESSION_BAD_SIGNATURE"),
        ]:
            r = await self.client.get("/subscription", headers=auth(token))
            self.assertEqual(r.status_code, 401, token)
            self.assertEqual(r.json()["error"]["code"], code, token)

        stale, _ = session.issue("tg_6001", now=time.time() - session.SESSION_TTL_S - 1)
        r = await self.client.get("/subscription", headers=auth(stale))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(
            r.json()["error"]["code"],
            "SESSION_EXPIRED",
            "просроченный токен — не «подделка»: клиенту нужно перелогиниться",
        )

    async def test_public_showcase_stays_open(self):
        """Discover и список рынков читаются без входа: гейтить витрину — значит
        гнать прочитавших её людей от того, что им показывать нельзя."""
        for path in ("/leaders", "/predict/markets", "/health"):
            self.assertEqual((await self.client.get(path)).status_code, 200, path)
        r = await self.client.get(f"/follows/by-leader/{uuid.uuid4()}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            r.json(),
            {"follower_count": 0, "total_aum_usd": 0},
            "агрегат — весь ответ: поштучных подписок публичный роут не отдаёт",
        )

    async def test_follow_requires_a_linked_lighter_account(self):
        """Вход через Telegram подтверждает личность, но не даёт адреса Lighter, на
        который копировать. Строка follows без индекса аккаунта не может ни
        зазеркалиться, ни отчитаться: листенер доходит до `no_key`, а человек
        видит «подписка записана» и считает, что копирует лидера."""
        headers = await self.sign_in_telegram(5002)
        leader_headers, _ = await self.sign_in_wallet(780)
        r = await self.client.post(
            "/leaders",
            json={"handle": "@needlink", "fee_bps": 8},
            headers=leader_headers,
        )
        leader_id = r.json()["leader_id"]
        r = await self.client.post(
            "/follows",
            json={"leader_id": leader_id, "allocation_usd": 250},
            headers=headers,
        )
        self.assertEqual(r.status_code, 403, r.text)
        self.assertEqual(r.json()["error"]["code"], "LIGHTER_ACCOUNT_NOT_LINKED")
        self.assertEqual(
            (await self.client.get(f"/follows/by-leader/{leader_id}")).json()[
                "follower_count"
            ],
            0,
            "отклонённая подписка не должна была успеть попасть в AUM",
        )

    async def test_mirror_log_shows_only_your_own(self):
        """Журнал зеркалирования — чужие размеры и чужие аллокации; раньше его
        можно было прочитать, подставив в query чужой follower_id."""
        leader_headers, _ = await self.sign_in_wallet(601)
        r = await self.client.post(
            "/leaders", json={"handle": "@lg", "fee_bps": 8}, headers=leader_headers
        )
        leader_id = r.json()["leader_id"]

        a, _ = await self.sign_in_wallet(801)
        b, _ = await self.sign_in_wallet(802)
        follows = {}
        for name, headers in (("a", a), ("b", b)):
            r = await self.client.post(
                "/follows",
                json={"leader_id": leader_id, "allocation_usd": 100},
                headers=headers,
            )
            follows[name] = r.json()["follow_id"]

        await db.log_mirror_result(
            "log-a", follows["a"], 1, "long", 0.1, False, "dry_run"
        )
        await db.log_mirror_result(
            "log-b", follows["b"], 1, "long", 0.2, False, "dry_run"
        )

        rows_a = (await self.client.get("/mirror-log", headers=a)).json()
        self.assertEqual([x["id"] for x in rows_a], ["log-a"])
        self.assertEqual(rows_a[0]["leader_handle"], "@lg")

        rows_b = (await self.client.get("/mirror-log", headers=b)).json()
        self.assertEqual([x["id"] for x in rows_b], ["log-b"])


class TestWalletSignIn(HttpCase):
    """Вход кошельком проверяется криптографией прода: подпись восстанавливается
    в адрес эталонной библиотекой, challenge одноразовый. Подменяются только Redis
    и ответ Lighter про индекс аккаунта."""

    async def verify(self, message: str, signature: str):
        return await self.client.post(
            "/auth/wallet/verify", json={"message": message, "signature": signature}
        )

    async def test_replay_is_rejected(self):
        from eth_account import Account

        account = Account.create()
        message = await self.wallet_challenge(account.address)
        signature = sign_challenge(message, account.key)

        r = await self.verify(message, signature)
        self.assertEqual(r.status_code, 200, r.text)

        # перехваченная пара (message, signature) не даёт второй вход: GETDEL
        r2 = await self.verify(message, signature)
        self.assertEqual(r2.status_code, 401)
        self.assertEqual(r2.json()["error"]["code"], "CHALLENGE_STALE")

    async def test_wrong_signer_rejected(self):
        from eth_account import Account

        owner = Account.create()
        attacker = Account.create()
        message = await self.wallet_challenge(owner.address)
        signature = sign_challenge(message, attacker.key)

        r = await self.verify(message, signature)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "ADDRESS_MISMATCH")

        # отказ входа тоже аудится: «кто пытался войти не своим ключом» — ровно
        # то, что стоит увидеть постфактум
        rows = [
            row
            for row in await al.recent_actions(actor="wallet", action="sign_in")
            if row["success"] == 0
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0]["details"])["reason"], "ADDRESS_MISMATCH")

    async def test_tampered_message_rejected(self):
        """Текст подписи проверяется со хранимым: переписать в нём что угодно —
        адрес, срок или название приложения — значит получить отказ, а не вход."""
        from eth_account import Account

        account = Account.create()
        message = await self.wallet_challenge(account.address)
        signature = sign_challenge(message, account.key)

        r = await self.verify(
            message.replace("Wake sign-in", "Other sign-in"), signature
        )
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "CHALLENGE_MISMATCH")

        r = await self.verify("просто текст без nonce", signature)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "CHALLENGE_UNKNOWN")

    async def test_garbage_signature_rejected(self):
        from eth_account import Account

        account = Account.create()
        message = await self.wallet_challenge(account.address)
        # подпись длиной 2 байта — не подпись: eth_account падает на длине, и
        # отказ обязан называть причину, а не превращаться в 500
        r = await self.verify(message, "0x1234")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["error"]["code"], "BAD_SIGNATURE")

    async def test_address_normalized_to_checksum(self):
        """Один и тот же кошелёк в разных регистрах — одна запись: адрес является
        первичным ключом подписчика."""
        from eth_account import Account

        account = Account.create()
        message = await self.wallet_challenge(account.address.lower())
        self.assertIn(f"address: {account.address}\n", message)
        signature = sign_challenge(message, account.key)

        r = await self.verify(message, signature)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["user_id"], account.address)

        self.assertIsNotNone(await db.follower_by_l1(account.address))

    async def test_invalid_address_is_400(self):
        self.patch_wallet_infra()
        r = await self.client.post(
            "/auth/wallet/challenge", json={"l1_address": "не-адрес"}
        )
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["code"], "INVALID_ADDRESS")

    async def test_dead_store_is_503_not_signed_in(self):
        """Без Redis подтверждать подпись нечем, и «проверим на веру» — не вариант:
        вход отвечает 503, а не выдаёт токен."""
        import redis.asyncio as aioredis
        import wallet_auth

        class DeadStore:
            async def set(self, *a, **kw):
                raise aioredis.RedisError("Redis unavailable")

        self.patch_wallet_infra()
        wallet_auth._client = DeadStore()
        r = await self.client.post(
            "/auth/wallet/challenge", json={"l1_address": "0x" + "11" * 20}
        )
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "CHALLENGE_STORE_UNAVAILABLE")

    async def test_corrupted_record_is_503_not_clients_fault(self):
        """Ключ `wake:wallet:*` пишет только сам Wake, поэтому битая запись в
        Redis — повреждение хранилища, а не кривой запрос. Разбирать его нечем:
        ответ 503 и ERROR в логе, а не 400, который валит инцидент на клиента и
        в аудите выглядит как неудачная попытка входа."""
        import wallet_auth
        from eth_account import Account

        account = Account.create()
        message = await self.wallet_challenge(account.address)
        key = f"{wallet_auth._KEY}{wallet_auth._nonce_of(message)}"
        store = wallet_auth._store()

        for raw in (
            '"не JSON',
            '["список вместо объекта"]',
            "{}",
            '{"address": 1, "message": "m", "exp": 2}',
            '{"address": "0xabc", "exp": 2}',
            '{"address": "0xabc", "message": "m", "exp": "через час"}',
        ):
            with self.subTest(record=raw[:28]):
                await store.set(key, raw)
                r = await self.verify(message, "0x1234")
                self.assertEqual(r.status_code, 503, r.text)
                self.assertEqual(r.json()["error"]["code"], "CHALLENGE_STORE_CORRUPTED")

    async def test_lighter_down_signs_in_without_account_index(self):
        """Индекс аккаунта — данные Lighter, а не условие входа: без него человек
        пользуется терминалом, но лидера не публикует."""
        from eth_account import Account

        self.patch_wallet_infra()

        def down(address, network=None):
            raise RuntimeError("Lighter API недоступен")

        api_auth.get_account_index_by_l1 = down

        account = Account.create()
        message = await self.wallet_challenge(account.address)
        signature = sign_challenge(message, account.key)
        r = await self.verify(message, signature)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIsNone(r.json()["lighter_account_index"])

        headers = auth(r.json()["token"])
        r = await self.client.post(
            "/leaders", json={"handle": "@no-index"}, headers=headers
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "LIGHTER_ACCOUNT_NOT_LINKED")


class TestRateLimitBucket(HttpCase):
    """Ведро лимитера обязано считаться по человеку. За Railway/Cloudflare адрес
    соединения — адрес прокси, и ключ по IP означал бы один лимит на весь сервис:
    один активный клиент закритыл бы всех остальных."""

    class Recorder:
        def __init__(self):
            self.calls = []

        async def allow(self, key, cost=1.0):
            self.calls.append((key, cost))
            return True

        async def retry_after(self, key, cost=1.0):
            return 0.0

        async def ping(self):
            return True

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.recorder = self.Recorder()
        original = app._rate_limiter
        app._rate_limiter = self.recorder
        self.addCleanup(setattr, app, "_rate_limiter", original)

    @property
    def last(self):
        return self.recorder.calls[-1]

    async def test_session_decides_the_bucket(self):
        import net

        headers = await self.sign_in_telegram(9101)
        r = await self.client.get("/follows", headers=headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.last, ("user:tg_9101", 1.0))

        r = await self.client.post("/subscription/trial", headers=headers)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(
            self.last,
            ("user:tg_9101", app._WRITE_COST),
            "запись списывает несколько токенов: она трогает базу и Lighter",
        )

        # без токена и с подделкой — общий bucket по IP соединения: чужой токен
        # не должен давать чужое ведро
        peer = self.recorder.calls[0][0].split(":", 1)[1]
        for hdrs in ({}, auth(forged_token())):
            await self.client.get("/follows", headers=hdrs)
            self.assertEqual(self.last[0], f"ip:{peer}")

        # X-Forwarded-For без доверенного прокси — просто строка от клиента
        await self.client.get(
            "/follows", headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"}
        )
        self.assertEqual(self.last[0], f"ip:{peer}")

        # с доверенным прокси берётся правый адрес: его дописал тот, кто видел
        # соединение, всё левее клиент подставил сам
        original = net.TRUSTED_PROXY_IPS
        net.TRUSTED_PROXY_IPS = {peer}
        try:
            await self.client.get(
                "/follows", headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"}
            )
            self.assertEqual(self.last[0], "ip:5.6.7.8")
            await self.client.get("/follows", headers=headers)
            self.assertEqual(self.last[0], "user:tg_9101")
        finally:
            net.TRUSTED_PROXY_IPS = original


class TestPredictMarketBoundary(HttpCase):
    """Граница создания рынков предсказаний.

    JSON умеет переносить NaN и Infinity (это не валидный по RFC 7159 ответ
    браузера, но curl и любой Python-клиент — да), а Starlette сериализует
    ответ с allow_nan=False. Поэтому пропущенное внутрь NaN стоит не «пустую
    карточку рынка», а 500 на публичный GET /predict/markets для всех сразу."""

    CURATOR_JSON = {
        "X-Curator-Token": testsupport.CURATOR_TOKEN,
        "Content-Type": "application/json",
    }

    async def create(self, body: str):
        return await self.client.post(
            "/predict/markets/price", content=body.encode(), headers=self.CURATOR_JSON
        )

    async def test_public_list_survives_a_rejected_market(self):
        r = await self.create(
            '{"question":"BTC above 100k?","lighter_market_id":1,"threshold": NaN,'
            '"comparator":">=","resolve_at":1999999999,"b":100}'
        )
        self.assertEqual(r.status_code, 422, r.text[:200])
        r = await self.create(
            '{"question":"BTC above 100k?","lighter_market_id":1,"threshold":100000,'
            '"comparator":">=","resolve_at": NaN,"b":100}'
        )
        self.assertEqual(r.status_code, 422)
        r = await self.create(
            '{"question":"BTC above 100k?","lighter_market_id":1,"threshold":100000,'
            '"comparator":">=","resolve_at":1999999999,"b": Infinity}'
        )
        self.assertEqual(r.status_code, 422)

        r = await self.client.get("/predict/markets")
        self.assertEqual(r.status_code, 200, "список не должен падать из-за отказа")
        self.assertEqual(r.json(), [])

    async def test_valid_market_still_creates_and_lists(self):
        r = await self.create(
            '{"question":"BTC above 100k?","lighter_market_id":1,"threshold":100000,'
            '"comparator":">=","resolve_at":1999999999,"b":100}'
        )
        self.assertEqual(r.status_code, 200, r.text[:200])
        rows = (await self.client.get("/predict/markets")).json()
        self.assertEqual(len(rows), 1)
        self.assertTrue(math.isfinite(rows[0]["price_yes"]))
        self.assertAlmostEqual(rows[0]["price_yes"] + rows[0]["price_no"], 1.0)

    async def test_out_of_range_numbers_are_refused(self):
        for body in (
            # дедлайн в прошлом и слишком далеко
            '{"question":"q?","lighter_market_id":1,"threshold":100000,"comparator":">=","resolve_at":1000000000,"b":100}',
            '{"question":"q?","lighter_market_id":1,"threshold":100000,"comparator":">=","resolve_at":999999999999,"b":100}',
            # порог цены обязан быть положительным
            '{"question":"q?","lighter_market_id":1,"threshold":0,"comparator":">=","resolve_at":1999999999,"b":100}',
            '{"question":"q?","lighter_market_id":1,"threshold":-5,"comparator":">=","resolve_at":1999999999,"b":100}',
            # Infinity проходит проверку `gt=0` (он больше нуля), поэтому у
            # threshold нужен именно allow_inf_nan=False: без него рынок
            # создаётся, а публичный список после этого падает на сериализации
            '{"question":"q?","lighter_market_id":1,"threshold": Infinity,"comparator":">=","resolve_at":1999999999,"b":100}',
            '{"question":"q?","lighter_market_id":1,"threshold": NaN,"comparator":">=","resolve_at":1999999999,"b":100}',
            '{"question":"q?","lighter_market_id":1,"threshold":100,"comparator":">=","resolve_at":1999999999,"b": Infinity}',
            # индекс книги Lighter не бывает отрицательным
            '{"question":"q?","lighter_market_id":-7,"threshold":100,"comparator":">=","resolve_at":1999999999,"b":100}',
            # ликвидность без потолка = резерв маркетмейкера без потолка
            '{"question":"q?","lighter_market_id":1,"threshold":100,"comparator":">=","resolve_at":1999999999,"b":1e30}',
            # вопрос обязано можно прочитать в карточке
            '{"question":"","lighter_market_id":1,"threshold":100,"comparator":">=","resolve_at":1999999999,"b":100}',
            '{"question":"'
            + "д" * 400
            + '","lighter_market_id":1,"threshold":100,"comparator":">=","resolve_at":1999999999,"b":100}',
            # сторона не из списка
            '{"question":"q?","lighter_market_id":1,"threshold":100,"comparator":"=>","resolve_at":1999999999,"b":100}',
        ):
            with self.subTest(body=body[:60]):
                r = await self.create(body)
                self.assertEqual(r.status_code, 422, r.text[:120])
        r = await self.client.get("/predict/markets")
        self.assertEqual(r.json(), [])

    async def test_event_market_shares_the_same_boundary(self):
        r = await self.client.post(
            "/predict/markets/event",
            content=b'{"question":"Who wins?","resolve_at": Infinity,"b":100}',
            headers={
                "X-Curator-Token": testsupport.CURATOR_TOKEN,
                "Content-Type": "application/json",
            },
        )
        self.assertEqual(r.status_code, 422, r.text[:200])
        r = await self.client.post(
            "/predict/markets/event",
            json={"question": "", "resolve_at": 1999999999, "b": 100},
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        self.assertEqual(r.status_code, 422, "пустой вопрос — не рынок")

    async def test_claim_on_open_market_is_audited_as_refusal(self):
        """Claim по нерезолвленному рынку — отказ, и в аудит он обязан лечь
        отказом. Успех помечается фактом исполнения, а не суммой выплаты,
        поэтому success=0 остаётся единственным знаком «что-то не получилось» и
        GET /audit?failed_only читается."""
        trader = await self.sign_in_telegram(6102)
        r = await self.create(
            '{"question":"BTC above 100k?","lighter_market_id":1,"threshold":100000,'
            '"comparator":">=","resolve_at":1999999999,"b":100}'
        )
        market_id = r.json()["market_id"]

        r = await self.client.post(
            f"/predict/markets/{market_id}/claim", headers=trader
        )
        self.assertEqual(r.status_code, 400, r.text)

        rows = [
            row
            for row in await al.recent_actions(action="predict_claim")
            if row["resource"] == market_id
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["success"], 0)
        self.assertEqual(rows[0]["actor"], "tg_6102")
        self.assertIn("не резолвлен", json.loads(rows[0]["details"])["error"])

    async def test_trade_shares_are_bounded(self):
        trader = await self.sign_in_telegram(6101)
        r = await self.client.post(
            "/predict/markets/price",
            json={
                "question": "BTC above 100k?",
                "lighter_market_id": 1,
                "threshold": 100000,
                "comparator": ">=",
                "resolve_at": 1999999999,
                "b": 100,
            },
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        market_id = r.json()["market_id"]
        for shares in ("NaN", "Infinity", "1e30", "-1e30", "0"):
            with self.subTest(shares=shares):
                r = await self.client.post(
                    f"/predict/markets/{market_id}/trade",
                    content=f'{{"outcome":"yes","shares":{shares}}}'.encode(),
                    headers={**trader, "Content-Type": "application/json"},
                )
                self.assertEqual(r.status_code, 422)
        r = await self.client.get(
            f"/predict/markets/{market_id}/preview",
            params={"outcome": "yes", "shares": "NaN"},
        )
        self.assertEqual(r.status_code, 400, "preview считает цену тем же правилом")

    async def test_nan_in_any_float_field_answers_422_not_500(self):
        """Общий случай, не только Predict: поле с allow_inf_nan=False отдаёт
        ошибку валидации, в `input` которой лежит тот самый NaN. До санитизации
        такой ответ не сериализовался, и отказ выглядел как 500."""
        r = await self.client.post(
            "/predict/markets/event",
            content=b'{"question":"Who wins?","resolve_at": NaN,"b":100}',
            headers={
                "X-Curator-Token": testsupport.CURATOR_TOKEN,
                "Content-Type": "application/json",
            },
        )
        self.assertEqual(r.status_code, 422, r.text[:200])
        body = r.json()
        self.assertEqual(body["error"]["code"], "VALIDATION_ERROR")
        detail = body["error"]["details"][0]
        self.assertEqual(detail["loc"][-1], "resolve_at")
        self.assertEqual(detail["input"], "nan", "NaN в ответе — строка, не float")

    async def test_broken_comparator_row_is_409_not_500(self):
        """Создать рынок с другим условием Literal не даёт, поэтому строка с
        битым comparator — это прямая правка в базе. Резолюция обязана ответить
        409, а не ValueError наружу."""
        import lighter_rest
        from sqlalchemy import text as sa_text
        from database import async_session_factory

        r = await self.client.post(
            "/predict/markets/price",
            json={
                "question": "BTC above 100k?",
                "lighter_market_id": 1,
                "threshold": 100000,
                "comparator": ">=",
                "resolve_at": 1999999999,
                "b": 100,
            },
            headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
        )
        market_id = r.json()["market_id"]
        async with async_session_factory() as session:
            await session.execute(
                sa_text(
                    "UPDATE predict_markets SET comparator = '=>', "
                    "resolve_at = now() - interval '1 hour' WHERE id = :id"
                ),
                {"id": market_id},
            )
            await session.commit()

        original = lighter_rest.get_price_at
        lighter_rest.get_price_at = lambda mid, when, network: 120_000.0
        try:
            r = await self.client.post(
                f"/predict/markets/{market_id}/resolve-price",
                json={},
                headers={"X-Curator-Token": testsupport.CURATOR_TOKEN},
            )
        finally:
            lighter_rest.get_price_at = original
        self.assertEqual(r.status_code, 409, r.text[:200])
        self.assertIn("=>", r.json()["error"]["message"])


class TestShutdown(HttpCase):
    """Что закрывается на остановке процесса.

    Клиент Redis — живое соединение, и незакрытое оно висит на сервере до своего
    таймаута, а рестарт на Railway происходит на каждом деплое. Главное в этом
    тесте не список закрытий, а порядок отказов: пока два вызова стояли в одну
    линию без try, Redis с протухшим соединением бросал из lifespan и утаскивал за
    собой dispose пула PostgreSQL."""

    async def test_every_client_closes_even_if_one_raises(self):
        import database
        import wallet_auth

        closed = []

        class Recorder:
            """Двойник сразу в двух формах: у лимитера закрытие — метод close(),
            у клиента Redis — aclose(), который дёргает wallet_auth.close()."""

            def __init__(self, name, raises=False):
                self.name, self.raises = name, raises

            async def _run(self):
                if self.raises:
                    raise RuntimeError("соединение протухло")
                closed.append(self.name)

            async def close(self):
                await self._run()

            async def aclose(self):
                await self._run()

        async def record_db():
            closed.append("database")

        self.addCleanup(setattr, app, "_rate_limiter", app._rate_limiter)
        self.addCleanup(setattr, wallet_auth, "_client", wallet_auth._client)
        self.addCleanup(setattr, database, "close_db", database.close_db)
        app._rate_limiter = Recorder("rate limiter", raises=True)
        wallet_auth._client = Recorder("wallet_auth")
        database.close_db = record_db

        with self.assertLogs("wake.app", level="WARNING") as logs:
            async with app.lifespan(app.app):
                pass

        # отказ первого закрытия не отменил двух последующих
        self.assertEqual(closed, ["wallet_auth", "database"])
        self.assertIn("rate limiter", "\n".join(logs.output), "отказ не проглочен")


if __name__ == "__main__":
    unittest.main(verbosity=2)
