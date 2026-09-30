"""python3 -m unittest test_funding_arb -v"""

import unittest
from funding_arb import (
    FundingSnapshot, annualized_yield, find_opportunity, size_delta_neutral_position, HOURS_PER_YEAR,
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
