"""python3 -m unittest test_funding_arb -v"""

import unittest
from funding_arb import (
    FundingSnapshot, annualized_yield, base_asset, find_opportunity, funding_by_market,
    pairable_carry_markets, size_delta_neutral_position, snapshot_from_signed_rate,
    HOURS_PER_YEAR,
)


class TestAnnualization(unittest.TestCase):
    def test_uses_hourly_epoch_not_eight_hour(self):
        """Тот самый факт, ради которого этот модуль вообще написан отдельно:
        перепутать 1-часовой эпох с 8-часовым — недооценить APR в 8 раз."""
        self.assertEqual(HOURS_PER_YEAR, 24 * 365)
        self.assertNotEqual(HOURS_PER_YEAR, 3 * 365, "это была бы ошибка 8-часового эпоха, не 1-часового")

    def test_annualized_yield_basic_math(self):
        snap = FundingSnapshot(market_id=0, symbol="BTC", hourly_rate=0.0001, direction="long")
        apy = annualized_yield(snap)
        self.assertAlmostEqual(apy, 0.0001 * 24 * 365, places=9)

    def test_small_hourly_rate_compounds_to_meaningful_apy(self):
        # 0.01%/час звучит крошечно, но на 1-часовом эпохе это реально ~87% годовых —
        # именно поэтому неверный эпох искажает картину так сильно.
        snap = FundingSnapshot(market_id=0, symbol="BTC", hourly_rate=0.0001, direction="long")
        apy = annualized_yield(snap)
        self.assertGreater(apy, 0.5, "0.01%/час на часовом эпохе даёт куда больше 50% годовых")


class TestOpportunityDetection(unittest.TestCase):
    def test_positive_funding_above_threshold_found(self):
        snap = FundingSnapshot(market_id=1, symbol="ETH", hourly_rate=0.0005, direction="long")
        opp = find_opportunity(snap, min_annualized_yield=0.05)
        self.assertIsNotNone(opp)
        self.assertEqual(opp.perp_side, "short")
        self.assertTrue(opp.spot_needed)

    def test_below_threshold_not_flagged(self):
        snap = FundingSnapshot(market_id=1, symbol="ETH", hourly_rate=0.000001, direction="long")
        opp = find_opportunity(snap, min_annualized_yield=0.05)
        self.assertIsNone(opp)

    def test_negative_direction_never_flagged_even_if_large(self):
        """Ключевое ограничение, не забытый кейс: shorts-платят-longs требовал бы
        шортить спот (займ актива) — намеренно не поддержано, не тихо неверно посчитано."""
        snap = FundingSnapshot(market_id=1, symbol="ETH", hourly_rate=0.01, direction="short")
        opp = find_opportunity(snap, min_annualized_yield=0.05)
        self.assertIsNone(opp, "negative funding (shorts платят) не должен предлагаться как opportunity")

    def test_threshold_is_configurable_not_hardcoded(self):
        snap = FundingSnapshot(market_id=1, symbol="ETH", hourly_rate=0.0002, direction="long")
        apy = annualized_yield(snap)
        self.assertIsNone(find_opportunity(snap, min_annualized_yield=apy + 0.01))
        self.assertIsNotNone(find_opportunity(snap, min_annualized_yield=apy - 0.01))


class TestPositionSizing(unittest.TestCase):
    def test_splits_capital_evenly_between_legs(self):
        pos = size_delta_neutral_position(
            capital_usd=10000, price=100, perp_size_decimals=2, spot_size_decimals=2,
            perp_min_base_amount=0.01, spot_min_base_amount=0.01,
        )
        self.assertIsNotNone(pos)
        self.assertAlmostEqual(pos.perp_notional_usd, pos.spot_notional_usd, places=1)
        self.assertAlmostEqual(pos.perp_notional_usd, 5000, delta=1)

    def test_rounds_down_never_up(self):
        pos = size_delta_neutral_position(
            capital_usd=1000, price=333.333, perp_size_decimals=0, spot_size_decimals=0,
            perp_min_base_amount=0.001, spot_min_base_amount=0.001,
        )
        self.assertIsNotNone(pos)
        # 500/333.333 = 1.5 -> округление вниз при 0 decimals должно дать 1, не 2
        self.assertLessEqual(pos.perp_base_amount, 1.0)

    def test_returns_none_when_capital_below_minimum_on_either_leg(self):
        pos = size_delta_neutral_position(
            capital_usd=1, price=100000, perp_size_decimals=4, spot_size_decimals=4,
            perp_min_base_amount=0.001, spot_min_base_amount=0.001,
        )
        self.assertIsNone(pos, "капитала на минимальный размер обеих ног не хватает — должно вернуть None, не дробный мусор")

    def test_rejects_invalid_inputs(self):
        self.assertIsNone(size_delta_neutral_position(0, 100, 2, 2, 0.01, 0.01))
        self.assertIsNone(size_delta_neutral_position(1000, 0, 2, 2, 0.01, 0.01))
        self.assertIsNone(size_delta_neutral_position(-500, 100, 2, 2, 0.01, 0.01))


