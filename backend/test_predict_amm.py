"""python3 -m unittest test_predict_amm -v"""

import math
import unittest
from predict_amm import LMSRMarket


class TestBasicProperties(unittest.TestCase):
    def test_starts_at_fifty_fifty(self):
        m = LMSRMarket(b=100)
        self.assertAlmostEqual(m.price_yes(), 0.5, places=9)
        self.assertAlmostEqual(m.price_no(), 0.5, places=9)

    def test_prices_always_sum_to_one(self):
        m = LMSRMarket(b=100)
        m.trade("yes", 37)
        m.trade("no", 12)
        self.assertAlmostEqual(m.price_yes() + m.price_no(), 1.0, places=9)

    def test_price_stays_in_valid_range_even_under_extreme_imbalance(self):
        m = LMSRMarket(b=10)
        m.trade("yes", 10_000)  # 1000x параметра ликвидности — намеренно экстремально
        # На таком перекосе истинная (бесконечной точности) цена настолько близка к 1,
        # что float64 законно округляет её ровно до 1.0 — это предел точности double,
        # не баг формулы. <=1.0, не <1.0, и это задокументированное поведение, не тихо
        # смягчённый тест.
        self.assertGreater(m.price_yes(), 0.0)
        self.assertLessEqual(m.price_yes(), 1.0)

    def test_price_strictly_between_zero_and_one_at_realistic_scale(self):
        m = LMSRMarket(b=100)
        m.trade("yes", 200)  # крупная, но реалистичная сделка относительно ликвидности
        self.assertGreater(m.price_yes(), 0.0)
        self.assertLess(m.price_yes(), 1.0)

    def test_buying_yes_increases_yes_price(self):
        m = LMSRMarket(b=100)
        before = m.price_yes()
        m.trade("yes", 20)
        self.assertGreater(m.price_yes(), before)

    def test_buying_no_decreases_yes_price(self):
        m = LMSRMarket(b=100)
        before = m.price_yes()
        m.trade("no", 20)
        self.assertLess(m.price_yes(), before)


class TestNumericalStability(unittest.TestCase):
    def test_no_overflow_on_large_quantities(self):
        m = LMSRMarket(b=50)
        try:
            m.trade("yes", 50_000)  # naive exp(q/b) = exp(1000) переполнило бы float
            price = m.price_yes()
        except OverflowError:
            self.fail("LMSR переполнился на больших q — naive-формула, не log-sum-exp")
        self.assertTrue(0.0 < price <= 1.0)

    def test_extreme_imbalance_saturates_to_exactly_one_not_nan_or_error(self):
        """Документирует, а не прячет: при достаточном перекосе float64 легитимно
        округляет вероятность ровно до 1.0. Важно не то, что этого не происходит
        (происходит, это предел double), а что это НЕ NaN и не исключение."""
        m = LMSRMarket(b=10)
        m.trade("yes", 10_000)
        self.assertEqual(m.price_yes(), 1.0)
        self.assertFalse(math.isnan(m.price_yes()))

    def test_naive_formula_would_have_overflowed_here_for_contrast(self):
        # Не тест на сам движок — фиксирует ОЖИДАНИЕ, почему стабильная форма вообще нужна.
        with self.assertRaises(OverflowError):
            math.exp(50_000 / 50)  # это именно то, чего избегает _cost()


class TestBuySellRoundTrip(unittest.TestCase):
    def test_buy_then_sell_same_amount_nets_to_zero_cost(self):
        m = LMSRMarket(b=100)
        cost_buy = m.trade("yes", 15)
        cost_sell = m.trade("yes", -15)
        self.assertAlmostEqual(cost_buy + cost_sell, 0.0, places=9)
        self.assertAlmostEqual(m.q_yes, 0.0, places=9)

    def test_state_unchanged_after_round_trip(self):
        m = LMSRMarket(b=100)
        p0 = m.price_yes()
        m.trade("no", 8)
        m.trade("no", -8)
        self.assertAlmostEqual(m.price_yes(), p0, places=9)


class TestLiquidityParameter(unittest.TestCase):
    def test_higher_b_means_smaller_price_impact_for_same_trade(self):
        thin = LMSRMarket(b=10)
        deep = LMSRMarket(b=1000)
        thin.trade("yes", 5)
        deep.trade("yes", 5)
        thin_impact = thin.price_yes() - 0.5
        deep_impact = deep.price_yes() - 0.5
        self.assertGreater(thin_impact, deep_impact)

    def test_rejects_non_positive_b(self):
        with self.assertRaises(ValueError):
            LMSRMarket(b=0)
        with self.assertRaises(ValueError):
            LMSRMarket(b=-5)


class TestCostPreview(unittest.TestCase):
    def test_cost_to_trade_does_not_mutate_state(self):
        m = LMSRMarket(b=100)
        _ = m.cost_to_trade("yes", 25)
        self.assertEqual(m.q_yes, 0.0)
        self.assertEqual(m.q_no, 0.0)

    def test_preview_matches_actual_trade_cost(self):
        m = LMSRMarket(b=100)
        preview = m.cost_to_trade("yes", 25)
        actual = m.trade("yes", 25)
        self.assertAlmostEqual(preview, actual, places=9)

    def test_rejects_invalid_outcome(self):
        m = LMSRMarket(b=100)
        with self.assertRaises(ValueError):
            m.cost_to_trade("maybe", 10)


class TestMaxSubsidy(unittest.TestCase):
    def test_max_subsidy_formula(self):
        m = LMSRMarket(b=100)
        self.assertAlmostEqual(m.max_subsidy(), 100 * math.log(2), places=9)


if __name__ == "__main__":
    unittest.main(verbosity=2)
