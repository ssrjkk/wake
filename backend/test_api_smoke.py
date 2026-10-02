"""
Smoke-тест всего HTTP-слоя через FastAPI TestClient — реально поднимает
приложение и гоняет каждый роут. Закрывает главный известный пробел проекта
(«FastAPI-эндпоинты написаны, но не прогнаны»): теперь они прогнаны.

Запуск: python -m unittest test_api_smoke -v
"""

import os
import hashlib
import hmac
import json
import time
import tempfile
import unittest
from urllib.parse import urlencode

# Изолированная БД, чтобы не трогать dev-данные
_tmp = tempfile.mkdtemp()
os.environ["WAKE_DB_PATH"] = os.path.join(_tmp, "wake.db")
os.environ["WAKE_AUDIT_DB_PATH"] = os.path.join(_tmp, "audit.db")
os.environ["WAKE_CURATOR_TOKEN"] = "smoke-test-token"
os.environ["TELEGRAM_BOT_TOKEN"] = "123456:smoke-test-bot-token"
# Все запросы идут с одного test-client IP, поэтому несколько классов подряд
# выбивают дефолтное ведро (40) и роуты начинают отдавать 429 вместо своих
# 200/401/404. Сам лимитер проверен в test_rate_limiter.py — здесь он не предмет
# теста, а помеха.
os.environ["WAKE_RATE_LIMIT_CAPACITY"] = "100000"
os.environ["WAKE_RATE_LIMIT_REFILL"] = "100000"

from fastapi.testclient import TestClient
import app  # noqa: E402
import audit_log as al  # noqa: E402
from rate_limiter import RateLimiter  # noqa: E402

# Инициализируем audit_log в временной БД
al.init_audit_db(os.environ["WAKE_AUDIT_DB_PATH"])

client = TestClient(app.app)


def telegram_login_payload(user_id: int = 4242, first_name: str = "Test", auth_date: int | None = None) -> dict:
    """Подписывает данные так же, как это делает Telegram Login Widget (HMAC-SHA256 по
    отсортированным k=v строкам, ключ — sha256 от токена бота)."""
    payload = {
        "id": user_id,
        "first_name": first_name,
        "username": "smoke_user",
        "auth_date": auth_date if auth_date is not None else int(time.time()),
    }
    check_string = "\n".join(f"{k}={payload[k]}" for k in sorted(payload))
    secret = hashlib.sha256(os.environ["TELEGRAM_BOT_TOKEN"].encode()).digest()
    payload["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return payload


def mini_app_init_data(user_id: int = 4343, first_name: str = "Mini",
                       auth_date: int | None = None, token: str | None = None) -> str:
    """Строка initData ровно так, как её подписывает Telegram внутри мини-аппа:
    HMAC-SHA256 по отсортированным k=v, ключ — HMAC-SHA256("WebAppData", токен бота).
    Ключ выводится иначе, чем у Login Widget, поэтому это отдельный хелпер."""
    token = token or os.environ["TELEGRAM_BOT_TOKEN"]
    params = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "query_id": "AAH-smoke",
        "user": json.dumps({"id": user_id, "first_name": first_name,
                            "username": f"smoke_mini_{user_id}", "language_code": "en"},
                           ensure_ascii=False),
    }
    check_string = "\n".join(f"{k}={params[k]}" for k in sorted(params))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    params["hash"] = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(params)


class TestApiSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # фикстура: две строки leaders, чтобы GET /leaders отвечал непустым списком
        import db
        with db.connect(os.environ["WAKE_DB_PATH"]) as conn:
            for id_, idx, handle, fee in [("t1", 101, "@northstar", 8), ("t2", 102, "@vega.eth", 6)]:
                db.upsert_leader(conn, id_, idx, handle, fee)

    def test_health_routes(self):
        health = client.get("/health").json()
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["network"], app.LIGHTER_NETWORK)
        self.assertTrue(health["dry_run"])
        self.assertEqual(client.get("/docs").status_code, 200)
        self.assertEqual(client.get("/openapi.json").status_code, 200)

    def test_rate_limiter_middleware_really_wraps_the_routes(self):
        """Ведро по IP стоит перед всеми роутами: на нулевом восполнении второй
        запрос подряд обязан получить 429, а не результат роута. Без этой проверки
        завышенная ёмкость ведра в заголовке файла могла бы означать «лимитер
        вообще не подключён»."""
        original = app._rate_limiter
        app._rate_limiter = RateLimiter(capacity=1, refill_rate=1e-6)
        try:
            self.assertEqual(client.get("/predict/markets").status_code, 200)
            r = client.get("/predict/markets")
            self.assertEqual(r.status_code, 429)
            self.assertIn("Retry-After", r.headers)
        finally:
            app._rate_limiter = original
        self.assertEqual(client.get("/predict/markets").status_code, 200)

    def test_copy_trading_cycle(self):
        r = client.post("/followers", json={"l1_address": "0xabc"})
        self.assertEqual(r.status_code, 200)
        follower_id = r.json()["follower_id"]

        r = client.post("/leaders", json={"lighter_account_index": 999, "handle": "@smoke", "fee_bps": 8})
        self.assertEqual(r.status_code, 200)
        leader_id = r.json()["leader_id"]

        r = client.post("/follows", json={"follower_id": follower_id, "leader_id": leader_id, "allocation_usd": 500})
        self.assertEqual(r.status_code, 200)

        r = client.get(f"/follows/by-follower/{follower_id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)

        r = client.get(f"/follows/by-leader/{leader_id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["follower_count"], 1)
        follow_id = r.json()["follows"][0]["id"]

        r = client.post(f"/follows/{follow_id}/pause")
        self.assertEqual(r.status_code, 200)
        r = client.post(f"/follows/{follow_id}/resume")
        self.assertEqual(r.status_code, 200)

        r = client.post("/simulate-mirror", json={
            "leader_id": leader_id, "market_id": 1, "side": "long", "is_increase": True,
            "size_delta": 0.5, "price": 100000, "leader_equity_usd": 50000,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["orders"]), 1)

    def test_predict_cycle(self):
        r = client.post("/predict/markets/price", json={
            "question": "BTC above 100k?", "lighter_market_id": 1,
            "threshold": 100000, "comparator": ">=", "resolve_at": 1999999999, "b": 100,
        })
        self.assertEqual(r.status_code, 403, "создание price-рынка без куратора — прямой путь к рынку, который зарезолвят под свою позицию")

        r = client.post("/predict/markets/price", json={
            "question": "BTC above 100k?", "lighter_market_id": 1,
            "threshold": 100000, "comparator": ">=", "resolve_at": 1999999999, "b": 100,
        }, headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)
        market_id = r.json()["market_id"]

        # ручной триггер автоматической резолюции: без токена — отказ; с токеном —
        # отказ, потому что дедлайн рынка (2033 год) ещё не наступил. Сетевой запрос
        # к Lighter при этом не делается: обе проверки идут до него.
        r = client.post(f"/predict/markets/{market_id}/resolve-price", json={})
        self.assertEqual(r.status_code, 403, "цена берётся в момент вызова — иначе держатель позиции сам выбирает момент резолюции")
        r = client.post(f"/predict/markets/{market_id}/resolve-price", json={}, headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 409, "до resolve_at закрывать рынок нельзя")

        r = client.post("/predict/markets/event", json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100})
        self.assertEqual(r.status_code, 403, "event-market без токена куратора должен быть запрещён")

        r = client.post("/predict/markets/event", json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)
        event_id = r.json()["market_id"]

        r = client.get("/predict/markets")
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(len(r.json()), 2)

        r = client.get(f"/predict/markets/{market_id}/preview?outcome=yes&shares=5")
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["cost_usd"], 0)

        r = client.post(f"/predict/markets/{market_id}/trade", json={"user_id": "u1", "outcome": "yes", "shares": 10})
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["cost_usd"], 0)
        buy_cost = r.json()["cost_usd"]

        # продажа половины позиции: cost отрицательный, юзеру возвращаются деньги
        r = client.post(f"/predict/markets/{market_id}/trade", json={"user_id": "u1", "outcome": "yes", "shares": -4})
        self.assertEqual(r.status_code, 200)
        self.assertLess(r.json()["cost_usd"], 0)
        sell_cost = r.json()["cost_usd"]

        # объём считается по |cost| обеих сделок — это сделки через Wake, не рыночный объём
        r = client.get("/predict/markets")
        row = next(m for m in r.json() if m["id"] == market_id)
        self.assertEqual(row["trade_count"], 2)
        self.assertAlmostEqual(row["volume_usd"], buy_cost + abs(sell_cost), delta=1e-6)

        # позиции юзера: 6 shares YES, средняя входа = уплаченное минус возвращенное
        r = client.get(f"/predict/positions?user_id=u1")
        self.assertEqual(r.status_code, 200)
        pos = next(p for p in r.json() if p["market_id"] == market_id)
        self.assertEqual(pos["shares"], 6)
        self.assertEqual(pos["outcome"], "yes")
        self.assertFalse(pos["claimed"])

        r = client.post(f"/predict/markets/{market_id}/resolve-event",
                        json={"outcome": "yes", "resolved_by": "curator", "evidence_url": "https://example.com"})
        self.assertEqual(r.status_code, 403, "resolve-event без токена куратора должен быть запрещён")

        r = client.post(f"/predict/markets/{market_id}/resolve-event",
                        json={"outcome": "yes", "resolved_by": "curator", "evidence_url": "https://example.com"},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)

        # исход выносится один раз: переписать его = переписать выплаты
        r = client.post(f"/predict/markets/{market_id}/resolve-event",
                        json={"outcome": "no", "resolved_by": "curator", "evidence_url": "https://example.com"},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 409)

        r = client.post(f"/predict/markets/{market_id}/claim?user_id=u1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payout_usd"], 6.0)

        # резолванный рынок виден только по фильтру, открытый список его больше не отдаёт
        r = client.get("/predict/markets?status=resolved")
        self.assertIn(market_id, [m["id"] for m in r.json()])
        r = client.get("/predict/markets?status=open")
        self.assertNotIn(market_id, [m["id"] for m in r.json()])
        r = client.get("/predict/markets?status=bogus")
        self.assertEqual(r.status_code, 422, "неизвестный статус — не «пустой список», а явная ошибка")

        # после резолюции позиция остаётся видимой, но claimable становится 0 после выплаты
        r = client.get(f"/predict/positions?user_id=u1")
        pos = next(p for p in r.json() if p["market_id"] == market_id)
        self.assertTrue(pos["claimed"])
        self.assertEqual(pos["claimable_usd"], 0.0)
        self.assertEqual(pos["market_outcome"], "yes")

        # event-рынок резолвится тем же путём
        r = client.post(f"/predict/markets/{event_id}/resolve-event",
                        json={"outcome": "no", "resolved_by": "curator", "evidence_url": "https://example.com"},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)

    def test_funding_arb(self):
        r = client.post("/funding-arb/check", json={"market_id": 1, "symbol": "BTC", "hourly_rate": 0.0001, "direction": "long"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["opportunity"])
        self.assertGreater(r.json()["opportunity"]["annualized_yield"], 0.8)

        r = client.post("/funding-arb/size", json={
            "capital_usd": 1000, "price": 100000, "perp_size_decimals": 3,
            "spot_size_decimals": 3, "perp_min_base_amount": 0.001, "spot_min_base_amount": 0.001,
        })
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["position"])


