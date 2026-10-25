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
from funding_arb import funding_rate_rows, venue_rate_rows


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
            9,
            "/start /help /price /markets /funding /spread /predict /wake и fallback",
        )
        self.assertEqual(
            len(tb.dp.callback_query.handlers),
            7,
            "тикер, три раздела, страница списка, карточка Predict-рынка "
            "и нераспознанный callback последним",
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
        self.assertIn(
            "рынок #1",
            got,
            "market_id — то, по чему рынок ищут в самом Lighter",
        )
        self.assertIn(
            "0.00007",
            got,
            "минимальный размер — из книги, он определяет, что вообще исполнимо",
        )

    def test_price_and_change_share_one_line(self):
        """Цена без изменения читается как «всё спокойно», а изменение без цены —
        как «что-то упало». Пара живёт в одной строке, глаз не ищет её по
        всему блоку."""
        line = next(
            line
            for line in tb.price_report("BTC", BOOK, STATS, FUNDING).splitlines()
            if line.startswith("Цена:")
        )
        self.assertIn("84,408.70", line)
        self.assertIn("-0.20%", line)

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

    def test_note_starts_on_its_own_line(self):
        """Сноска — не строка таблицы: приклеенная к последнему ряду <pre>, она
        читается как его продолжение."""
        got = tb.card("t", "одна\nдве", "ссылка")
        self.assertIn("</pre>\n\nссылка", got)

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
        self.assertEqual(
            last[0].web_app.url, "https://wake-7k6.pages.dev/?tab=terminal"
        )

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

    def test_markets_and_funding_carry_a_text_link_too(self):
        """Кнопка web_app есть не всегда, а сослаться на раздел нужно: ссылка
        остаётся и тогда, когда Telegram её не принимает."""
        url = tb.WAKE_MINIAPP_URL
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", url)
        with (
            patch.object(
                tb.lighter_rest,
                "get_market_overview",
                lambda network=None: self.OVERVIEW,
            ),
            patch.object(
                tb.lighter_rest,
                "get_funding_rates",
                lambda network=None: self.FUNDING_ROWS,
            ),
        ):
            markets, _ = self._run(tb.markets_payload())
            funding, _ = self._run(tb.funding_payload())
        self.assertIn('href="https://wake-7k6.pages.dev/?tab=terminal"', markets)
        self.assertIn('href="https://wake-7k6.pages.dev/?tab=funding"', funding)

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


class TestDeepLink(unittest.TestCase):
    """Кнопка «Открыть Wake» должна вести в тот раздел, о котором сейчас речь, а
    карточка рынка — ещё и на сам рынок."""

    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"

    def test_tab_and_asset(self):
        self.assertEqual(
            tb.miniapp_url("terminal", "BTC"),
            "https://wake-7k6.pages.dev/?tab=terminal&asset=BTC",
        )
        self.assertEqual(
            tb.miniapp_url("funding"), "https://wake-7k6.pages.dev/?tab=funding"
        )

    def test_existing_query_is_extended_not_clobbered(self):
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/?x=1"
        self.assertEqual(
            tb.miniapp_url("predict", "ETH"),
            "https://wake-7k6.pages.dev/?x=1&tab=predict&asset=ETH",
        )

    def test_junk_ticker_is_not_put_into_the_url(self):
        self.assertEqual(
            tb.miniapp_url("terminal", "a" * 40),
            "https://wake-7k6.pages.dev/?tab=terminal",
        )

    def test_http_address_gives_no_link_at_all(self):
        tb.WAKE_MINIAPP_URL = "http://localhost:5173/"
        self.assertEqual(tb.miniapp_url("terminal", "BTC"), "")
        self.assertIsNone(tb.web_app_button("terminal", "BTC"))

    def test_price_card_button_opens_that_market(self):
        with (
            patch.object(tb, "find_perp", lambda symbol: BOOK),
            patch.object(tb.lighter_rest, "get_24h_stats", lambda mid: STATS),
            patch.object(tb.lighter_rest, "get_funding_rate", lambda mid: FUNDING),
        ):
            _, keyboard = asyncio.run(tb.price_payload("BTC"))
        app = [b for row in keyboard.inline_keyboard for b in row if b.web_app]
        self.assertEqual(len(app), 1)
        self.assertIn("tab=terminal", app[0].web_app.url)
        self.assertIn("asset=BTC", app[0].web_app.url)


class TestMarketsPagination(unittest.TestCase):
    def _overview(self, n: int) -> dict:
        return {
            "network": "mainnet",
            "ranked_by": "quote_volume_24h",
            "count": n,
            "rows": [
                {
                    "symbol": f"S{i}",
                    "price": 100 + i,
                    "change_24h": 0.01,
                    "quote_volume_24h": 1_000_000 - i * 1000,
                }
                for i in range(n)
            ],
            "no_market": ["TON"],
            "no_data": [],
        }

    def test_ranks_continue_across_pages(self):
        got = tb.markets_report(self._overview(12), 10, 10)
        self.assertIn("места 11–12 из 12", got)
        self.assertIn("11. S10", got)
        self.assertNotIn(
            "Без активного перпа", got, "подсказка нужна на первой странице"
        )

    def test_second_page_offers_to_go_back(self):
        with patch.object(
            tb.lighter_rest,
            "get_market_overview",
            lambda network=None: self._overview(12),
        ):
            text, keyboard = asyncio.run(tb.markets_payload(10))
        self.assertIn("места 11–12", text)
        data = [b.callback_data for row in keyboard.inline_keyboard for b in row]
        self.assertIn("m:0", data, "назад с второй страницы обязательно")
        self.assertNotIn("m:20", data, "вперёд идти некуда")

    def test_first_page_offers_the_next_one(self):
        with patch.object(
            tb.lighter_rest,
            "get_market_overview",
            lambda network=None: self._overview(12),
        ):
            _, keyboard = asyncio.run(tb.markets_payload(0))
        data = [b.callback_data for row in keyboard.inline_keyboard for b in row]
        self.assertIn("m:10", data)
        self.assertNotIn("m:0", data)

    def test_offset_from_callback_is_parsed_defensively(self):
        """Смещение приходит из callback_data — клиент может прислать что угодно."""
        for raw in ("m:", "m:abc", "m:-5"):
            with self.subTest(raw=raw):
                self.assertTrue(raw.startswith("m:"))
                try:
                    offset = max(0, int(raw.removeprefix("m:")))
                except ValueError:
                    offset = None
                self.assertIn(offset, (0, None))


class TestSpread(unittest.TestCase):
    ROWS = [
        {"exchange": "lighter", "market_id": 1, "symbol": "BTC", "rate": 0.00008},
        {"exchange": "bybit", "market_id": 1, "symbol": "BTC-PERP", "rate": 0.0001},
        {"exchange": "hyperliquid", "market_id": 1, "symbol": "BTC", "rate": -0.00002},
        {"exchange": "lighter", "market_id": 2, "symbol": "ETH", "rate": 0.0003},
    ]

    def test_venues_side_by_side_sorted_by_rate(self):
        got = tb.spread_report("BTC", venue_rate_rows(self.ROWS, "BTC"))
        lines = [line for line in got.splitlines() if line.startswith("•")]
        self.assertEqual(len(lines), 3, "ETH — другой актив")
        self.assertTrue(lines[0].startswith("• bybit"), lines[0])
        self.assertIn("платят лонги", lines[0])
        self.assertIn("платят шорты", lines[-1])

    def test_no_spread_claim(self):
        """Годовую из этих чисел выводить нельзя: эпохи у площадок разные."""
        got = tb.spread_report("BTC", venue_rate_rows(self.ROWS, "BTC"))
        self.assertIn("справка, не спред", got)
        self.assertNotIn("годовых", got)

    def test_missing_symbol_says_so(self):
        self.assertIn("Ставок funding по DOGE нет", tb.spread_report("DOGE", []))

    def test_payload_uses_the_shared_parser(self):
        with patch.object(
            tb.lighter_rest, "get_funding_rates", lambda network=None: self.ROWS
        ):
            text, _ = asyncio.run(tb.spread_payload("btc"))
        self.assertIn("bybit", text)
        self.assertIn("hyperliquid", text)


MARKET_ID = "3f0a6d2c-9b1e-4c7a-8d5f-2e6b1a0c9d44"

PREDICT_MARKET = {
    "id": MARKET_ID,
    "kind": "price",
    "question": "BTC выше 90k к 5 октября?",
    "lighter_market_id": 1,
    "threshold": 90000.0,
    "comparator": ">=",
    "resolve_at": 1_760_000_000.0,
    "b": 100.0,
    "q_yes": 12.0,
    "q_no": -8.0,
    "status": "open",
    "outcome": None,
    "resolved_by": None,
    "evidence_url": None,
    "price_yes": 0.5498,
    "price_no": 0.4502,
    "max_subsidy": 69.31,
    "volume_usd": 1234.5,
    "trade_count": 7,
}


class TestPredictMarketCard(unittest.TestCase):
    """Карточка одного Predict-рынка: то, чего нет в списке."""

    NOW = datetime.datetime(2026, 10, 3, 12, 0, tzinfo=datetime.timezone.utc)

    def test_open_market_shows_both_sides_and_the_condition(self):
        got = tb.predict_market_report(PREDICT_MARKET, now=self.NOW)
        self.assertIn("Состояние: открыт", got)
        self.assertIn("YES 55¢ · NO 45¢", got)
        self.assertIn(">= 90,000", got, "порог — из таблицы, а не из текста вопроса")
        self.assertIn("рынок #1", got)
        self.assertIn("сделок 7", got)
        self.assertIn("$1.2K", got)

    def test_resolved_market_shows_outcome_instead_of_price(self):
        """Цена закрытого рынка читается как «ещё можно зайти», а зайти нельзя:
        бэкенд отказывает по дедлайну."""
        closed = dict(
            PREDICT_MARKET,
            status="resolved",
            outcome="yes",
            resolved_by="curator",
        )
        got = tb.predict_market_report(closed, now=self.NOW)
        self.assertIn("Состояние: закрыт", got)
        self.assertIn("Исход: yes", got)
        self.assertIn("Закрыл: curator", got)
        self.assertNotIn("YES 55¢", got)
        self.assertNotIn("До закрытия", got)

    def test_event_market_has_no_fake_condition(self):
        event = dict(PREDICT_MARKET, kind="event", threshold=None, comparator=None)
        self.assertNotIn("Условие:", tb.predict_market_report(event, now=self.NOW))

    def test_evidence_note_only_for_https_and_shows_the_same_address(self):
        got = tb.evidence_note("https://example.com/report")
        self.assertIn('href="https://example.com/report"', got)
        self.assertIn(">https://example.com/report<", got)

    def test_evidence_note_refuses_to_hide_a_link(self):
        # Не-https и адрес с кавычкой/пробелом не становятся разметкой: текст
        # набирает куратор.
        for url in (
            "",
            None,
            "http://example.com",
            "javascript:alert(1)",
            'https://x"onmouseover="y',
        ):
            self.assertEqual(tb.evidence_note(url), "", url)

    def test_buttons_carry_the_market_id_and_a_readable_label(self):
        rows = tb.predict_buttons([PREDICT_MARKET])
        self.assertEqual(len(rows), 1, "вопрос длинный — по одной кнопке в ряду")
        button = rows[0][0]
        self.assertEqual(button.callback_data, f"k:{MARKET_ID}")
        self.assertLessEqual(len(button.text), 64, "лимит текста inline-кнопки")

    def test_buttons_skip_a_market_with_an_unsafe_id(self):
        """id возвращается клиентом в callback_data и попадает и в запрос, и в
        ссылку на вебвью — мусорный id не должен доходить ни до одного."""
        bad = dict(PREDICT_MARKET, id="../../admin")
        self.assertEqual(tb.predict_buttons([bad]), [])

    def test_payload_asks_for_one_market_and_links_to_it(self):
        async def ok(path):
            assert path == f"/predict/markets/{MARKET_ID}", path
            return PREDICT_MARKET

        url = tb.WAKE_MINIAPP_URL
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", url)
        with patch.object(tb, "_get_json", ok):
            text, keyboard = asyncio.run(tb.predict_market_payload(MARKET_ID))
        self.assertIn("BTC выше 90k", text)
        app = [b for row in keyboard.inline_keyboard for b in row if b.web_app]
        self.assertEqual(len(app), 1)
        self.assertIn(f"tab=predict&market={MARKET_ID}", app[0].web_app.url)

    def test_payload_names_the_backend_when_it_cannot_reach_it(self):
        async def fail(path):
            raise httpx.ConnectError("connection refused")

        with patch.object(tb, "_get_json", fail):
            text, _ = asyncio.run(tb.predict_market_payload(MARKET_ID))
        self.assertIn("Predict-рынок недоступен", text)
        self.assertIn("WAKE_BACKEND_URL", text)

    def test_callback_refuses_an_id_that_is_not_a_uuid(self):
        """callback_data возвращает клиент, и из этого id строятся и запрос к
        бэкенду, и адрес вебвью: до проверки профиля он не должен дойти ни до
        чего."""
        message = _FakeMessage()
        callback = _FakeCallback("k:../../admin", message=message)
        asyncio.run(tb.cb_predict_market(callback))
        self.assertEqual(message.texts, [], "карточку не отправляли")
        self.assertEqual(callback.log, ["acknowledged"], "но callback отвечен")

    def test_callback_opens_the_market_it_names(self):
        message = _FakeMessage()
        callback = _FakeCallback(f"k:{MARKET_ID}", message=message)

        async def ok(path):
            return PREDICT_MARKET

        with patch.object(tb, "_get_json", ok):
            asyncio.run(tb.cb_predict_market(callback))
        self.assertEqual(len(message.texts), 1)
        self.assertIn("BTC выше 90k", message.texts[0])


class TestListKeyboards(unittest.TestCase):
    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"

    def test_predict_list_offers_its_markets_as_buttons(self):
        async def ok(path):
            return [PREDICT_MARKET]

        with patch.object(tb, "_get_json", ok):
            _, keyboard = asyncio.run(tb.predict_payload("open"))
        callbacks = [
            b.callback_data
            for row in keyboard.inline_keyboard
            for b in row
            if b.callback_data
        ]
        self.assertIn(f"k:{MARKET_ID}", callbacks)

    def test_predict_list_without_the_app_still_says_where_to_trade(self):
        async def ok(path):
            return [PREDICT_MARKET]

        tb.WAKE_MINIAPP_URL = "http://localhost:5173/"
        with patch.object(tb, "_get_json", ok):
            text, _ = asyncio.run(tb.predict_payload("open"))
        self.assertIn("WAKE_MINIAPP_URL", text, "причина отсутствия кнопки")


class TestAppLink(unittest.TestCase):
    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)

    def test_https_address_becomes_a_link_with_the_checked_params(self):
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"
        # «&» в href обязан уйти как &amp;: Telegram набирает сообщения в HTML, и
        # голый «&» он отбраковывает на разборе — сообщение не отправилось бы.
        self.assertEqual(
            tb.app_link("в терминале", "terminal", asset="BTC"),
            '<a href="https://wake-7k6.pages.dev/?tab=terminal&amp;asset=BTC">'
            "в терминале</a>",
        )

    def test_http_address_gives_no_link(self):
        tb.WAKE_MINIAPP_URL = "http://localhost:5173/"
        self.assertEqual(tb.app_link("в терминале", "terminal"), "")

    def test_text_of_the_link_is_escaped(self):
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"
        self.assertNotIn("<b>", tb.app_link("<b>text</b>", "terminal"))


