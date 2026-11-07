"""Правила кодирования ордеров Arcus — на живых метаданных рынка.

python3 -m unittest test_arcus_orders -v

Фикстуры взяты не из документации про документацию: tickSize/stepSize
сняты с живого ответа https://api.arcus.xyz/v1/markets (замер 2026-11-03),
а форма payload — из executable-гайда площадки
(https://docs.arcus.xyz/guides/rest-trading.md, снимок 2026-11-05). Это тот
случай, где сверка с кодом площадки дороже сверки с текстом: payload
подписывается байт в байт, и расхождение в порядке полей или в единице
времени даёт не «другую цифру», а подпись к другому сообщению.
"""

import json
import math
import random
import unittest
from decimal import Decimal

import arcus_orders as ao

# Живые параметры рынков (mainnet, /v1/markets, 2026-11-03).
BTC = {"marketId": 1, "tickSize": "0.1", "stepSize": "0.00000001"}
ETH = {"marketId": 2, "tickSize": "0.01", "stepSize": "0.0000001"}

ADDRESS_MIXED = "0xAbC1234567890aBcDeF1234567890AbCdEf123456"
NOW_NS = 1_762_300_000_123_456_789
GOOD_TIL_US = 1_788_000_000_000_000


def payload(
    side="BUY",
    price="77497.8",
    size="0.001",
    market=BTC,
    tif="GTT",
    reduce_only=False,
    address=ADDRESS_MIXED,
    good_til_us=GOOD_TIL_US,
):
    return ao.place_order_payload(
        address=address,
        account_index=0,
        market_id=market["marketId"],
        side=side,
        time_in_force=tif,
        price=price,
        size=size,
        tick_size=market["tickSize"],
        step_size=market["stepSize"],
        good_til_us=good_til_us,
        now_ns=NOW_NS,
        reduce_only=reduce_only,
    )


class TestTicks(unittest.TestCase):
    def test_live_tick_and_step_divide_their_own_prices(self):
        self.assertEqual(ao.to_ticks("77497.8", BTC["tickSize"]), 774978)
        self.assertEqual(ao.to_ticks("0.001", BTC["stepSize"]), 100_000)
        self.assertEqual(ao.to_ticks("2262.62", ETH["tickSize"]), 226262)

    def test_price_off_the_tick_is_refused_not_rounded(self):
        # Живой mid BTC-USD был 77497.85 — не кратен тику 0.1. Молча округлить
        # его значило бы отправить ордер по цене, которую человек не видел.
        with self.assertRaises(ValueError) as ctx:
            ao.to_ticks("77497.85", BTC["tickSize"])
        self.assertIn("не кратно", str(ctx.exception))

    def test_float_and_string_forms_agree(self):
        self.assertEqual(ao.to_ticks(77497.8, 0.1), ao.to_ticks("77497.8", "0.1"))

    def test_garbage_never_becomes_a_tick_count(self):
        for bad in (float("nan"), float("inf"), float("-inf"), "NaN", "abc", None):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    ao.to_ticks(bad, "0.1")

    def test_zero_and_negative_orders_are_refused(self):
        # Площадка требует «positive decimal string». Пропущенный ноль дал бы
        # подписанный ордер размером 0 — отправленную пустоту, а не отказ.
        for bad in (0, 0.0, "0", -1.0, "-0.1", Decimal("0")):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    ao.to_ticks(bad, "0.1")

    def test_huge_value_survives_as_an_integer_not_as_a_float(self):
        # Потолок размера — серверный (у площадки есть ошибка OrderSizeTooLarge),
        # и здесь его не выдумывают. Важно другое: число не должно потерять
        # точность в float64 по дороге в подпись.
        self.assertEqual(ao.to_ticks(10**400, "0.1"), 10**401)

    def test_non_positive_step_is_refused(self):
        for step in ("0", "-0.1", 0):
            with self.subTest(step=step):
                with self.assertRaises(ValueError):
                    ao.to_ticks("1", step)