class TestFundingLiveRoutes(unittest.TestCase):
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
        {"market_id": 0, "symbol": "ETH", "market_type": "perp", "status": "active",
         "min_base_amount": "0.0050", "supported_size_decimals": 3},
        {"market_id": 2048, "symbol": "ETH/USDC", "market_type": "spot", "status": "active",
         "min_base_amount": "0.0010", "supported_size_decimals": 4},
        {"market_id": 1, "symbol": "BTC", "market_type": "perp", "status": "active",
         "min_base_amount": "0.00007", "supported_size_decimals": 5},
    ]

    def setUp(self):
        import lighter_rest
        self._rates = lighter_rest.get_funding_rates
        self._books = lighter_rest.get_order_books
        lighter_rest.get_funding_rates = lambda network=None: list(self.RATES)
        lighter_rest.get_order_books = lambda network="perp": list(self.BOOKS)
        self.addCleanup(setattr, lighter_rest, "get_funding_rates", self._rates)
        self.addCleanup(setattr, lighter_rest, "get_order_books", self._books)

    def test_rates_ranked_by_annualized(self):
        r = client.get("/funding/rates")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["epoch_hours"], 1, "годовая считается на часовой эпох, не на 8-часовой")
        got = body["rates"]
        self.assertEqual([x["market_id"] for x in got], [0, 1], "по модулю 0.0003 > 0.00008")
        self.assertAlmostEqual(got[0]["annualized"], 0.0003 * 24 * 365, places=9)
        self.assertEqual(got[0]["direction"], "short", "отрицательная ставка — платят шорты")
        self.assertEqual(got[0]["signed_rate"], -0.0003)
        self.assertEqual(got[1]["signed_rate"], 0.00008)
        # Имя рынка берётся из строки той же площадки: поле symbol — то, что
        # реально отдаёт Lighter (голый базовый актив), base — нормализованный
        # тикер для сопоставлений на фронте.
        self.assertEqual([x["symbol"] for x in got], ["ETH", "BTC"])
        self.assertEqual([x["base"] for x in got], ["ETH", "BTC"])
        # В ответе только строки Lighter: две из четырёх фикстурых строк принадлежат
        # чужим площадкам, и примесь их ставок дала бы total=4.
        self.assertEqual(body["total"], 2)

    def test_positive_only_leaves_capturable_side(self):
        got = client.get("/funding/rates?positive_only=true").json()["rates"]
        self.assertEqual([x["market_id"] for x in got], [1])
        self.assertTrue(all(x["direction"] == "long" for x in got))

    def test_rates_limit_and_502(self):
        self.assertEqual(len(client.get("/funding/rates?limit=1").json()["rates"]), 1)
        self.assertEqual(client.get("/funding/rates?limit=0").status_code, 422)
        self.assertEqual(client.get("/funding/rates?limit=1000").status_code, 422)

        import lighter_rest
        def boom(network=None):
            raise RuntimeError("Lighter API недоступен")
        lighter_rest.get_funding_rates = boom
        r = client.get("/funding/rates")
        self.assertEqual(r.status_code, 502, "мёртвый апстрим — явная ошибка, не пустой список ставок")
        self.assertIn("Lighter", r.json()["detail"])

    def test_venues_group_by_asset_and_accept_typed_spelling(self):
        """/funding/venues полезен ровно одним: ставки одного актива рядом, по
        площадкам. Площадки в живом ответе подписывают актив голым именем, так что
        нормализация нужна для ВВОДА — юзер впишет "BTC-PERP" или "btcusdt" со
        сторонней биржи, и такой запрос обязан найти те же строки, что и "BTC"."""
        expected = [
            {"venue": "bybit", "symbol": "BTC", "market_id": 1, "signed_rate": -0.0000153},
            {"venue": "hyperliquid", "symbol": "BTC", "market_id": 1, "signed_rate": 0.0001},
            {"venue": "lighter", "symbol": "BTC", "market_id": 1, "signed_rate": 0.00008},
        ]
        for typed in ("btc", "BTC-PERP", "btcusdt", "BTC/USDC"):
            r = client.get(f"/funding/venues?symbol={typed}")
            self.assertEqual(r.status_code, 200, typed)
            body = r.json()
            self.assertEqual(body["base"], "BTC", typed)
            self.assertEqual(sorted(body["venues"], key=lambda v: v["venue"]), expected, typed)
            rates = [v["signed_rate"] for v in body["venues"]]
            self.assertEqual(rates, sorted(rates, reverse=True), "отсортировано по убыванию ставки")

        r = client.get("/funding/venues?symbol=NOPE")
        self.assertEqual(r.status_code, 404)

    def test_carry_markets_lists_real_pairs_with_sizing_inputs(self):
        r = client.get("/funding/carry-markets")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["quote"], "USDC")
        self.assertEqual(body["count"], 1, "только ETH имеет обе ноги в этой книге")
        eth = body["markets"][0]
        self.assertEqual((eth["perp_market_id"], eth["spot_market_id"]), (0, 2048))
        self.assertEqual((eth["perp_min_base_amount"], eth["spot_min_base_amount"]), (0.005, 0.001))
        self.assertEqual((eth["perp_size_decimals"], eth["spot_size_decimals"]), (3, 4))
        self.assertEqual(eth["hourly_rate"], 0.0003)
        self.assertAlmostEqual(eth["annualized"], 0.0003 * 24 * 365, places=9)

    def test_carry_market_without_funding_row_is_reported_not_dropped(self):
        """Пара существует на книге независимо от того, есть ли по ней ставка:
        убрать её из списка — значит соврать про количество рынков."""
        import lighter_rest
        lighter_rest.get_funding_rates = lambda network=None: []
        body = client.get("/funding/carry-markets").json()
        self.assertEqual(body["count"], 1)
        self.assertIsNone(body["markets"][0]["hourly_rate"])
        self.assertIsNone(body["markets"][0]["annualized"])

    def test_portfolio_risk(self):
        r = client.post("/portfolio/risk", json={
            "positions": [
                {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1000},
                {"market_id": 2, "symbol": "ETH", "signed_notional_usd": -500},
            ],
            "returns_by_market": {"1": [0.01, -0.02, 0.015], "2": [0.005, -0.01, 0.02]},
        })
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertLessEqual(body["portfolio_dollar_volatility"], body["naive_dollar_volatility"])

        r = client.post("/portfolio/hedge", json={
            "target": {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1000},
            "candidates": [[2, "ETH"]],
            "returns_by_market": {"1": [0.01, -0.02, 0.015], "2": [0.005, -0.01, 0.02]},
        })
        self.assertEqual(r.status_code, 200)