class TestSignedRateBoundary(unittest.TestCase):
    """Живой /funding-rates отдаёт знак в самом числе и не имеет поля direction.
    Здесь проверяется граница, на которой знак превращается в direction."""

    def test_positive_rate_means_longs_pay_shorts(self):
        snap = snapshot_from_signed_rate(1, "BTC", 0.00012)
        self.assertEqual(snap.hourly_rate, 0.00012)
        self.assertEqual(snap.direction, "long")

    def test_negative_rate_is_abs_plus_short_direction(self):
        snap = snapshot_from_signed_rate(1, "BTC", -0.00025)
        self.assertEqual(snap.hourly_rate, 0.00025, "ставка беззнаковая — знак живёт в direction")
        self.assertEqual(snap.direction, "short")

    def test_negative_rate_never_offered_as_opportunity(self):
        """Самая дорогая ошибка на этой границе: молча передать отрицательную
        ставку как direction='long' — предложить шортить перп там, где платят
        шорты. find_opportunity обязан вернуть None независимо от величины."""
        snap = snapshot_from_signed_rate(1, "BTC", -0.05)
        self.assertGreater(annualized_yield(snap), 1.0, "по модулю ставка огромная — дело именно в знаке")
        self.assertIsNone(find_opportunity(snap, min_annualized_yield=0.05))

    def test_zero_rate_is_not_an_opportunity(self):
        self.assertIsNone(find_opportunity(snapshot_from_signed_rate(1, "BTC", 0.0), 0.05))


class TestFundingByMarket(unittest.TestCase):
    """/funding-rates игнорирует query-фильтр по рынку и отдаёт все строки разом,
    несколько площадок на один market_id. Фильтрация по exchange — обязанность
    клиента: без неё под рынком BTC оказывается ставка чужой биржи. В живом ответе
    market_id и rate — числа; строковые варианты тоже должны разбираться, потому
    что orderBooks те же по названию поля отдаёт строками ("0.00007")."""

    ROWS = [
        {"exchange": "lighter", "market_id": 1, "rate": 0.0001, "symbol": "BTC"},
        {"exchange": "hyperliquid", "market_id": 1, "rate": -0.0009, "symbol": "BTC"},
        {"exchange": "lighter", "market_id": 0, "rate": -0.0002, "symbol": "ETH"},
        {"exchange": "binance", "market_id": 0, "rate": 0.0003, "symbol": "ETH"},
    ]

    def test_only_requested_venue_kept(self):
        self.assertEqual(funding_by_market(self.ROWS), {1: 0.0001, 0: -0.0002})
        self.assertEqual(funding_by_market(self.ROWS, venue="bybit"), {})

    def test_values_coerced_to_float_sign_preserved(self):
        got = funding_by_market(self.ROWS, venue="lighter")
        self.assertEqual(got[0], -0.0002)
        self.assertTrue(all(isinstance(v, float) for v in got.values()))
        # Числа в живом ответе; строки — то, что приходит с orderBooks, и то, что
        # клиент обязан переварить, а не уронить на int()/float().
        stringy = [{"exchange": "lighter", "market_id": "7", "rate": "-0.0005", "symbol": "LIT"}]
        self.assertEqual(funding_by_market(stringy), {7: -0.0005})

    def test_malformed_rows_skipped_not_fatal(self):
        rows = self.ROWS + [
            {"exchange": "lighter", "market_id": 5},           # нет rate
            {"exchange": "lighter", "market_id": 6, "rate": ""},
            {"exchange": "lighter", "rate": 0.1},              # нет market_id
        ]
        got = funding_by_market(rows, venue="lighter")
        self.assertEqual(sorted(got), [0, 1], "битые строки пропускаются, валидные — остаются")


