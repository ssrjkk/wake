"""
Клиент Lighter REST: как строится запрос, что повторяется, а что нет, и какие
свечи вообще годны для денег.

python3 -m unittest test_lighter_rest -v

Сеть не трогается: подменяется urllib.request.urlopen, и тесты видят ровно те
URL, которые ушли бы наружу, и ровно тот JSON, который вернула бы биржа. Формы
ответов взяты из живых замеров mainnet (поле V — quote-объём свечи, t — начало
интервала, кратное разрешению; market_id и размеры приходят строками).

Проверяются пять вещей, за которые отвечает этот файл:

  - адрес аккаунта кодируется, а не вставляется в query как есть;
  - у ответа биржи один язык отказа: не-JSON и не-словарь — RuntimeError;
  - повторяются только 5xx и сетевые сбои, 4xx — нет (иначе закрытый эндпоинт
    висит 3.5 с и жрёт квоту, а на 429 просит ещё);
  - из свечного ряда в расчёт берутся только конечные положительные цены,
    потому что одно "NaN" стоило бы 500 на весь обзор;
  - оракул резолюции берёт минуту, которая закончилась не позже дедлайна, а не
    минуту, которая начинается в дедлайн.
"""

import json
import math
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

# Тестовое окружение раньше config: lighter_rest читает LIGHTER_* при импорте.
import testsupport  # noqa: E402, F401
import cache  # noqa: E402
import lighter_rest  # noqa: E402

MAINNET_HOST = "mainnet.zklighter.elliot.ai"
MINUTE_MS = 60_000
HOUR_MS = 3_600_000


