"""
Проверка сервиса подписи.

Повод появиться: `/place-order` зовёт браузер напрямую, мимо основного бэкенда,
а ключ подписи лежит в этом процессе. Значит, «сухой ход» обязан решаться здесь:
иначе WAKE_DRY_RUN=false у бэкенда — или просто прямая кнопка в Терминале —
отправляли бы живой ордер в mainnet, пока весь остальной проект считает, что
ничего не отправляется.

Форму fake-клиента задаёт не фантазия, а вызов из place_order(): create_order
принимаёт именованные аргументы и возвращает (tx, tx_hash, err), клиент
закрывается в finally.
"""

import asyncio
import os
import unittest
from unittest import mock

import httpx

import signing_service

_ORDER = {
    "market_index": 1,
    "client_order_index": 777,
    "base_amount": 10_000_000,
    "price": 60_000_00000,
    "is_ask": False,
    "reduce_only": False,
}

# Хост обязано принимать разрешённое значение, иначе тест проверял бы отказ
# гейта вместо работы маршрута. 127.0.0.1 — из списка по умолчанию.
_LOCAL = "http://127.0.0.1:8787"


class FakeSigner:
    ORDER_TYPE_MARKET = "market"
    ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL = "ioc"
    DEFAULT_IOC_EXPIRY = 1_800_000_000

    def __init__(self, tx_hash="0x" + "ab" * 32, err=None, delay=0.0):
        self.calls = []
        self.closed = 0
        self._tx_hash = tx_hash
        self._err = err
        # Окно гонки: идемпотентность проверяется на await, и без задержки два
        # запроса могли бы разойтись по кругу событий сами, не трогая баг.
        self._delay = delay

    async def create_order(self, **kwargs):
        self.calls.append(kwargs)
        if self._delay:
            await asyncio.sleep(self._delay)
        return {"market_index": kwargs["market_index"]}, self._tx_hash, self._err

    async def close(self):
        self.closed += 1


class TestIdempotencyCacheBounded(unittest.TestCase):
    """Кэш помнит ровно час — и это должно значить, что записи уходит, а не только
    что просроченная не даёт ложного «уже отправлено».

    До этой правки словарь только читался по TTL: ни одна ветка кода его не
    сокращала, то есть процесс с долгой историей ордеров рос по памяти без потолка.
    """

    def setUp(self):
        signing_service._idempotency_cache.clear()
        self.addCleanup(signing_service._idempotency_cache.clear)

    def test_expired_entries_are_dropped_on_write(self):
        now = 1_000_000.0
        signing_service._idempotency_cache[1] = (
            "0xold",
            now - signing_service._IDEMPOTENCY_TTL - 1,
        )
        signing_service._remember(2, "0xnew", now)
        self.assertNotIn(
            1, signing_service._idempotency_cache, "протухшая запись должна уйти"
        )
        self.assertIn(2, signing_service._idempotency_cache)

    def test_fresh_entries_survive(self):
        now = 1_000_000.0
        signing_service._remember(1, "0xa", now)
        signing_service._remember(2, "0xb", now + 1)
        self.assertEqual(set(signing_service._idempotency_cache), {1, 2})

    def test_cache_never_grows_past_the_cap(self):
        now = 1_000_000.0
        for i in range(signing_service._IDEMPOTENCY_MAX_ENTRIES + 400):
            signing_service._remember(i, f"0x{i}", now)
        self.assertLessEqual(
            len(signing_service._idempotency_cache),
            signing_service._IDEMPOTENCY_MAX_ENTRIES,
        )