class TestWelcome(unittest.TestCase):
    """Первое сообщение отвечает на «с чего начать». /help перечисляет команды, и
    повторять его в приветствии — значит занимать место, не давая выбора."""

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

    def setUp(self):
        self._url = tb.WAKE_MINIAPP_URL
        self.addCleanup(setattr, tb, "WAKE_MINIAPP_URL", self._url)
        tb.WAKE_MINIAPP_URL = "https://wake-7k6.pages.dev/"

    def test_names_the_top_markets_as_buttons(self):
        with patch.object(
            tb.lighter_rest, "get_market_overview", lambda network=None: self.OVERVIEW
        ):
            text, keyboard = asyncio.run(tb.start_payload())
        self.assertIn("BTC", text)
        self.assertIn("$847.8M", text)
        buttons = [
            b.callback_data
            for row in keyboard.inline_keyboard
            for b in row
            if b.callback_data
        ]
        self.assertIn("p:BTC", buttons)
        self.assertIn("c:markets", buttons, "навигация остаётся и в приветствии")

    def test_survives_a_silent_lighter_without_losing_the_commands(self):
        with patch.object(
            tb.lighter_rest, "get_market_overview", _raise_runtime("Lighter HTTP 500")
        ):
            text, keyboard = asyncio.run(tb.start_payload())
        self.assertIn("не отдан", text)
        self.assertIn("/markets", text, "сказали, где взять список, когда ответит")
        self.assertTrue(keyboard.inline_keyboard)

    def test_body_lines_fit_the_bubble(self):
        """Меряется тело <pre>, а не весь HTML: Telegram переносит обычный текст, и
        строка ссылки в счёт не идёт — обрезается только моноширинное тело."""
        with patch.object(
            tb.lighter_rest, "get_market_overview", lambda network=None: self.OVERVIEW
        ):
            text, _ = asyncio.run(tb.start_payload())
        body = text.split("<pre>")[1].split("</pre>")[0]
        self.assertEqual([line for line in body.splitlines() if len(line) > 62], [])


