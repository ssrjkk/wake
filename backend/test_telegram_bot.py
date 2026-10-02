"""Формообразователи telegram_bot.py прогоняются на фикстурах ФОРМЫ живого ответа
Lighter (market_id int, open_interest/min_base_amount строками) — сам Telegram отсюда
не дёргается: Bot создаётся лениво в main(), поэтому модуль импортируется
без токена, а хендлеры остаются обвязкой над этими функциями.

Запуск: python3 test_telegram_bot.py
"""

import datetime
import unittest

import cache
import telegram_bot as tb


BOOK = {"market_id": 1, "symbol": "BTC", "market_type": "perp", "status": "active",
        "open_interest": "372.658848", "min_base_amount": "0.00007",
        "supported_size_decimals": 5, "taker_fee": "0.0002"}

STATS = {"price": 84408.7, "change_24h": -0.002, "quote_volume_24h": 847_828_634.0,
         "candles_used": 24}

FUNDING = {"market_id": 1, "symbol": "BTC", "rate": 0.00008, "signed_rate": 0.00008,
           "direction": "long"}


class TestImportIsTokenFree(unittest.TestCase):
    def test_module_imports_and_registers_handlers_without_token(self):
        self.assertIsNotNone(tb.dp)
        self.assertEqual(len(tb.dp.message.handlers), 6,
                         "/start /price /markets /funding /predict и fallback")


class TestFormatting(unittest.TestCase):
    def test_usd_scale_switches(self):
        self.assertEqual(tb.fmt_usd(0.5), "$0.50")
        self.assertEqual(tb.fmt_usd(1_000), "$1K")
        self.assertEqual(tb.fmt_usd(847_828_634), "$847.8M")
        self.assertEqual(tb.fmt_usd(2_400_000_000), "$2.40B")

    def test_price_keeps_significant_digits(self):
        self.assertEqual(tb.fmt_price(84_408.7), "84,408.70")
        self.assertEqual(tb.fmt_price(3.5957), "3.5957")
        self.assertEqual(tb.fmt_price(0.000123), "0.000123")

    def test_pct_is_signed(self):
        self.assertEqual(tb.fmt_pct(-0.002), "-0.20%")
        self.assertEqual(tb.fmt_pct(0.0138), "+1.38%")

    def test_open_interest_is_base_units_and_survives_missing_field(self):
        self.assertEqual(tb.fmt_open_interest(BOOK), "372.6588")
        self.assertEqual(tb.fmt_open_interest({"open_interest": ""}), "—")
        self.assertEqual(tb.fmt_open_interest({}), "—")


class TestPriceReport(unittest.TestCase):
    def test_real_numbers_not_metadata_placeholder(self):
        got = tb.price_report("BTC", BOOK, STATS, FUNDING)
        self.assertIn("84,408.70", got)
        self.assertIn("-0.20%", got)
        self.assertIn("$847.8M", got)
        self.assertIn("market_id 1", got)
        self.assertIn("0.00007", got, "минимальный размер — из книги, он определяет, что вообще исполнимо")

    def test_funding_payer_follows_sign(self):
        """"платят лонги" при direction="long" — именно так cash-and-carry и
        читается: шорт перпа получает ставку. Перепутать — значит отправить юзера
        в противоположную ногу."""
        self.assertIn("платят лонги", tb.price_report("BTC", BOOK, STATS, FUNDING))
        shorts_pay = dict(FUNDING, direction="short", signed_rate=-0.00008)
        self.assertIn("платят шорты", tb.price_report("BTC", BOOK, STATS, shorts_pay))

    def test_missing_funding_is_stated_not_invented(self):
        got = tb.price_report("BTC", BOOK, STATS, None)
        self.assertIn("нет ставки", got)
        self.assertNotIn("%/ч", got)


class TestMarketsReport(unittest.TestCase):
    OVERVIEW = {
        "network": "mainnet",
        "ranked_by": "quote_volume_24h",
        "count": 3,
        "rows": [
            {"symbol": "BTC", "price": 84408.7, "change_24h": -0.002, "quote_volume_24h": 847_828_634.0},
            {"symbol": "ETH", "price": 2660.34, "change_24h": -0.0138, "quote_volume_24h": 350_475_314.0},
            {"symbol": "SOL", "price": 117.68, "change_24h": 0.0035, "quote_volume_24h": 55_100_000.0},
        ],
        "no_market": ["TON"],
        "no_data": [],
    }

    def test_ranked_by_dollar_volume_with_numbers(self):
        got = tb.markets_report(self.OVERVIEW, limit=2)
        lines = got.splitlines()
        self.assertIn("BTC", lines[1])
        self.assertIn("ETH", lines[2])
        self.assertNotIn("SOL", got, "limit=2 — третий рынок в ответе быть не должен")
        self.assertIn("$847.8M", got)
        self.assertIn("-1.38%", got, "изменение передаётся со знаком, а не по модулю")

    def test_absent_market_is_named(self):
        self.assertIn("TON", tb.markets_report(self.OVERVIEW))

    def test_empty_overview_says_so(self):
        empty = dict(self.OVERVIEW, rows=[], count=0)
        self.assertIn("нет", tb.markets_report(empty))