class TestMarketsOverview(unittest.TestCase):
    """Главный экран сайта и /markets в боте обязаны показывать ОДНИ числа,
    поэтому роут проверяется на фикстурах с формой живого ответа mainnet
    (2026-10-02): market_id и decimals — числа, price/volume — из свечей,
    funding-строки — голые базовые имена. Сеть не трогается."""

    ROWS = [
        {"market_id": 1, "symbol": "BTC", "base": "BTC", "price": 84408.7,
         "change_24h": -0.002, "quote_volume_24h": 847_800_000.0,
         "open_interest_base": 370.84, "min_base_amount": 0.00007, "size_decimals": 5,
         "taker_fee": 0.0, "maker_fee": 0.0},
        {"market_id": 0, "symbol": "ETH", "base": "ETH", "price": 2660.34,
         "change_24h": -0.0138, "quote_volume_24h": 350_500_000.0,
         "open_interest_base": 152_300.0, "min_base_amount": 0.005, "size_decimals": 3,
         "taker_fee": 0.0, "maker_fee": 0.0},
        {"market_id": 120, "symbol": "LIT", "base": "LIT", "price": 3.11,
         "change_24h": 0.05, "quote_volume_24h": 20_300_000.0,
         "open_interest_base": 4_100_000.0, "min_base_amount": 1.0, "size_decimals": 0,
         "taker_fee": 0.0, "maker_fee": 0.0},
    ]
    # BTC и LIT пришли из ответа Lighter, ETH — нет: роут обязан показать отсутствие
    # ставки пустым полем, а не выкинуть рынок из обзора.
    RATES = [
        {"exchange": "lighter", "market_id": 1, "rate": 0.00008, "symbol": "BTC"},
        {"exchange": "lighter", "market_id": 120, "rate": -0.00012, "symbol": "LIT"},
        {"exchange": "binance", "market_id": 1, "rate": 0.0001, "symbol": "BTC"},
    ]

    def setUp(self):
        import lighter_rest
        self._overview = lighter_rest.get_market_overview
        self._rates = lighter_rest.get_funding_rates
        lighter_rest.get_market_overview = lambda symbols=None, network=None: {
            "network": network or "mainnet", "ranked_by": "quote_volume_24h",
            "count": len(self.ROWS), "rows": [dict(r) for r in self.ROWS],
            "no_market": ["TON"], "no_data": ["MATIC"],
        }
        lighter_rest.get_funding_rates = lambda network=None: list(self.RATES)
        self.addCleanup(setattr, lighter_rest, "get_market_overview", self._overview)
        self.addCleanup(setattr, lighter_rest, "get_funding_rates", self._rates)

    def test_rows_carry_funding_and_keep_gap_visible(self):
        r = client.get("/markets/overview")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["epoch_hours"], 1, "годовая считается на часовой эпох, не на 8-часовой")
        self.assertEqual(body["ranked_by"], "quote_volume_24h")
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["no_market"], ["TON"])
        self.assertEqual(body["no_data"], ["MATIC"])
        # Порядок — за lighter_rest (по $-обороту), роут его не переиначивает.
        self.assertEqual([x["market_id"] for x in body["rows"]], [1, 0, 120])

        by_id = {x["market_id"]: x for x in body["rows"]}
        self.assertAlmostEqual(by_id[1]["funding_annualized"], 0.00008 * 24 * 365, places=9)
        self.assertEqual(by_id[1]["funding_payer"], "long", "положительная ставка — платят лонги")
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

    def test_dead_upstream_is_502_not_empty_overview(self):
        import lighter_rest
        def boom(symbols=None, network=None):
            raise RuntimeError("Lighter API недоступен")
        lighter_rest.get_market_overview = boom
        r = client.get("/markets/overview")
        self.assertEqual(r.status_code, 502)
        self.assertIn("Lighter", r.json()["detail"])