class TestSigningService(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Кэш идемпотентности — состояние модуля: без очистки индексы из одного
        # теста делали бы второй «повтором», и тест проверял бы мусор предыдущего.
        signing_service._idempotency_cache.clear()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=signing_service.app),
            base_url=_LOCAL,
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        signing_service._idempotency_cache.clear()

    async def _place(self, order=None):
        # `order or _ORDER` подменил бы пустой dict валидным телом — а пустое тело
        # как раз и проверяется, поэтому сравнение с None.
        return await self.client.post(
            "/place-order", json=_ORDER if order is None else order
        )

    async def test_dry_run_never_reaches_lighter(self):
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._place()
        body = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(body["dry_run"])
        self.assertIsNone(body["tx_hash"])
        self.assertEqual(signer.calls, [])
        self.assertEqual(signer.closed, 0)

    async def test_dry_run_echoes_the_plan_that_would_be_sent(self):
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client"),
        ):
            body = (await self._place()).json()
        self.assertEqual(body["order"], _ORDER)

    async def test_live_path_signs_and_returns_tx_hash(self):
        signer = FakeSigner(tx_hash="0xdeadbeef")
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            body = (await self._place()).json()
        self.assertFalse(body["dry_run"])
        self.assertEqual(body["tx_hash"], "0xdeadbeef")
        self.assertFalse(body["idempotent_replay"])
        call = signer.calls[0]
        self.assertEqual(call["market_index"], _ORDER["market_index"])
        self.assertEqual(call["base_amount"], _ORDER["base_amount"])
        self.assertEqual(call["price"], _ORDER["price"])
        self.assertEqual(call["order_type"], FakeSigner.ORDER_TYPE_MARKET)
        self.assertEqual(
            call["time_in_force"], FakeSigner.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
        )
        self.assertEqual(call["order_expiry"], FakeSigner.DEFAULT_IOC_EXPIRY)
        self.assertTrue(call["reduce_only"] is False)
        self.assertEqual(signer.closed, 1)

    async def test_same_client_order_index_is_not_sent_twice(self):
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            first = (await self._place()).json()
            second = (await self._place()).json()
        self.assertFalse(first["idempotent_replay"])
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(second["tx_hash"], first["tx_hash"])
        self.assertEqual(len(signer.calls), 1)

    async def test_lighter_rejection_is_reported_and_client_closed(self):
        signer = FakeSigner(err="market index out of range")
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._place()
        self.assertEqual(r.status_code, 400)
        # Формат ошибок один на весь проект: под {"detail": ...} Терминал печатал
        # в тосте голый JSON, и человек читал его как ответ биржи.
        self.assertIn("Lighter отклонил ордер", r.json()["error"]["message"])
        self.assertEqual(r.json()["error"]["code"], "SIGNING_ERROR")
        # Ключ утечки сокетов здесь нет: close() стоит в finally, и проверка это
        # фиксирует — без неё ошибка Lighter оставляла бы соединение живым.
        self.assertEqual(signer.closed, 1)

    async def test_concurrent_same_index_sends_exactly_one_order(self):
        """Идемпотентность обязана держаться под гонкой, а не только по очереди.

        Проверка кэса и запись разделены await на create_order, поэтому два
        запроса с одним client_order_index, пришедшие вместе, оба видели пустой
        кэш и оба уходили в Lighter. Задержка fake-клиента открывает это окно:
        без неё очередь событий расходит запросы сама, и тест был бы зелёным и
        до правки, и после."""
        signer = FakeSigner(tx_hash="0xrace", delay=0.02)
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            first, second = await asyncio.gather(self._place(), self._place())

        self.assertEqual(len(signer.calls), 1, "второй боевой ордер с тем же индексом")
        bodies = [first.json(), second.json()]
        self.assertEqual(sorted(b["idempotent_replay"] for b in bodies), [False, True])
        self.assertTrue(all(b["tx_hash"] == "0xrace" for b in bodies))

    async def test_missing_key_fails_as_bad_configuration_not_as_success(self):
        # Реальный _get_client, а не заглушка: отсутствие LIGHTER_ACCOUNT_INDEX /
        # LIGHTER_API_KEY_PRIVATE_KEY в окружении должно быть видно по ответу.
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.dict(os.environ, {}, clear=True),
        ):
            r = await self._place()
        self.assertEqual(r.status_code, 400)
        self.assertIn("Настройка сервиса неполная", r.json()["error"]["message"])

    async def test_health_reports_the_mode_the_button_will_act_in(self):
        for value in (True, False):
            with mock.patch.object(signing_service, "DRY_RUN", value):
                body = (await self.client.get("/health")).json()
            self.assertEqual(body["dry_run"], value)
            self.assertEqual(body["network"], signing_service.LIGHTER_NETWORK)

    async def test_order_model_rejects_garbage(self):
        cases = [
            {"market_index": "abc"},
            {},
            {**_ORDER, "base_amount": -1},
            {**_ORDER, "price": 0},
            {**_ORDER, "market_index": -1},
            {**_ORDER, "client_order_index": -5},
            # Числа за точным диапазоном float64 приходят уже округлёнными: это
            # не «огромный ордер», а испорченный (обычно — неверные decimals).
            {**_ORDER, "base_amount": 2**53},
            {**_ORDER, "price": 2**53},
            # Индекс живёт в int32 у обоих генераторов — 2**31 уже не тот ключ.
            {**_ORDER, "client_order_index": 2**31},
        ]
        for broken in cases:
            with (
                mock.patch.object(signing_service, "DRY_RUN", True),
                mock.patch.object(signing_service, "_get_client"),
            ):
                r = await self._place(broken)
            self.assertEqual(r.status_code, 422, broken)


class TestHostGate(unittest.IsolatedAsyncioTestCase):
    """Публикация сервиса наружу — отказ на уровне процесса.

    /place-order не аутентифицирован, и в этом нет ошибки дизайна: секрета для
    браузера не бывает. Значит граница одна — адрес, и её обязан проверять сам
    процесс, а не ссылка в доке: docker-compose биндит петлю, а Railway-гайд
    однажды советоввал второй сервис с --host 0.0.0.0, то есть публичный URL с
    money-endpoint'ом внутри."""

    async def _ask(self, host_header: str, path: str = "/place-order"):
        """Запрос с явно заданным Host — гейт смотрит именно на него, а не на то,
        куда httpx «думает» что он идёт."""
        transport = httpx.ASGITransport(app=signing_service.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://svc") as c:
            if path == "/place-order":
                return await c.post(path, json=_ORDER, headers={"host": host_header})
            return await c.get(path, headers={"host": host_header})

    async def test_public_host_is_refused_and_never_signs(self):
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", False),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._ask("wake-signing-production.up.railway.app")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"]["code"], "SIGNING_HOST_NOT_ALLOWED")
        self.assertEqual(signer.calls, [], "отказ обязан случиться до работы с ключом")

    async def test_health_is_closed_on_a_public_host_too(self):
        r = await self._ask("example.com", path="/health")
        self.assertEqual(r.status_code, 403)

    async def test_port_in_host_header_does_not_break_the_match(self):
        """127.0.0.1:8787 и localhost:8787 — петля; сравнивать с портом значило бы
        заставить оператора угадывать значение $PORT."""
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            for host in ("127.0.0.1:8787", "localhost:8787", "[::1]:8787"):
                r = await self._ask(host)
                self.assertEqual(r.status_code, 200, host)

    async def test_service_name_of_the_internal_network_is_allowed(self):
        """docker-compose зовёт сервис по имени (WAKE_SIGNING_SERVICE_URL=
        http://signing:8787), и бот, и агент идут этим путём."""
        signer = FakeSigner()
        with (
            mock.patch.object(signing_service, "DRY_RUN", True),
            mock.patch.object(signing_service, "_get_client", return_value=signer),
        ):
            r = await self._ask("signing:8787")
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