class TestProfileTexts(unittest.TestCase):
    """Имя и описания ставятся при старте тем же процессом, что и меню команд.
    Лимиты — часть Bot API, и длиннее строку он просто не примет."""

    def test_lengths_stay_inside_the_bot_api_limits(self):
        self.assertLessEqual(len(tb.BOT_NAME), 64)
        self.assertLessEqual(len(tb.BOT_SHORT_DESCRIPTION), 120)
        self.assertLessEqual(len(tb.BOT_DESCRIPTION), 512)

    def test_describe_what_the_bot_does_not_do(self):
        """«Ничего не выставляет» — то, что человек обязан понять до первой
        команды: бот читает публичный API, а не управляет счётом."""
        self.assertIn("не выставляет", tb.BOT_DESCRIPTION)
        self.assertIn("Lighter", tb.BOT_SHORT_DESCRIPTION)

    def test_register_profile_survives_a_refused_write(self):
        """Тексты витрины не торговый путь: отказ Bot API не имеет права ронять
        старт бота."""

        class Refusing:
            async def set_my_name(self, name):
                raise RuntimeError("unauthorized")

            async def set_my_short_description(self, text):
                raise RuntimeError("unauthorized")

            async def set_my_description(self, text):
                raise RuntimeError("unauthorized")

        asyncio.run(tb.register_profile(Refusing()))