class TestPredictReport(unittest.TestCase):
    NOW = datetime.datetime(2026, 10, 3, 12, 0, tzinfo=datetime.timezone.utc)

    def test_open_market_shows_price_volume_and_time_left(self):
        rows = [{"id": "m1", "question": "BTC выше 90k к 5 октября?", "status": "open",
                 "price_yes": 0.62, "volume_usd": 1500.0, "trade_count": 12,
                 "resolve_at": (self.NOW + datetime.timedelta(days=1, hours=3)).timestamp()}]
        got = tb.predict_report(rows, now=self.NOW)
        self.assertIn("62% YES", got)
        self.assertIn("объём $1.5K", got)
        self.assertIn("сделок 12", got)
        self.assertIn("осталось 1д 3ч", got)

    def test_resolved_market_shows_outcome_instead_of_price(self):
        rows = [{"id": "m2", "question": "ETH выше 2500?", "status": "resolved",
                 "outcome": "yes", "price_yes": 1.0, "volume_usd": 0.0, "trade_count": 3,
                 "resolve_at": (self.NOW - datetime.timedelta(hours=2)).timestamp()}]
        got = tb.predict_report(rows, now=self.NOW)
        self.assertIn("исход: yes", got)
        self.assertNotIn("осталось", got, "у истёкшего рынка не может быть «осталось»")

    def test_time_left_formats_hours_and_minutes(self):
        for delta, expected in ((datetime.timedelta(hours=5, minutes=20), "осталось 5ч 20м"),
                                (datetime.timedelta(minutes=40), "осталось 40м"),
                                (datetime.timedelta(hours=-1), "срок истёк")):
            rows = [{"question": "q", "status": "open", "price_yes": 0.5,
                     "resolve_at": (self.NOW + delta).timestamp()}]
            self.assertIn(expected, tb.predict_report(rows, now=self.NOW))

    def test_empty_list_points_at_resolved_filter(self):
        self.assertIn("/predict resolved", tb.predict_report([], now=self.NOW))


class TestFundingReport(unittest.TestCase):
    RATES = [
        {"symbol": "LIT", "hourly_rate": 0.00232, "annualized": 2.032, "direction": "long"},
        {"symbol": "SKY", "hourly_rate": 0.00112, "annualized": 0.981, "direction": "long"},
    ]

    def test_rows_and_wording(self):
        got = tb.funding_report(self.RATES)
        self.assertIn("LIT", got)
        self.assertIn("203.2% годовых", got)
        self.assertIn("платят лонги", got)

    def test_empty_explains_instead_of_blanking_out(self):
        self.assertIn("нет", tb.funding_report([]))


class TestFindPerp(unittest.TestCase):
    BOOKS = [
        {"market_id": 1, "symbol": "BTC", "market_type": "perp", "status": "active",
         "open_interest": "372.658848", "min_base_amount": "0.00007",
         "supported_size_decimals": 5},
        {"market_id": 2048, "symbol": "BTC/USDC", "market_type": "spot", "status": "active",
         "open_interest": "0", "min_base_amount": "0.001", "supported_size_decimals": 4},
        {"market_id": 9, "symbol": "OLD", "market_type": "perp", "status": "closed",
         "open_interest": "1", "min_base_amount": "1", "supported_size_decimals": 0},
    ]

    def setUp(self):
        import lighter_rest
        cache.clear()
        self._original = lighter_rest.get_order_books
        lighter_rest.get_order_books = lambda network=None: list(self.BOOKS)
        self.addCleanup(setattr, lighter_rest, "get_order_books", self._original)
        cache.clear()

    def test_perp_not_spot_not_inactive(self):
        """"BTC/USDC" — тот же актив, но спот: взять его означало бы показать юзеру
        ограничения не той ноги. Рынок со status="closed" вообще не торговается."""
        self.assertEqual(tb.find_perp("BTC")["market_id"], 1)
        self.assertEqual(tb.find_perp("btc-perp")["market_id"], 1, "вписанный тикер нормализуется")
        self.assertIsNone(tb.find_perp("OLD"), "закрытый рынок не находится намеренно")
        self.assertIsNone(tb.find_perp("NOPE"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