class TestSnap(unittest.TestCase):
    def test_snaps_to_nearest_tick(self):
        self.assertEqual(ao.snap_to_tick("77497.844", "0.1"), Decimal("77497.8"))
        self.assertEqual(ao.snap_to_tick("77497.849", "0.1"), Decimal("77497.8"))
        self.assertEqual(ao.snap_to_tick("77497.851", "0.1"), Decimal("77497.9"))

    def test_snapped_price_survives_to_ticks(self):
        # Округление обязано давать значение, которое движок примет: snap →
        # to_ticks — тот же самый целый тик, без «не кратно».
        for raw, tick in (
            ("77497.844", "0.1"),
            ("77497.849", "0.01"),
            ("0.000000049", "0.00000001"),
            ("2262.617", "0.01"),
            ("2262.617", "0.0000001"),
        ):
            with self.subTest(raw=raw, tick=tick):
                snapped = ao.snap_to_tick(raw, tick)
                self.assertIsInstance(ao.to_ticks(snapped, tick), int)

    def test_price_below_one_tick_is_refused(self):
        # 0.000000049 при тике 0.1 округляется до нуля: подписывать ордер по
        # нулевой цене нельзя, даже если rounding до него законно.
        with self.assertRaises(ValueError):
            ao.snap_to_tick("0.000000049", "0.1")

    def test_wire_strings_never_print_in_exponent_form(self):
        # Decimal печатает мелкое значение как «5E-8» — это его собственный
        # формат, а не формат протокола. На провод обязано выходить «0.00000005»,
        # иначе подпись будет считана по числу, которое площадка не обязана
        # понимать.
        snapped = ao.snap_to_tick("0.000000049", "0.00000001")
        self.assertEqual(str(snapped), "5E-8")  # так Decimal видит сам себя
        body = ao.place_order_body(
            address=ADDRESS_MIXED,
            account_index=0,
            market_id=1,
            side="BUY",
            order_type="LIMIT",
            price=snapped,
            size=Decimal("0.00000001"),
            time_in_force="GTT",
            good_til_us=GOOD_TIL_US,
            now_ns=NOW_NS,
        )
        self.assertEqual(body["price"], "0.00000005")
        self.assertEqual(body["quantity"], "0.00000001")


class TestPlacePayload(unittest.TestCase):
    def test_payload_matches_the_documented_shape(self):
        self.assertEqual(
            payload(),
            '{"ad":"0xabc1234567890abcdef1234567890abcdef123456","ai":0,'
            f'"ct":{NOW_NS},"g":{GOOD_TIL_US * 1000},"m":1,"op":1,'
            '"p":774978,"q":100000,"r":0,"s":0,"t":0,"v":1}',
        )

    def test_body_and_payload_carry_the_same_moment_in_their_own_units(self):
        body = ao.place_order_body(
            address=ADDRESS_MIXED,
            account_index=0,
            market_id=1,
            side="BUY",
            order_type="LIMIT",
            price="77497.8",
            size="0.001",
            time_in_force="GTT",
            good_til_us=GOOD_TIL_US,
            now_ns=NOW_NS,
        )
        signed = json.loads(payload())
        self.assertEqual(body["goodTilTime"], str(GOOD_TIL_US))
        self.assertEqual(signed["g"], GOOD_TIL_US * 1000)
        self.assertEqual(body["timestamp"], signed["ct"])

    def test_address_is_lowercase_in_payload_and_untouched_in_body(self):
        signed = json.loads(payload())
        body = ao.place_order_body(
            address=ADDRESS_MIXED,
            account_index=0,
            market_id=1,
            side="BUY",
            order_type="LIMIT",
            price="77497.8",
            size="0.001",
            time_in_force="GTT",
            good_til_us=GOOD_TIL_US,
            now_ns=NOW_NS,
        )
        self.assertEqual(signed["ad"], ADDRESS_MIXED.lower())
        self.assertEqual(body["address"], ADDRESS_MIXED)

    def test_reduce_only_and_side_and_tif_are_wire_values(self):
        signed = json.loads(payload(side="SELL", tif="IOC", reduce_only=True))
        self.assertEqual((signed["s"], signed["t"], signed["r"]), (1, 2, 1))

    def test_unknown_wire_names_are_refused(self):
        for kwargs in ({"side": "HOLD"}, {"tif": "GTC"}):
            with self.subTest(**kwargs):
                with self.assertRaises(ValueError):
                    payload(**kwargs)

    def test_address_must_look_like_an_address(self):
        for bad in ("abc", "", None, 12):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    payload(address=bad)


