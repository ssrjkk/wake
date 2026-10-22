"""Формообразователи telegram_bot.py прогоняются на фикстурах ФОРМЫ живого ответа
Lighter (market_id int, open_interest/min_base_amount строками) — сам Telegram отсюда
не дёргается: Bot создаётся лениво в main(), поэтому модуль импортируется
без токена, а хендлеры остаются обвязкой над этими функциями.

Запуск: python3 test_telegram_bot.py
"""

import asyncio
import datetime
import unittest
from unittest.mock import patch

import httpx

import cache
import telegram_bot as tb
from funding_arb import funding_rate_rows


def _raise_runtime(message: str):
    """Фикстура «Lighter ответил, но по этому рынку данных нет» — так же, как её
    бросает lighter_rest: RuntimeError, а не пустой словарь."""

    def fail(*args, **kwargs):
        raise RuntimeError(message)

    return fail


BOOK = {
    "market_id": 1,
    "symbol": "BTC",
    "market_type": "perp",
    "status": "active",
    "open_interest": "372.658848",
    "min_base_amount": "0.00007",
    "supported_size_decimals": 5,
    "taker_fee": "0.0002",
}

STATS = {
    "price": 84408.7,
    "change_24h": -0.002,
    "quote_volume_24h": 847_828_634.0,
    "high_24h": 86_100.0,
    "low_24h": 82_300.0,
    "closes": [83_000.0, 84_000.0, 82_500.0, 84_408.7],
    "candles_used": 24,
}

FUNDING = {
    "market_id": 1,
    "symbol": "BTC",
    "rate": 0.00008,
    "signed_rate": 0.00008,
    "direction": "long",
}