class Transport:
    """Очередь ответов. Последний элемент повторяется, если попыток больше."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.urls = []

    def __call__(self, req, timeout=None):
        self.urls.append(req.full_url)
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(item, Exception):
            raise item
        return _Response(json.dumps(item).encode())


class _Response:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def http_error(code):
    return urllib.error.HTTPError(
        f"https://{MAINNET_HOST}/api/v1/x", code, "err", None, None
    )


def candle(t_ms, open_, high, low, close, volume, resolution=HOUR_MS):
    """Форма живой свечи Lighter: ts в мс, цены и объём — строками."""
    return {
        "t": t_ms,
        "o": str(open_),
        "h": str(high),
        "l": str(low),
        "c": str(close),
        "V": str(volume),
        "resolution": resolution,
    }


class TestUrlBuilding(unittest.TestCase):
    def test_known_network_and_unknown_one(self):
        self.assertEqual(
            lighter_rest._base("mainnet"), f"https://{MAINNET_HOST}/api/v1"
        )
        with self.assertRaises(ValueError) as ctx:
            lighter_rest._base("mastnet")
        self.assertIn("mainnet", str(ctx.exception))
        self.assertIn("testnet", str(ctx.exception))

    def test_l1_address_is_percent_encoded_in_the_query(self):
        """Значение идёт в query. Адрес сюда приходит уже проверенным
        (wallet_auth.normalize_address), но функция строит URL, а не разбирает
        вход: без кодирования `&value=` внутри адреса переписал бы сам запрос."""
        address = "0xA238CB&value=18D19F6A88"
        transport = Transport({"accounts": [{"index": "42"}]})
        with patch("urllib.request.urlopen", transport):
            index = lighter_rest.get_account_index_by_l1(address, "mainnet")
        self.assertEqual(index, 42)
        url = transport.urls[0]
        self.assertEqual(url.count("value="), 1, "второй value= появился бы из адреса")
        self.assertIn("value=0xA238CB%26value%3D18D19F6A88", url)

    def test_absent_account_is_none_not_keyerror(self):
        transport = Transport({"accounts": []})
        with patch("urllib.request.urlopen", transport):
            self.assertIsNone(lighter_rest.get_account_index_by_l1("0x0", "mainnet"))


def raw_transport(body: bytes):
    """Транспорт, отдающий ровно переданные байты — для ответов, которые не
    являются валидным JSON-объектом (страница балансировщика, [] на месте
    словаря). Обычный Transport сериализует то, что ему дают, и такую форму не
    воспроизведёт."""

    def transport(req, timeout=None):
        return _Response(body)

    return transport


class TestResponseShape(unittest.TestCase):
    """У источника данных обязан быть ОДИН язык отказа. Роуты ловят RuntimeError
    и отвечают 502; всё, что уходило другим типом, HTTP-слой трактовал иначе:
    JSONDecodeError — подкласс ValueError, а ValueError означает у нас «плохой
    запрос клиента», то есть чужая страница-заглушка превращалась в 400 с текстом
    разбора JSON в ответе. Ответ-список вместо словаря давал AttributeError и 500."""

    def test_non_json_body_is_a_runtime_error(self):
        transport = raw_transport(
            b"<html><body>Lighter is under maintenance</body></html>"
        )
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError) as ctx,
        ):
            lighter_rest._get("https://x/api/v1/orderBooks")
        self.assertIn("не JSON", str(ctx.exception))
        self.assertNotIsInstance(
            ctx.exception, ValueError, "ValueError на HTTP-слое означает 400 клиенту"
        )

    def test_json_array_body_is_a_runtime_error(self):
        """`data.get(...)` выше по стеку рассчитывает на словарь; [].get — это
        AttributeError, то есть 500 вместо «биржа вернула не то»."""
        transport = raw_transport(b'[{"market_id": 1}]')
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError) as ctx,
        ):
            lighter_rest._get("https://x/api/v1/orderBooks")
        self.assertIn("не объект JSON", str(ctx.exception))

    def test_null_list_field_reads_as_empty_not_type_error(self):
        """Ключ может прийти со значением null: `.get(key, [])` в этом случае
        отдаёт None, и обход `for book in None` падал уже в разборе ответа."""
        for name, fn, key in (
            (
                "order_books",
                lambda: lighter_rest.get_order_books("mainnet"),
                "order_books",
            ),
            (
                "funding_rates",
                lambda: lighter_rest.get_funding_rates("mainnet"),
                "funding_rates",
            ),
            ("candles", lambda: lighter_rest.get_candles(1, "1h", 3, "mainnet"), "c"),
        ):
            cache.clear()
            with (
                self.subTest(name),
                patch(
                    "urllib.request.urlopen",
                    raw_transport(json.dumps({key: None}).encode()),
                ),
            ):
                self.assertEqual(fn(), [], f"{name}: null должен читаться как пусто")


class TestRetryPolicy(unittest.TestCase):
    def setUp(self):
        cache.clear()
        self.sleeps = []
        patcher = patch.object(
            lighter_rest.time, "sleep", side_effect=self.sleeps.append
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_client_error_is_not_retried(self):
        transport = Transport(http_error(403))
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest._get(f"https://{MAINNET_HOST}/api/v1/orderBooks")
        self.assertEqual(len(transport.urls), 1, "4xx не долбят квоту")
        self.assertEqual(self.sleeps, [])

    def test_rate_limit_is_not_retried_either(self):
        transport = Transport(http_error(429))
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest._get("https://x/api/v1/a")
        self.assertEqual(len(transport.urls), 1)

    def test_server_error_is_retried_with_backoff(self):
        transport = Transport(http_error(503))
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest._get("https://x/api/v1/a")
        self.assertEqual(len(transport.urls), lighter_rest.MAX_RETRIES)
        self.assertEqual(len(self.sleeps), lighter_rest.MAX_RETRIES - 1)
        # экспоненциальная база плюс джиттер 0..0.5 с: 1 с, 2 с, и пауза растёт
        base = lighter_rest.RETRY_DELAY
        for attempt, delay in enumerate(self.sleeps):
            floor = base * (2**attempt)
            self.assertGreaterEqual(delay, floor)
            self.assertLess(delay, floor + 0.5)
        self.assertGreater(self.sleeps[-1], self.sleeps[0])

    def test_network_error_is_retried_and_then_reported(self):
        transport = Transport(urllib.error.URLError("no route to host"))
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest._get("https://x/api/v1/a")
        self.assertEqual(len(transport.urls), lighter_rest.MAX_RETRIES)

    def test_recovery_after_one_failure_costs_nothing_extra(self):
        transport = Transport(http_error(500), {"ok": 1})
        with patch("urllib.request.urlopen", transport):
            self.assertEqual(lighter_rest._get("https://x/api/v1/a"), {"ok": 1})
        self.assertEqual(len(transport.urls), 2)


class TestCandleRequestShape(unittest.TestCase):
    def setUp(self):
        cache.clear()

    def test_window_is_two_intervals_wider_and_result_is_sliced(self):
        """Lighter отдаёт окно, а не count_back (замер): без запаса в 2 интервала
        отрезалась нужная свеча, а с запасом наружу уходит ровно count штук."""
        rows = [candle(i * HOUR_MS, 1, 2, 0.5, 1.5, 10) for i in range(26)]
        transport = Transport({"c": rows})
        with patch("urllib.request.urlopen", transport):
            got = lighter_rest.get_candles(1, "1h", 24, "mainnet", end_ms=26 * HOUR_MS)
        self.assertEqual(len(got), 24)
        self.assertEqual(got[0]["t"], 2 * HOUR_MS, "лишнее отрезано с головы")
        query = dict(
            p.split("=", 1) for p in transport.urls[0].split("?", 1)[1].split("&")
        )
        self.assertEqual(query["start_timestamp"], str(26 * HOUR_MS - 26 * HOUR_MS))
        self.assertEqual(query["end_timestamp"], str(26 * HOUR_MS))
        self.assertEqual(query["count_back"], "24")
        self.assertEqual(query["resolution"], "1h")

    def test_unknown_resolution_is_not_a_silent_one_minute(self):
        with self.assertRaises(KeyError):
            lighter_rest.get_candles(1, "2h", 5, "mainnet")


class TestCandleUsability(unittest.TestCase):
    """Граница между «у рынка нет цифры» и «из-за этого нет всей страницы»."""

    def test_rows_with_junk_fields_are_dropped_not_propagated(self):
        good = candle(0, "10", "11", "9", "10.5", "100")
        junk = [
            candle(MINUTE_MS, "10", "11", "9", "NaN", "100"),
            candle(2 * MINUTE_MS, "10", "11", "9", None, "100"),
            candle(3 * MINUTE_MS, "10", "11", "9", "0", "100"),
            candle(4 * MINUTE_MS, "10", "11", "9", "inf", "100"),
            candle(5 * MINUTE_MS, "10", "11", "9", "10.5", "-1"),
            candle(6 * MINUTE_MS, "10", "11", "9", "10.5", "7"),  # годная
        ]
        kept = lighter_rest.usable_candles([good, *junk])
        self.assertEqual([c["t"] for c in kept], [0, 6 * MINUTE_MS])

    def test_stats_never_leave_a_non_finite_number(self):
        """Единственное, что действительно нужно от stats_from_candles: ответ
        сериализуется. Starlette бросает ValueError на NaN, и отравленным
        оказывался весь обзор, а не один рынок."""
        stats = lighter_rest.stats_from_candles(
            [
                candle(0, "100", "110", "90", "105", "1000"),
                candle(HOUR_MS, "105", "120", "100", "NaN", "1000"),
                candle(2 * HOUR_MS, "105", "118", "101", "112", "500"),
            ]
        )
        for key, value in stats.items():
            if key == "candles_used":
                continue
            values = value if isinstance(value, list) else [value]
            for v in values:
                self.assertTrue(math.isfinite(v), f"{key}={v}")
        self.assertEqual(stats["candles_used"], 2)
        self.assertAlmostEqual(stats["change_24h"], 112 / 100 - 1)
        self.assertEqual(stats["quote_volume_24h"], 1500)
        self.assertEqual(stats["high_24h"], 118)
        self.assertEqual(stats["low_24h"], 90)

    def test_no_usable_candles_is_empty_stats(self):
        self.assertEqual(lighter_rest.stats_from_candles([]), {})
        self.assertEqual(
            lighter_rest.stats_from_candles([candle(0, "1", "1", "1", "0", "1")]), {}
        )

    def test_get_24h_stats_raises_when_nothing_is_usable(self):
        transport = Transport({"c": [candle(0, "1", "1", "1", "NaN", "1")]})
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest.get_24h_stats(1, "mainnet")


class TestPriceOracle(unittest.TestCase):
    """Резолюция price-рынков: по этим числам люди получают выплаты."""

    def test_candle_starting_at_the_deadline_is_not_used(self):
        """t — начало интервала (замер mainnet 2026-10-24). Свеча с t = дедлайн
        покрывает [дедлайн, дедлайн+1мин): это цены после дедлайна, и при
        разрешении внутри минуты она ещё не закрыта."""
        deadline_ms = 100 * MINUTE_MS
        rows = [
            candle(deadline_ms - 2 * MINUTE_MS, "1", "1", "1", "900", "1"),
            candle(deadline_ms - MINUTE_MS, "1", "1", "1", "1000", "1"),  # [д-1м, д)
            candle(deadline_ms, "1", "1", "1", "1200", "1"),  # [д, д+1м) — будущее
        ]
        transport = Transport({"c": rows})
        with patch("urllib.request.urlopen", transport):
            price = lighter_rest.get_price_at(1, deadline_ms / 1000, "mainnet")
        self.assertEqual(price, 1000.0, "цена на дедлайне, а не после него")

    def test_deadline_inside_a_minute_uses_the_last_completed_one(self):
        deadline_ms = 100 * MINUTE_MS + 30_000
        rows = [
            candle(98 * MINUTE_MS, "1", "1", "1", "800", "1"),
            candle(99 * MINUTE_MS, "1", "1", "1", "850", "1"),  # закончилась в дедлайн
            candle(100 * MINUTE_MS, "1", "1", "1", "999", "1"),  # текущая, не закрыта
        ]
        transport = Transport({"c": rows})
        with patch("urllib.request.urlopen", transport):
            self.assertEqual(
                lighter_rest.get_price_at(1, deadline_ms / 1000, "mainnet"), 850.0
            )

    def test_no_completed_candle_raises_instead_of_inventing_a_price(self):
        deadline_ms = 10 * MINUTE_MS
        rows = [candle(deadline_ms, "1", "1", "1", "700", "1")]
        transport = Transport({"c": rows})
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest.get_price_at(1, deadline_ms / 1000, "mainnet")

    def test_mark_price_refuses_an_empty_series(self):
        transport = Transport({"c": []})
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest.get_mark_price(1, "mainnet")


class TestFundingRateBoundary(unittest.TestCase):
    def setUp(self):
        cache.clear()

    def test_sign_becomes_direction_and_other_venues_are_ignored(self):
        rows = {
            "funding_rates": [
                {
                    "exchange": "hyperliquid",
                    "market_id": 1,
                    "rate": "0.05",
                    "symbol": "LIT",
                },
                {
                    "exchange": "lighter",
                    "market_id": "1",
                    "rate": "-0.0001",
                    "symbol": "BTC",
                },
            ]
        }
        transport = Transport(rows)
        with patch("urllib.request.urlopen", transport):
            got = lighter_rest.get_funding_rate(1, "mainnet")
        self.assertEqual(got["signed_rate"], -0.0001)
        self.assertEqual(got["direction"], "short", "шорты платят — знак в самом числе")
        self.assertEqual(got["rate"], 0.0001, "беззнаковая величина")
        self.assertEqual(got["symbol"], "BTC")

    def test_zero_rate_is_none_direction(self):
        rows = {
            "funding_rates": [
                {"exchange": "lighter", "market_id": 1, "rate": 0, "symbol": "BTC"}
            ]
        }
        transport = Transport(rows)
        with patch("urllib.request.urlopen", transport):
            self.assertEqual(
                lighter_rest.get_funding_rate(1, "mainnet")["direction"], "none"
            )

    def test_market_without_a_row_is_a_clear_error(self):
        rows = {
            "funding_rates": [
                {"exchange": "lighter", "market_id": 9, "rate": 0.01, "symbol": "X"}
            ]
        }
        transport = Transport(rows)
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest.get_funding_rate(1, "mainnet")

    def test_non_numeric_rate_does_not_become_zero(self):
        rows = {
            "funding_rates": [
                {
                    "exchange": "lighter",
                    "market_id": 1,
                    "rate": "нет данных",
                    "symbol": "BTC",
                }
            ]
        }
        transport = Transport(rows)
        with (
            patch("urllib.request.urlopen", transport),
            self.assertRaises(RuntimeError),
        ):
            lighter_rest.get_funding_rate(1, "mainnet")


class TestMarketOverviewDegradation(unittest.TestCase):
    """Один рынок без данных не имеет права стоить обзора целиком — и молча
    исчезать из него тоже не имеет права."""

    def _run(self, symbols, stats_by_id, book):
        with (
            patch.object(lighter_rest, "get_order_books", return_value=book),
            patch.object(lighter_rest, "get_24h_stats") as stats,
        ):
            stats.side_effect = lambda mid, network: stats_by_id[mid]
            cache.clear()
            return lighter_rest.get_market_overview(symbols, "mainnet")

    def test_rows_sorted_and_missing_markets_named(self):
        book = [
            {
                "market_id": "1",
                "symbol": "BTC",
                "market_type": "perp",
                "status": "active",
                "open_interest": "372.658848",
                "min_base_amount": "0.00007",
                "supported_size_decimals": "5",
                "taker_fee": "0.0003",
                "maker_fee": "0.0001",
            },
            {
                "market_id": "2",
                "symbol": "ETH",
                "market_type": "perp",
                "status": "active",
                "open_interest": "100",
                "min_base_amount": "0.001",
                "supported_size_decimals": "3",
                "taker_fee": "0.0003",
                "maker_fee": "0.0001",
            },
            {
                "market_id": "3",
                "symbol": "OLD",
                "market_type": "perp",
                "status": "paused",
                "min_base_amount": "1",
                "supported_size_decimals": "0",
            },
        ]
        stats = {
            1: {"price": 100000.0, "change_24h": 0.02, "quote_volume_24h": 500.0},
            2: {"price": 3000.0, "change_24h": -0.01, "quote_volume_24h": 900.0},
        }
        got = self._run(("BTC", "ETH", "OLD", "DOGE"), stats, book)
        self.assertEqual(
            [r["symbol"] for r in got["rows"]], ["ETH", "BTC"], "по обороту"
        )
        self.assertEqual(
            got["no_market"], ["OLD", "DOGE"], "нет активного перпа — не «нет данных»"
        )
        self.assertEqual(got["count"], 2)
        self.assertEqual(got["ranked_by"], "quote_volume_24h")
        self.assertEqual(got["rows"][0]["market_id"], 2)
        self.assertEqual(got["rows"][0]["size_decimals"], 3, "строка книги -> int")
        self.assertAlmostEqual(got["rows"][1]["open_interest_base"], 372.658848)

    def test_one_failing_market_lands_in_no_data_not_in_a_500(self):
        book = [
            {
                "market_id": "1",
                "symbol": "BTC",
                "market_type": "perp",
                "status": "active",
                "min_base_amount": "0.00007",
                "supported_size_decimals": "5",
            },
            {
                "market_id": "2",
                "symbol": "ETH",
                "market_type": "perp",
                "status": "active",
                "min_base_amount": "0.001",
                "supported_size_decimals": "3",
            },
        ]

        def boom(mid, network):
            if mid == 2:
                raise RuntimeError("нет свечей")
            return {"price": 1.0, "change_24h": 0.0, "quote_volume_24h": 1.0}

        with (
            patch.object(lighter_rest, "get_order_books", return_value=book),
            patch.object(lighter_rest, "get_24h_stats", side_effect=boom),
        ):
            cache.clear()
            got = lighter_rest.get_market_overview(("BTC", "ETH"), "mainnet")
        self.assertEqual([r["symbol"] for r in got["rows"]], ["BTC"])
        self.assertEqual(got["no_data"], ["ETH"])
        self.assertEqual(got["no_market"], [])


class TestCachePreservesIdentity(unittest.TestCase):
    def test_wrapped_functions_keep_their_names_and_docstrings(self):
        """Без functools.wraps у обёртки имя «wrapper»: в логах, в traceback и в
        introspection теряется, какая функция кэшируется."""
        self.assertEqual(lighter_rest.get_order_books.__name__, "get_order_books")
        self.assertIn("leader_listener", lighter_rest.get_order_books.__doc__ or "")
        self.assertEqual(lighter_rest.get_funding_rates.__name__, "get_funding_rates")


if __name__ == "__main__":
    unittest.main(verbosity=2)