class TestHelpSections(unittest.TestCase):
    """Справка собрана из того же кортежа, что и меню Telegram, и разложена по
    разделам: человек ищет не команду, а «где про funding»."""

    def test_every_command_lands_in_exactly_one_section(self):
        names = [name for _, section in tb.HELP_SECTIONS for name in section]
        self.assertEqual(sorted(names), sorted(c.command for c in tb.BOT_COMMANDS))
        self.assertEqual(
            len(names),
            len(set(names)),
            "команда в двух разделах — две строки в справке",
        )

    def test_help_prints_the_descriptions_from_the_menu(self):
        text = tb.help_text()
        for command in tb.BOT_COMMANDS:
            self.assertIn(command.description, text)

    def test_group_menu_only_repeats_known_commands(self):
        menu = {c.command for c in tb.BOT_COMMANDS if c.command in tb.GROUP_COMMANDS}
        self.assertEqual(
            menu, set(tb.GROUP_COMMANDS), "в GROUP_COMMANDS нет неизвестной команды"
        )
        self.assertLess(
            len(menu), len(tb.BOT_COMMANDS), "в группах меню короче личного"
        )

    def test_group_menu_survives_a_refused_write(self):
        class Refusing:
            async def set_my_commands(self, commands, scope=None):
                raise RuntimeError("unauthorized")

        asyncio.run(tb.register_group_menu(Refusing()))