class TestPortfolioAndAgent(unittest.TestCase):
    def test_subscription_and_agent(self):
        r = client.post("/subscription/u1/start-trial")
        self.assertEqual(r.status_code, 200)
        r = client.get("/subscription/u1")
        self.assertEqual(r.json()["tier"], "free_trial")
        self.assertTrue(r.json()["has_ai_agent"])

        r = client.post("/agent/step", json={
            "user_id": "u1", "market_id": 1, "recent_prices": [99000, 99500, 100000, 100500, 101000],
            "size_decimals": 4, "price_decimals": 0, "base_size_usd": 100,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["execution"]["status"], "dry_run")

        r = client.get("/agent/memory/u1")
        self.assertEqual(r.status_code, 200)


class TestTelegramAuth(unittest.TestCase):
    """Вход через Telegram — один из двух способов попасть в Wake (второй — кошелёк),
    поэтому проверяется и подпись, и запись в followers."""

    def _followers(self):
        import db
        with db.connect(os.environ["WAKE_DB_PATH"]) as conn:
            return conn.execute("SELECT id, l1_address, telegram_id FROM followers").fetchall()

    def test_valid_signature_creates_follower(self):
        r = client.post("/auth/telegram", json=telegram_login_payload())
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["user_id"], "tg_4242")

        rows = [row for row in self._followers() if row["telegram_id"] == 4242]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "tg_4242")

    def test_repeat_login_does_not_duplicate(self):
        client.post("/auth/telegram", json=telegram_login_payload(user_id=4243))
        client.post("/auth/telegram", json=telegram_login_payload(user_id=4243))
        rows = [row for row in self._followers() if row["telegram_id"] == 4243]
        self.assertEqual(len(rows), 1)

    def test_tampered_signature_rejected(self):
        payload = telegram_login_payload(user_id=4244)
        payload["first_name"] = "Attacker"  # меняем поле, подпись остаётся от старого
        r = client.post("/auth/telegram", json=payload)
        self.assertEqual(r.status_code, 401)

    def test_stale_auth_date_rejected(self):
        payload = telegram_login_payload(user_id=4245, auth_date=int(time.time()) - 90000)
        r = client.post("/auth/telegram", json=payload)
        self.assertEqual(r.status_code, 401, "старше суток — подписывать такой вход уже нельзя")
        self.assertEqual([row for row in self._followers() if row["telegram_id"] == 4245], [])


