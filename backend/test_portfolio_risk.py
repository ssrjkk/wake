"""python3 -m unittest test_portfolio_risk -v"""

import unittest
from portfolio_risk import (
    price_returns, volatility, pearson_correlation, Position,
    portfolio_dollar_volatility, naive_dollar_volatility, diversification_score, suggest_hedge,
)


def make_series(seed_changes: list, start=100.0) -> list:
    prices = [start]
    for c in seed_changes:
        prices.append(prices[-1] * (1 + c))
    return prices


class TestReturnsAndVolatility(unittest.TestCase):
    def test_price_returns_basic(self):
        r = price_returns([100, 110, 99])
        self.assertAlmostEqual(r[0], 0.10, places=6)
        self.assertAlmostEqual(r[1], -0.10, places=6)

    def test_volatility_of_constant_returns_is_zero(self):
        self.assertAlmostEqual(volatility([0.01, 0.01, 0.01, 0.01]), 0.0, places=9)

    def test_volatility_increases_with_spread(self):
        low = volatility([0.01, -0.01, 0.01, -0.01])
        high = volatility([0.10, -0.10, 0.10, -0.10])
        self.assertGreater(high, low)


class TestCorrelation(unittest.TestCase):
    def test_identical_series_correlate_perfectly(self):
        r = [0.01, -0.02, 0.03, -0.01, 0.02]
        self.assertAlmostEqual(pearson_correlation(r, r), 1.0, places=6)

    def test_inverted_series_correlate_negatively(self):
        r = [0.01, -0.02, 0.03, -0.01, 0.02]
        inverted = [-x for x in r]
        self.assertAlmostEqual(pearson_correlation(r, inverted), -1.0, places=6)

    def test_zero_variance_series_returns_zero_not_error(self):
        flat = [0.0, 0.0, 0.0, 0.0]
        other = [0.01, -0.02, 0.03, -0.01]
        self.assertEqual(pearson_correlation(flat, other), 0.0)

    def test_rejects_mismatched_lengths(self):
        with self.assertRaises(ValueError):
            pearson_correlation([0.01, 0.02], [0.01])


class TestPortfolioVolatilityProperties(unittest.TestCase):
    """Это ядро фичи — если эта математика неверна, вся остальная фича врёт пользователю про его риск."""

    def test_single_position_portfolio_vol_equals_naive(self):
        returns = {0: [0.02, -0.01, 0.03, -0.02, 0.01]}
        positions = [Position(0, "BTC", 1000)]
        self.assertAlmostEqual(portfolio_dollar_volatility(positions, returns), naive_dollar_volatility(positions, returns), places=9)

    def test_perfectly_correlated_same_direction_no_diversification_benefit(self):
        # B = A * 2 (детерминированно скоррелировано 1.0)
        a = [0.02, -0.01, 0.03, -0.02, 0.015]
        b = [x * 2 for x in a]
        returns = {0: a, 1: b}
        positions = [Position(0, "A", 1000), Position(1, "B", 1000)]
        score = diversification_score(positions, returns)
        self.assertAlmostEqual(score, 0.0, places=4, msg="идеально скоррелированные позиции не должны давать эффект диверсификации")

    def test_long_and_short_same_asset_fully_cancels(self):
        returns = {0: [0.02, -0.01, 0.03, -0.02, 0.015]}
        # long $1000 и short $1000 одного и того же актива — чистый риск должен быть ~0
        positions = [Position(0, "BTC", 1000), Position(0, "BTC", -1000)]
        vol = portfolio_dollar_volatility(positions, returns)
        self.assertAlmostEqual(vol, 0.0, places=6)

    def test_uncorrelated_assets_reduce_risk_below_naive_sum(self):
        # Специально сконструированные ортогональные (некоррелированные) серии
        a = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
        b = [0.01, 0.01, -0.01, -0.01, 0.01, 0.01]
        returns = {0: a, 1: b}
        positions = [Position(0, "A", 1000), Position(1, "B", 1000)]
        naive = naive_dollar_volatility(positions, returns)
        actual = portfolio_dollar_volatility(positions, returns)
        self.assertLess(actual, naive, "некоррелированные позиции должны давать реальный эффект диверсификации")

    def test_diversification_score_bounded_between_zero_and_one(self):
        a = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
        b = [0.01, 0.01, -0.01, -0.01, 0.01, 0.01]
        returns = {0: a, 1: b}
        positions = [Position(0, "A", 1000), Position(1, "B", -700)]
        score = diversification_score(positions, returns)
        self.assertGreaterEqual(score, -1e-9)
        self.assertLessEqual(score, 1.0 + 1e-9)


class TestHedgeSuggestion(unittest.TestCase):
    def test_perfectly_correlated_candidate_with_equal_vol_hedges_to_near_zero(self):
        a = [0.02, -0.01, 0.03, -0.02, 0.015]
        returns = {0: a, 1: a}  # candidate идентичен target по волатильности и корреляции
        target = Position(0, "BTC", 1000)
        suggestion = suggest_hedge(target, [(1, "BTC-CORRELATED")], returns)
        self.assertIsNotNone(suggestion)
        self.assertAlmostEqual(suggestion.hedge_notional_usd, -1000, places=2, msg="полный хедж идентичным активом — противоположная позиция того же размера")
        self.assertAlmostEqual(suggestion.resulting_portfolio_vol_usd, 0.0, places=4)

    def test_uncorrelated_candidate_gives_poor_hedge_high_residual_vol(self):
        a = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
        b = [0.01, 0.01, -0.01, -0.01, 0.01, 0.01]  # некоррелирован с a
        returns = {0: a, 1: b}
        target = Position(0, "A", 1000)
        suggestion = suggest_hedge(target, [(1, "B")], returns)
        self.assertIsNotNone(suggestion)
        naive = abs(target.signed_notional_usd) * volatility(a)
        self.assertGreater(suggestion.resulting_portfolio_vol_usd, naive * 0.5, "некоррелированный актив не должен давать иллюзию хорошего хеджа")

    def test_picks_best_among_multiple_candidates_by_resulting_vol_not_raw_correlation(self):
        a = [0.02, -0.01, 0.03, -0.02, 0.015]
        noise = [-0.01, 0.02, -0.005, 0.01, -0.02]  # независимый от a ряд
        weak_correlated = [0.4 * a[i] + 0.6 * noise[i] for i in range(len(a))]  # реально ~0.19 корреляция, не масштабирование
        strong_correlated = a  # идентичен — лучший хедж
        returns = {0: a, 1: weak_correlated, 2: strong_correlated}
        target = Position(0, "A", 1000)
        suggestion = suggest_hedge(target, [(1, "WEAK"), (2, "STRONG")], returns)
        self.assertEqual(suggestion.market_id, 2, "должен выбрать кандидата с наименьшим результирующим риском, не первого по списку")

    def test_returns_none_when_target_has_zero_volatility(self):
        returns = {0: [0.0, 0.0, 0.0], 1: [0.01, -0.01, 0.02]}
        target = Position(0, "FLAT", 1000)
        suggestion = suggest_hedge(target, [(1, "OTHER")], returns)
        self.assertIsNone(suggestion)


if __name__ == "__main__":
    unittest.main(verbosity=2)