class TestTelegramLineWidth(unittest.TestCase):
    """Telegram набирает <pre> моноширинно и не переносит строки: всё, что длиннее
    пузыря, обрезается без предупреждения. Числовые отчёты поэтому держим в
    границе, и проверяем это, а не надеемся."""

    LIMIT = 62

    def _long_lines(self, text: str) -> list[str]:
        return [line for line in text.splitlines() if len(line) > self.LIMIT]

    def test_price_report_fits(self):
        self.assertEqual(
            self._long_lines(tb.price_report("BTC", BOOK, STATS, FUNDING)), []
        )

    def test_markets_report_fits(self):
        overview = {
            "network": "mainnet",
            "ranked_by": "quote_volume_24h",
            "count": 18,
            "rows": [
                {
                    "symbol": "1000PEPE",
                    "price": 0.0001234,
                    "change_24h": -0.1234,
                    "quote_volume_24h": 9_999_999_999.0,
                }
            ],
            "no_market": [],
            "no_data": [],
        }
        self.assertEqual(self._long_lines(tb.markets_report(overview)), [])

    def test_funding_report_fits(self):
        rates = [
            {
                "symbol": "1000PEPE",
                "hourly_rate": 0.001234,
                "annualized": 108.3,
                "direction": "long",
            }
        ]
        self.assertEqual(self._long_lines(tb.funding_report(rates)), [])
        self.assertEqual(self._long_lines(tb.funding_report([])), [])

    def test_spread_report_fits(self):
        venues = venue_rate_rows(
            [
                {
                    "exchange": "hyperliquid",
                    "market_id": 1,
                    "symbol": "1000PEPE",
                    "rate": 0.0001,
                }
            ],
            "1000PEPE",
        )
        self.assertEqual(self._long_lines(tb.spread_report("1000PEPE", venues)), [])