class TestBaseAsset(unittest.TestCase):
    """Нормализация ВВОДА, не склейка площадок: замерено на живом /funding-rates,
    что все четыре площадки и так отдают голое имя базового актива. base_asset
    нужен, чтобы запрос, вписанный как "BTC-PERP" или "btcusdt" (привычная
    подписка с чужих бирж), находил те же строки, что и "BTC". У спот-книги
    Lighter конвенция другая — "ETH/USDC" против перпа "ETH", — и её склейка
    опирается на эту же функцию (см. TestPairableCarryMarkets)."""

    def test_every_typed_spelling_reaches_the_same_base(self):
        for raw in ("BTC-PERP", "BTC", "btcusdt", "BTC/USDC", " btc_perp "):
            self.assertEqual(base_asset(raw), "BTC", raw)

    def test_perp_suffix_and_quote_both_stripped(self):
        self.assertEqual(base_asset("ETH-PERP"), "ETH")
        self.assertEqual(base_asset("ETH/USDC"), "ETH")
        self.assertEqual(base_asset("LINKUSDT"), "LINK")
        self.assertEqual(base_asset("AAVE/USDC"), "AAVE")

    def test_ticker_ending_in_a_quote_keeps_name_when_ambiguous(self):
        """"PYUSD" сократится в "PY" — известное ограничение склейки по имени,
        поэтому наружу всегда отдаётся и исходный тикер. Проверено, что это не
        падение и не пустой результат."""
        self.assertEqual(base_asset("PYUSD"), "PY")
        self.assertEqual(base_asset("USDC"), "USDC", "голый стейбл не должен схлопнуться в пустую строку")
        self.assertEqual(base_asset(""), "")


class TestPairableCarryMarkets(unittest.TestCase):
    """Cash-and-carry строится только там, где на одном Lighter есть ОБЕ ноги:
    активный перп и активный спот того же актива за тот же стейбл. Спот приходит
    как 'ETH/USDC', перп — как 'ETH': без приведения к базе пересечение пусто, и
    рабочая страница выглядела бы сломанной."""

    BOOKS = [
        {"market_id": 0, "symbol": "ETH", "market_type": "perp", "status": "active",
         "min_base_amount": "0.0050", "supported_size_decimals": 3},
        {"market_id": 2048, "symbol": "ETH/USDC", "market_type": "spot", "status": "active",
         "min_base_amount": "0.0010", "supported_size_decimals": 4},
        {"market_id": 1, "symbol": "BTC", "market_type": "perp", "status": "active",
         "min_base_amount": "0.00007", "supported_size_decimals": 5},
        {"market_id": 2057, "symbol": "BTC/USDT", "market_type": "spot", "status": "active",
         "min_base_amount": "0.001", "supported_size_decimals": 4},
        {"market_id": 8, "symbol": "LINK", "market_type": "perp", "status": "active",
         "min_base_amount": "0.1", "supported_size_decimals": 1},
        {"market_id": 2050, "symbol": "LINK/USDC", "market_type": "spot", "status": "inactive",
         "min_base_amount": "0.1", "supported_size_decimals": 2},
    ]

    def test_pairs_spot_to_perp_by_base(self):
        legs = pairable_carry_markets(self.BOOKS)
        self.assertEqual([l.symbol for l in legs], ["ETH"])
        self.assertEqual((legs[0].perp_market_id, legs[0].spot_market_id), (0, 2048))

    def test_min_sizes_and_decimals_from_both_legs(self):
        leg = pairable_carry_markets(self.BOOKS)[0]
        self.assertEqual((leg.perp_min_base_amount, leg.spot_min_base_amount), (0.005, 0.001))
        self.assertEqual((leg.perp_size_decimals, leg.spot_size_decimals), (3, 4))

    def test_wrong_quote_and_inactive_excluded(self):
        """BTC-перп с BTC/USDT спотом — не пара для USDC-маржи; неактивная книга
        не принимает ордера, показывать её как возможность значит врать про
        ликвидность."""
        legs = pairable_carry_markets(self.BOOKS)
        self.assertNotIn("BTC", [l.symbol for l in legs])
        self.assertNotIn("LINK", [l.symbol for l in legs])

    def test_result_sorted_and_ids_are_ints(self):
        books = self.BOOKS + [
            {"market_id": 30, "symbol": "UNI", "market_type": "perp", "status": "active",
             "min_base_amount": "0.1", "supported_size_decimals": 2},
            {"market_id": 2051, "symbol": "UNI/USDC", "market_type": "spot", "status": "active",
             "min_base_amount": "0.05", "supported_size_decimals": 2},
        ]
        legs = pairable_carry_markets(books)
        self.assertEqual([l.symbol for l in legs], ["ETH", "UNI"])
        self.assertIsInstance(legs[1].perp_market_id, int)

    def test_empty_book_yields_no_pairs(self):
        self.assertEqual(pairable_carry_markets([]), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