class TestCancelPayload(unittest.TestCase):
    def test_cancel_payload_has_no_price_fields(self):
        self.assertEqual(
            ao.cancel_order_payload(
                address=ADDRESS_MIXED,
                account_index=3,
                order_id="8123",
                market_id=1,
                now_ns=NOW_NS,
            ),
            '{"ad":"0xabc1234567890abcdef1234567890abcdef123456","ai":3,'
            f'"ct":{NOW_NS},"id":"8123","m":1,"op":2,"v":1}}',
        )

    def test_empty_order_id_is_refused(self):
        with self.assertRaises(ValueError):
            ao.cancel_order_payload(
                address=ADDRESS_MIXED,
                account_index=0,
                order_id="",
                market_id=1,
                now_ns=NOW_NS,
            )


class TestGuards(unittest.TestCase):
    def test_market_order_must_be_ioc(self):
        with self.assertRaises(ValueError):
            ao.place_order_body(
                address=ADDRESS_MIXED,
                account_index=0,
                market_id=1,
                side="BUY",
                order_type="MARKET",
                price="77497.8",
                size="0.001",
                time_in_force="GTT",
                good_til_us=GOOD_TIL_US,
                now_ns=NOW_NS,
            )

    def test_good_til_time_refuses_less_than_a_month(self):
        with self.assertRaises(ValueError):
            ao.good_til_time(1_762_300_000.0, days=30)
        moment = ao.good_til_time(1_762_300_000.0)
        self.assertEqual(moment, (1_762_300_000 + 31 * 86_400) * 1_000_000)

    def test_market_bound_is_ten_percent_either_way(self):
        self.assertEqual(ao.market_price_bound("100", "BUY"), Decimal("110"))
        self.assertEqual(ao.market_price_bound("100", "SELL"), Decimal("90"))

    def test_market_bound_refuses_a_mark_that_is_not_a_price(self):
        for bad in ("0", "-1", float("nan"), float("inf")):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    ao.market_price_bound(bad, "BUY")
        with self.assertRaises(ValueError):
            ao.market_price_bound("100", "HOLD")

    def test_min_notional_applies_except_to_reduce_only(self):
        self.assertFalse(ao.notional_ok("100", "0.001"))
        self.assertTrue(ao.notional_ok("100", "0.05"))
        self.assertTrue(ao.notional_ok("100", "0.001", reduce_only=True))


class TestPayloadInvariants(unittest.TestCase):
    """Инварианты на псевдослучайных входах с зерном: одна проверка на всё
    сразу, а не три примера, которые повезло выбрать."""

    def test_every_generated_order_round_trips_through_the_engine_units(self):
        rng = random.Random(20261105)
        for _ in range(2000):
            market = rng.choice([BTC, ETH])
            tick_count = rng.randint(1, 10**7)
            step_count = rng.randint(1, 10**6)
            price = Decimal(tick_count) * Decimal(market["tickSize"])
            size = Decimal(step_count) * Decimal(market["stepSize"])
            signed = json.loads(payload(price=price, size=size, market=market))
            self.assertIsInstance(signed["p"], int)
            self.assertIsInstance(signed["q"], int)
            self.assertEqual(signed["p"], tick_count)
            self.assertEqual(signed["q"], step_count)

    def test_garbage_inputs_never_produce_a_payload(self):
        rng = random.Random(20261106)
        junk = [
            float("nan"),
            float("inf"),
            float("-inf"),
            -1.0,
            0.0,
            "abc",
            "NaN",
            None,
            Decimal("0"),
        ]
        for _ in range(400):
            price = rng.choice(junk)
            size = rng.choice(junk)
            with self.subTest(price=price, size=size):
                with self.assertRaises(ValueError):
                    payload(price=price, size=size)

    def test_field_order_is_stable_across_builds(self):
        # Подпись считается по байтам: порядок ключей в payload — часть
        # протокола, и dict здесь не должен начать зависеть от вставки.
        keys = list(json.loads(payload()).keys())
        self.assertEqual(
            keys, ["ad", "ai", "ct", "g", "m", "op", "p", "q", "r", "s", "t", "v"]
        )

    def test_no_float_artifacts_in_the_signed_bytes(self):
        # 0.1+0.2 как float даёт 0.30000000000000004; в подписи такого быть не
        # должно ни в p, ни в q — там целые, а в теле — строка без хвоста.
        text = payload(price="2262.62", size="0.1", market=ETH)
        self.assertNotIn(".", text)
        self.assertTrue(math.isfinite(float(json.loads(text)["p"])))