class _Command:
    """Двойник CommandObject aiogram: хендлерам нужен только атрибут args."""

    def __init__(self, args: str = ""):
        self.args = args


class _FakeMessage:
    """Двойник сообщения ровно на двух методах, которые зовёт обвязка, плюс
    text — его читает fallback, чтобы опознать тикер вместо команды."""

    def __init__(self, log=None, text: str = "BTC"):
        self.log = log if log is not None else []
        self.texts = []
        self.text = text

    async def answer_chat_action(self, action):
        self.log.append("typing")

    async def answer(self, text, reply_markup=None):
        self.log.append("answer")
        self.texts.append(text)


class _FakeCallback:
    def __init__(self, data: str, message=None, log=None):
        self.data = data
        self.message = message
        self.log = log if log is not None else []

    async def answer(self, *args, **kwargs):
        self.log.append("acknowledged")


class TestHandlerFailureBoundary(unittest.TestCase):
    """Хендлер обязан ответить и когда источник данных упал.

    Без границы lighter_rest.RuntimeError (пустой ответ Lighter, битая строка)
    уходил в aiogram: бот молчал, человек не получал ни карточки, ни причины, а
    «молчание» неотличимо от «такого рынка нет»."""

    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)

    def test_markets_handler_answers_when_lighter_fails(self):
        msg = _FakeMessage()
        with patch.object(
            tb.lighter_rest, "get_market_overview", _raise_runtime("Lighter HTTP 500")
        ):
            asyncio.run(tb.cmd_markets(msg))
        self.assertEqual(len(msg.texts), 1, "бот обязан ответить, а не промолчать")
        self.assertIn("данные не получены", msg.texts[0])
        self.assertIn("Lighter HTTP 500", msg.texts[0], "причина — внутри карточки")

    def test_price_handler_survives_a_broken_book(self):
        msg = _FakeMessage()
        with patch.object(tb, "find_perp", _raise_runtime("Expecting value")):
            asyncio.run(tb.cmd_price(msg, _Command(args="btc")))
        self.assertIn("данные не получены", msg.texts[0])

    def test_funding_handler_survives_a_failed_rates_call(self):
        msg = _FakeMessage()
        with patch.object(
            tb.lighter_rest, "get_funding_rates", _raise_runtime("connection reset")
        ):
            asyncio.run(tb.cmd_funding(msg))
        self.assertIn("данные не получены", msg.texts[0])

    def test_predict_handler_survives_an_unexpected_backend_shape(self):
        """predict_report ждёт список рынков. Если бэкенд вернёт другую форму,
        полетит TypeError/KeyError, а не httpx.HTTPError, и прежний except в
        predict_payload этого не ловил — хендлер падал."""

        async def wrong_shape(path):
            return {"detail": "это не список"}

        msg = _FakeMessage()
        with patch.object(tb, "_get_json", wrong_shape):
            asyncio.run(tb.cmd_predict(msg, _Command(args="")))
        self.assertEqual(len(msg.texts), 1)
        self.assertIn("данные не получены", msg.texts[0])

    def test_plain_ticker_message_survives_a_failed_candles_call(self):
        msg = _FakeMessage()
        with (
            patch.object(tb, "find_perp", lambda symbol: BOOK),
            patch.object(
                tb.lighter_rest, "get_24h_stats", _raise_runtime("нет свечей")
            ),
        ):
            asyncio.run(tb.fallback(msg))
        self.assertIn("данные не получены", msg.texts[0])

    def test_failure_card_escapes_exception_text(self):
        card = tb.failure_card("Карточка BTC", RuntimeError("<b>разметка</b> & прочее"))
        self.assertIn("&lt;b&gt;", card, "текст исключения уходит в HTML-сообщение")
        self.assertNotIn("<b>разметка</b>", card)

    def test_unknown_callback_still_answers_and_does_not_raise(self):
        callback = _FakeCallback("p:БТС-НЕ-ТИКЕР")
        asyncio.run(tb.cb_price(callback))
        self.assertEqual(callback.log, ["acknowledged"])