class TestImportIsTokenFree(unittest.TestCase):
    def test_module_imports_and_registers_handlers_without_token(self):
        self.assertIsNotNone(tb.dp)
        self.assertEqual(
            len(tb.dp.message.handlers),
            7,
            "/start /price /markets /funding /predict /wake и fallback",
        )
        self.assertEqual(
            len(tb.dp.callback_query.handlers),
            5,
            "тикер, три раздела и нераспознанный callback последним",
        )
        self.assertEqual(
            [h.callback.__name__ for h in tb.dp.callback_query.handlers][-1],
            "cb_unknown",
            "catch-all обязан стоять после конкретных: до него доходит только лишнее",
        )

    def test_menu_lists_every_command_the_bot_answers(self):
        """Команды регистрируются в меню Telegram при старте. Меню и реально
        обработанные команды разъехались бы молча: юзер тапнул бы команду, на
        которую бот отвечает «не понял»."""
        handled = {
            h.callback.__name__.removeprefix("cmd_")
            for h in tb.dp.message.handlers
            if h.callback.__name__.startswith("cmd_")
        }
        menu = {c.command for c in tb.BOT_COMMANDS}
        self.assertEqual(
            menu,
            (handled - {"start"}) | {"help"},
            "/help живёт на обработчике /start, /start в меню не нужен — это приветствие",
        )


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
        self.assertIn(
            "0.00007",
            got,
            "минимальный размер — из книги, он определяет, что вообще исполнимо",
        )

    def test_funding_payer_follows_sign(self):
        """ "платят лонги" при direction="long" — именно так cash-and-carry и
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
            {
                "symbol": "BTC",
                "price": 84408.7,
                "change_24h": -0.002,
                "quote_volume_24h": 847_828_634.0,
            },
            {
                "symbol": "ETH",
                "price": 2660.34,
                "change_24h": -0.0138,
                "quote_volume_24h": 350_475_314.0,
            },
            {
                "symbol": "SOL",
                "price": 117.68,
                "change_24h": 0.0035,
                "quote_volume_24h": 55_100_000.0,
            },
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
        rows = [
            {
                "id": "m1",
                "question": "BTC выше 90k к 5 октября?",
                "status": "open",
                "price_yes": 0.62,
                "volume_usd": 1500.0,
                "trade_count": 12,
                "resolve_at": (
                    self.NOW + datetime.timedelta(days=1, hours=3)
                ).timestamp(),
            }
        ]
        got = tb.predict_report(rows, now=self.NOW)
        self.assertIn("62% YES", got)
        self.assertIn("объём $1.5K", got)
        self.assertIn("сделок 12", got)
        self.assertIn("осталось 1д 3ч", got)

    def test_resolved_market_shows_outcome_instead_of_price(self):
        rows = [
            {
                "id": "m2",
                "question": "ETH выше 2500?",
                "status": "resolved",
                "outcome": "yes",
                "price_yes": 1.0,
                "volume_usd": 0.0,
                "trade_count": 3,
                "resolve_at": (self.NOW - datetime.timedelta(hours=2)).timestamp(),
            }
        ]
        got = tb.predict_report(rows, now=self.NOW)
        self.assertIn("исход: yes", got)
        self.assertNotIn("осталось", got, "у истёкшего рынка не может быть «осталось»")

    def test_time_left_formats_hours_and_minutes(self):
        for delta, expected in (
            (datetime.timedelta(hours=5, minutes=20), "осталось 5ч 20м"),
            (datetime.timedelta(minutes=40), "осталось 40м"),
            (datetime.timedelta(hours=-1), "срок истёк"),
        ):
            rows = [
                {
                    "question": "q",
                    "status": "open",
                    "price_yes": 0.5,
                    "resolve_at": (self.NOW + delta).timestamp(),
                }
            ]
            self.assertIn(expected, tb.predict_report(rows, now=self.NOW))

    def test_empty_list_points_at_resolved_filter(self):
        self.assertIn("/predict resolved", tb.predict_report([], now=self.NOW))


class TestFundingReport(unittest.TestCase):
    RATES = [
        {
            "symbol": "LIT",
            "hourly_rate": 0.00232,
            "annualized": 2.032,
            "direction": "long",
        },
        {
            "symbol": "SKY",
            "hourly_rate": 0.00112,
            "annualized": 0.981,
            "direction": "long",
        },
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
        {
            "market_id": 1,
            "symbol": "BTC",
            "market_type": "perp",
            "status": "active",
            "open_interest": "372.658848",
            "min_base_amount": "0.00007",
            "supported_size_decimals": 5,
        },
        {
            "market_id": 2048,
            "symbol": "BTC/USDC",
            "market_type": "spot",
            "status": "active",
            "open_interest": "0",
            "min_base_amount": "0.001",
            "supported_size_decimals": 4,
        },
        {
            "market_id": 9,
            "symbol": "OLD",
            "market_type": "perp",
            "status": "closed",
            "open_interest": "1",
            "min_base_amount": "1",
            "supported_size_decimals": 0,
        },
    ]

    def setUp(self):
        import lighter_rest

        cache.clear()
        self._original = lighter_rest.get_order_books
        lighter_rest.get_order_books = lambda network=None: list(self.BOOKS)
        self.addCleanup(setattr, lighter_rest, "get_order_books", self._original)
        cache.clear()

    def test_perp_not_spot_not_inactive(self):
        """ "BTC/USDC" — тот же актив, но спот: взять его означало бы показать юзеру
        ограничения не той ноги. Рынок со status="closed" вообще не торговается."""
        self.assertEqual(tb.find_perp("BTC")["market_id"], 1)
        self.assertEqual(
            tb.find_perp("btc-perp")["market_id"], 1, "вписанный тикер нормализуется"
        )
        self.assertIsNone(tb.find_perp("OLD"), "закрытый рынок не находится намеренно")
        self.assertIsNone(tb.find_perp("NOPE"))


class TestStatsFixtureMatchesRealCalc(unittest.TestCase):
    """Фикстура STATS обязана быть формой реального stats_from_candles, иначе
    тесты карточки проверяют выдуманный словарь, а не то, что бот получает от
    Lighter."""

    CANDLES = [
        {"o": 83_000.0, "h": 86_100.0, "l": 82_300.0, "c": 83_000.0, "V": 1_000.0},
        {"o": 83_000.0, "h": 84_500.0, "l": 82_900.0, "c": 84_000.0, "V": 2_000.0},
        {"o": 84_000.0, "h": 84_200.0, "l": 82_300.0, "c": 82_500.0, "V": 400.0},
        {"o": 82_500.0, "h": 84_408.7, "l": 82_500.0, "c": 84_408.7, "V": 500.0},
    ]

    def test_fixture_is_what_the_module_produces(self):
        import lighter_rest

        self.assertEqual(
            sorted(lighter_rest.stats_from_candles(self.CANDLES)),
            sorted(STATS),
        )

    def test_high_low_and_closes_are_derived_from_the_same_window(self):
        import lighter_rest

        stats = lighter_rest.stats_from_candles(self.CANDLES)
        self.assertEqual(stats["high_24h"], 86_100.0)
        self.assertEqual(stats["low_24h"], 82_300.0)
        self.assertEqual(stats["closes"], [83_000.0, 84_000.0, 82_500.0, 84_408.7])
        self.assertEqual(stats["quote_volume_24h"], 3_900.0)

    def test_empty_window_is_empty_dict_not_an_invented_zero(self):
        import lighter_rest

        self.assertEqual(lighter_rest.stats_from_candles([]), {})


class TestPriceReportLines(unittest.TestCase):
    def test_price_report_lines(self):
        got = tb.price_report("BTC", BOOK, STATS, FUNDING)
        self.assertIn("86,100.00 – 82,300.00", got)
        self.assertIn(
            f"Закрытия по часам: {tb.sparkline(STATS['closes'])}",
            got,
            "ряд рисуется по тем же закрытиям, что и число цены",
        )

    def test_report_without_closes_omits_the_row(self):
        stats = dict(STATS)
        stats["closes"] = []
        got = tb.price_report("BTC", BOOK, stats, FUNDING)
        self.assertNotIn("Закрытия по часам", got)


class TestSparkline(unittest.TestCase):
    def test_endpoints_map_to_extremes(self):
        self.assertEqual(tb.sparkline([1.0, 5.0]), "▁█")
        self.assertEqual(
            tb.sparkline([83_000.0, 84_000.0, 82_500.0, 84_408.7]),
            "▃▇▁█",
            "шкала строится по min/max окна, а не по первому и последнему",
        )

    def test_flat_series_draws_a_middle_line(self):
        """Прямая линия — это данные. Пустая строка читалась бы как «свечей нет»."""
        self.assertEqual(tb.sparkline([2.0, 2.0, 2.0]), "▅▅▅")

    def test_short_series_has_no_line_rather_than_one_point(self):
        self.assertEqual(tb.sparkline([2.0]), "")
        self.assertEqual(tb.sparkline([]), "")

    def test_width_cuts_from_the_right(self):
        self.assertEqual(len(tb.sparkline(list(range(1, 40)), width=24)), 24)


class TestTickerParsing(unittest.TestCase):
    def test_common_input_shapes(self):
        for text, expected in (
            ("btc", "BTC"),
            (" BTC ", "BTC"),
            ("BTC-USDC", "BTC"),
            ("ETH/USDC", "ETH"),
            ("1000PEPE", "1000PEPE"),
            ("btcperp", "BTC"),
        ):
            self.assertEqual(tb.parse_ticker(text), expected, text)

    def test_not_a_ticker(self):
        """Текст, который не тикер, обязан возвращать None: fallback отвечает
        «не понял», а не ищет перп с пустым именем."""
        for text in ("привет", "", "/help", "1", "$", "тест BTC", "a" * 20):
            self.assertIsNone(tb.parse_ticker(text), text)


class TestHtmlCard(unittest.TestCase):
    def test_title_and_body_are_escaped(self):
        """Вопрос Predict-рынка набирает куратор, тикер приходит из
        callback_data: без экранирования их текст стал бы разметкой сообщения."""
        got = tb.card("<b>заголовок</b>", "цена < 1 & > 0")
        self.assertEqual(
            got,
            "<b>&lt;b&gt;заголовок&lt;/b&gt;</b>\n<pre>цена &lt; 1 &amp; &gt; 0</pre>",
        )

    def test_note_is_authored_text_not_client_text(self):
        """Тело и заголовок экранируются всегда; сноску пишет код модуля, и она
        вправе содержать разметку. Чужих строк в аргумент note нет ни у одного
        вызова ниже — туда передаются только константы этого модуля."""
        got = tb.card("t", "body", "доля <code>YES</code>")
        self.assertTrue(got.endswith("доля <code>YES</code>"))

    def test_predict_question_cannot_inject_markup(self):
        """Вопрос рынка набирает куратор. Без экранирования его текст стал бы
        разметкой сообщения всем, кто спросит бота."""
        rows = [
            {
                "question": "<b>клик</b> <a href=x>сюда</a>",
                "status": "open",
                "price_yes": 0.5,
                "volume_usd": 0.0,
                "trade_count": 0,
            }
        ]
        got = tb.card("Predict", tb.predict_report(rows))
        self.assertIn("&lt;b&gt;клик&lt;/b&gt;", got)
        self.assertNotIn("<a href", got)

    def test_numbers_survive_without_markup(self):
        self.assertIn(
            "84,408.70", tb.card("BTC", tb.price_report("BTC", BOOK, STATS, FUNDING))
        )


class TestKeyboards(unittest.TestCase):
    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)

    def test_http_miniapp_url_drops_the_web_app_button(self):
        """Bot API отбраковывает web_app с http: с локальным адресом падал бы
        ЦЕЛЫЙ ответ с клавиатурой, а не только кнопка."""
        tb.WAKE_MINIAPP_URL = "http://localhost:5173/"
        self.assertIsNone(tb.web_app_button())
        rows = tb.nav_keyboard().inline_keyboard
        self.assertNotIn("Открыть Wake", [b.text for row in rows for b in row])

    def test_https_miniapp_url_adds_one_web_app_row(self):
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"
        rows = tb.nav_keyboard().inline_keyboard
        last = rows[-1]
        self.assertEqual(len(last), 1)
        self.assertEqual(last[0].web_app.url, "https://wake-7k6.pages.dev/")

    def test_navigation_is_always_present(self):
        rows = tb.nav_keyboard().inline_keyboard
        self.assertEqual(
            [b.callback_data for b in rows[0]],
            ["c:markets", "c:funding", "c:predict"],
        )

    def test_ticker_rows_are_four_wide_and_capped(self):
        rows = tb.ticker_rows(
            ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX"]
        )
        self.assertEqual(
            [len(r) for r in rows], [4, 4], "восьми кнопок достаточно, ряды по 4"
        )
        self.assertEqual(rows[0][0].callback_data, "p:BTC")

    def test_unsafe_callback_values_are_not_made_into_buttons(self):
        """Кнопка с текстом вида "<script>" или с длинным значением ушла бы в
        callback_data, откуда её вернёт клиент."""
        self.assertEqual(
            tb.ticker_rows(["<script>", "x" * 30, "", "BTC"]),
            [[tb.InlineKeyboardButton(text="BTC", callback_data="p:BTC")]],
        )


class TestPayloads(unittest.TestCase):
    """Хендлеры — обвязка над этими функциями: они собирают текст и клавиатуру,
    не трогая Telegram. Данные подставляются фикстурами формы живого ответа."""

    OVERVIEW = {
        "network": "mainnet",
        "ranked_by": "quote_volume_24h",
        "count": 2,
        "rows": [
            {
                "symbol": "BTC",
                "price": 84408.7,
                "change_24h": -0.002,
                "quote_volume_24h": 847_828_634.0,
            },
            {
                "symbol": "ETH",
                "price": 2660.34,
                "change_24h": -0.0138,
                "quote_volume_24h": 350_475_314.0,
            },
        ],
        "no_market": [],
        "no_data": [],
    }

    FUNDING_ROWS = [
        {"exchange": "lighter", "market_id": 1, "symbol": "BTC", "rate": "0.00008"},
        {"exchange": "lighter", "market_id": 0, "symbol": "ETH", "rate": "-0.00005"},
        {"exchange": "bybit", "market_id": 1, "symbol": "BTC", "rate": "0.0001"},
    ]

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def _run(self, coro):
        return asyncio.run(coro)

    def test_price_payload_builds_card_and_keyboard(self):
        with (
            patch.object(tb, "find_perp", lambda symbol: BOOK),
            patch.object(tb.lighter_rest, "get_24h_stats", lambda mid: STATS),
            patch.object(tb.lighter_rest, "get_funding_rate", lambda mid: FUNDING),
        ):
            text, keyboard = self._run(tb.price_payload("BTC"))
        self.assertIn("<pre>", text)
        self.assertIn("84,408.70", text)
        self.assertIn("платят лонги", text)
        self.assertTrue(keyboard.inline_keyboard)

    def test_price_payload_without_a_perp_is_not_an_error(self):
        with patch.object(tb, "find_perp", lambda symbol: None):
            text, _ = self._run(tb.price_payload("NOPE"))
        self.assertIn("активного перпа на Lighter нет", text)

    def test_price_payload_survives_a_missing_funding_rate(self):
        with (
            patch.object(tb, "find_perp", lambda symbol: BOOK),
            patch.object(tb.lighter_rest, "get_24h_stats", lambda mid: STATS),
            patch.object(
                tb.lighter_rest, "get_funding_rate", _raise_runtime("нет funding rate")
            ),
        ):
            text, _ = self._run(tb.price_payload("BTC"))
        self.assertIn("нет ставки", text)

    def test_markets_payload_offers_tickers_as_buttons(self):
        with patch.object(
            tb.lighter_rest, "get_market_overview", lambda network=None: self.OVERVIEW
        ):
            text, keyboard = self._run(tb.markets_payload())
        self.assertIn("84,408.70", text)
        self.assertEqual(
            [b.callback_data for b in keyboard.inline_keyboard[0]], ["p:BTC", "p:ETH"]
        )

    def test_funding_payload_uses_the_same_rows_as_the_rest_endpoint(self):
        """Бот считает funding в своём процессе функцией, которой отдаёт
        GET /funding/rates: две копии разбора ставок разъехались бы молча."""
        with patch.object(
            tb.lighter_rest, "get_funding_rates", lambda network=None: self.FUNDING_ROWS
        ):
            text, _ = self._run(tb.funding_payload())
        expected = [
            r for r in funding_rate_rows(self.FUNDING_ROWS) if r["direction"] == "long"
        ]
        self.assertIn(f"{expected[0]['symbol']}", text)
        self.assertNotIn(
            "ETH", text, "отрицательная ставка: там платят шорты, она не показывается"
        )

    def test_predict_payload_names_the_backend_when_it_cannot_reach_it(self):
        async def fail(path):
            raise httpx.ConnectError("connection refused")

        with patch.object(tb, "_get_json", fail):
            text, _ = self._run(tb.predict_payload("open"))
        self.assertIn("Predict недоступен", text)
        self.assertIn("WAKE_BACKEND_URL", text)
        self.assertIn("базе", text, "причина — данные Predict живут в базе Wake")

    def test_predict_payload_renders_markets(self):
        rows = [
            {
                "question": "BTC выше 90k?",
                "status": "open",
                "price_yes": 0.5,
                "volume_usd": 10.0,
                "trade_count": 1,
            }
        ]

        async def ok(path):
            return rows

        with patch.object(tb, "_get_json", ok):
            text, _ = self._run(tb.predict_payload("open"))
        self.assertIn("50% YES", text)


class TestHelpText(unittest.TestCase):
    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)

    def test_lists_the_commands_the_bot_answers(self):
        text = tb.help_text()
        for command in tb.BOT_COMMANDS:
            self.assertIn(f"/{command.command}", text)

    def test_names_the_network_the_numbers_come_from(self):
        self.assertIn(tb.LIGHTER_NETWORK, tb.help_text())

    def test_http_miniapp_says_why_there_is_no_button(self):
        tb.WAKE_MINIAPP_URL = "http://localhost:5173/"
        self.assertIn("https", tb.help_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