class TestTelegramMiniApp(unittest.TestCase):
    """Мини-апп открывается кнопкой из бота, и вход там идёт по initData, а не по
    виджету. Подпись проверяется на токене бота — то есть подделать её можно только
    зная этот токен, а не правкой ответа в браузере."""

    def _followers(self):
        import db
        with db.connect(os.environ["WAKE_DB_PATH"]) as conn:
            return conn.execute("SELECT id, l1_address, telegram_id FROM followers").fetchall()

    def test_valid_init_data_creates_follower(self):
        r = client.post("/auth/telegram/init", json={"init_data": mini_app_init_data(user_id=4350)})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["user_id"], "tg_4350")
        self.assertEqual(body["username"], "smoke_mini_4350")
        rows = [row for row in self._followers() if row["telegram_id"] == 4350]
        self.assertEqual(len(rows), 1)

    def test_widget_and_miniapp_login_share_one_follower(self):
        client.post("/auth/telegram", json=telegram_login_payload(user_id=4351))
        r = client.post("/auth/telegram/init", json={"init_data": mini_app_init_data(user_id=4351)})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["user_id"], "tg_4351")
        rows = [row for row in self._followers() if row["telegram_id"] == 4351]
        self.assertEqual(len(rows), 1, "два входа одного человека не плодят два аккаунта")

    def test_foreign_token_signature_rejected(self):
        init_data = mini_app_init_data(user_id=4352, token="999999:not-our-bot-token")
        r = client.post("/auth/telegram/init", json={"init_data": init_data})
        self.assertEqual(r.status_code, 401)
        self.assertEqual([row for row in self._followers() if row["telegram_id"] == 4352], [])

    def test_tampered_user_field_rejected(self):
        # Подписанную строку пересобираем с чужим id, оставив старый hash: ровно то,
        # что делает правка initData в консоли браузера.
        from urllib.parse import parse_qsl
        pairs = dict(parse_qsl(mini_app_init_data(user_id=4353)))
        user = json.loads(pairs["user"])
        user["id"] = 1
        pairs["user"] = json.dumps(user, ensure_ascii=False)
        r = client.post("/auth/telegram/init", json={"init_data": urlencode(pairs)})
        self.assertEqual(r.status_code, 401, "редакция initData в браузере не даёт вход")
        self.assertEqual([row for row in self._followers() if row["telegram_id"] == 1], [])

    def test_stale_init_data_rejected(self):
        init_data = mini_app_init_data(user_id=4354, auth_date=int(time.time()) - 90000)
        r = client.post("/auth/telegram/init", json={"init_data": init_data})
        self.assertEqual(r.status_code, 401)
        self.assertEqual([row for row in self._followers() if row["telegram_id"] == 4354], [])

    def test_empty_init_data_rejected(self):
        r = client.post("/auth/telegram/init", json={"init_data": ""})
        self.assertEqual(r.status_code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)