class TestCallbackOrder(unittest.TestCase):
    """Порядок вызовов обвязки — часть контракта Telegram, а не деталь кода."""

    def test_callback_is_acknowledged_before_the_data_is_fetched(self):
        log = []
        callback = _FakeCallback("c:markets", message=_FakeMessage(log=log), log=log)

        async def slow_build():
            log.append("fetch")
            return tb.card("Заголовок", "тело"), tb.nav_keyboard()

        asyncio.run(tb._reply(callback, "Список рынков", slow_build))
        self.assertEqual(
            log[:2],
            ["acknowledged", "fetch"],
            "медленный Lighter не имеет права удерживать не отвеченный callback: "
            "окно ответа ограничено, и позже Telegram отвечает «query is too old»",
        )

    def test_message_replies_typing_then_the_card(self):
        log = []
        msg = _FakeMessage(log=log)

        async def build():
            log.append("fetch")
            return tb.card("Заголовок", "тело"), tb.nav_keyboard()

        asyncio.run(tb._answer(msg, "Список рынков", build))
        self.assertEqual(log, ["typing", "fetch", "answer"])

    def test_message_with_a_failing_builder_still_sends_one_answer(self):
        log = []
        msg = _FakeMessage(log=log)

        async def boom():
            raise RuntimeError("Lighter HTTP 502")

        asyncio.run(tb._answer(msg, "Funding", boom))
        self.assertEqual(log, ["typing", "answer"])
        self.assertIn("данные не получены", msg.texts[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
