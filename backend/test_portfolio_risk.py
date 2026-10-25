"""python3 -m unittest test_portfolio_risk -v"""

import math
import unittest
from portfolio_risk import (
    price_returns,
    volatility,
    pearson_correlation,
    Position,
    portfolio_dollar_volatility,
    naive_dollar_volatility,
    diversification_score,
    suggest_hedge,
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
        self.assertAlmostEqual(
            portfolio_dollar_volatility(positions, returns),
            naive_dollar_volatility(positions, returns),
            places=9,
        )

    def test_perfectly_correlated_same_direction_no_diversification_benefit(self):
        # B = A * 2 (детерминированно скоррелировано 1.0)
        a = [0.02, -0.01, 0.03, -0.02, 0.015]
        b = [x * 2 for x in a]
        returns = {0: a, 1: b}
        positions = [Position(0, "A", 1000), Position(1, "B", 1000)]
        score = diversification_score(positions, returns)
        self.assertAlmostEqual(
            score,
            0.0,
            places=4,
            msg="идеально скоррелированные позиции не должны давать эффект диверсификации",
        )

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
        self.assertLess(
            actual,
            naive,
            "некоррелированные позиции должны давать реальный эффект диверсификации",
        )

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
        returns = {
            0: a,
            1: a,
        }  # candidate идентичен target по волатильности и корреляции
        target = Position(0, "BTC", 1000)
        suggestion = suggest_hedge(target, [(1, "BTC-CORRELATED")], returns)
        self.assertIsNotNone(suggestion)
        self.assertAlmostEqual(
            suggestion.hedge_notional_usd,
            -1000,
            places=2,
            msg="полный хедж идентичным активом — противоположная позиция того же размера",
        )
        self.assertAlmostEqual(suggestion.resulting_portfolio_vol_usd, 0.0, places=4)

    def test_uncorrelated_candidate_is_not_offered_as_a_hedge(self):
        """Кандидат, который риска не убавил, наружу не отдаётся.

        Прежняя версия движка возвращала «лучшего из худших» с высокой
        результирующей волатильностью, и панель показывала это как предложение
        открыть позицию. Для некоррелированного актива оптимальный h* убивает
        только дисперсию самой приставки и добавляет её собственную — итог
        хуже, чем без хеджа, и честный ответ здесь «предложения нет»."""
        a = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
        b = [0.01, 0.01, -0.01, -0.01, 0.01, 0.01]  # некоррелирован с a
        returns = {0: a, 1: b}
        target = Position(0, "A", 1000)
        self.assertIsNone(suggest_hedge(target, [(1, "B")], returns))

    def test_suggestion_carries_the_unhedged_volume_to_compare_with(self):
        a = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02]
        returns = {0: a, 1: a}
        target = Position(0, "A", 1000)
        suggestion = suggest_hedge(target, [(1, "B")], returns)
        self.assertIsNotNone(suggestion)
        self.assertAlmostEqual(
            suggestion.unhedged_vol_usd,
            abs(target.signed_notional_usd) * volatility(a),
            places=6,
            msg="без цифры «до» результат «после» не читается",
        )
        self.assertLess(
            suggestion.resulting_portfolio_vol_usd, suggestion.unhedged_vol_usd
        )

    def test_picks_best_among_multiple_candidates_by_resulting_vol_not_raw_correlation(
        self,
    ):
        a = [0.02, -0.01, 0.03, -0.02, 0.015]
        noise = [-0.01, 0.02, -0.005, 0.01, -0.02]  # независимый от a ряд
        weak_correlated = [
            0.4 * a[i] + 0.6 * noise[i] for i in range(len(a))
        ]  # реально ~0.19 корреляция, не масштабирование
        strong_correlated = a  # идентичен — лучший хедж
        returns = {0: a, 1: weak_correlated, 2: strong_correlated}
        target = Position(0, "A", 1000)
        suggestion = suggest_hedge(target, [(1, "WEAK"), (2, "STRONG")], returns)
        self.assertEqual(
            suggestion.market_id,
            2,
            "должен выбрать кандидата с наименьшим результирующим риском, не первого по списку",
        )

    def test_returns_none_when_target_has_zero_volatility(self):
        returns = {0: [0.0, 0.0, 0.0], 1: [0.01, -0.01, 0.02]}
        target = Position(0, "FLAT", 1000)
        suggestion = suggest_hedge(target, [(1, "OTHER")], returns)
        self.assertIsNone(suggestion)


class TestGarbageData(unittest.TestCase):
    """Математика не имеет права превращать битые данные в «меньше риска».

    NaN и inf приходят из жизни: close=0 у неликвидной свечи, деление на неё,
    ряды разной длины у рынка, который листнулся позже. Раньше это было
    ZeroDivisionError (роут падал), либо inf → variance inf → max(0.0, inf) →
    sqrt(inf) и наружу JSON с Infinity, который Starlette отказывается
    сериализовать; NaN же давал score 1.0 — «портфель полностью захеджирован».
    """

    def test_zero_and_nan_closes_are_dropped_not_divided(self):
        # close=0 — отсутствующие данные, а не «-100%»: пара выбрасывается целиком.
        self.assertEqual(price_returns([100, 0, 110]), [])
        self.assertEqual(price_returns([100, float("nan"), 110]), [])
        self.assertEqual(price_returns([100, 105]), [0.05])

    def test_volatility_ignores_non_finite_values(self):
        self.assertAlmostEqual(
            volatility([0.01, -0.01, float("nan"), float("inf")]), 0.01
        )
        self.assertEqual(volatility([0.01, float("nan")]), 0.0)
        # Population-вариант (деление на n), как считает volatility(): mean=0,
        # (0.0001+0.0001+0.0004+0.0004)/4 = 0.00025 -> 0.0158114.
        self.assertAlmostEqual(
            volatility([0.01, -0.01, 0.02, -0.02]), 0.015811388, places=6
        )

    def test_correlation_of_unequal_series_works_on_the_common_tail(self):
        a = [0.01, 0.02, 0.03, 0.04]
        b_short = [0.01, 0.02]
        self.assertGreater(pearson_correlation(a, b_short), 0.9)

    def test_correlation_needs_two_common_points(self):
        with self.assertRaises(ValueError):
            pearson_correlation([0.01], [0.01, 0.02])

    def test_missing_series_names_the_market_instead_of_keyerror(self):
        positions = [Position(0, "A", 1000), Position(7, "GHOST", 500)]
        returns = {0: [0.01, -0.01, 0.02]}
        with self.assertRaises(ValueError) as ctx:
            portfolio_dollar_volatility(positions, returns)
        self.assertIn("7", str(ctx.exception))

    def test_portfolio_volatility_is_finite_for_finite_input(self):
        positions = [Position(0, "A", 1000), Position(1, "B", -400)]
        returns = {0: [0.01, -0.02, 0.03, -0.01], 1: [0.02, 0.01, -0.03, 0.01]}
        value = portfolio_dollar_volatility(positions, returns)
        self.assertTrue(math.isfinite(value) and value >= 0)
        score = diversification_score(positions, returns)
        self.assertTrue(0.0 <= score <= 1.0)

    def test_non_finite_variance_is_refused_instead_of_reading_as_zero(self):
        """max(0.0, variance) из прежнего кода на inf - inf = nan возвращает 0.0:
        панель показывала «волатильность портфеля 0$» на ряду, который к деньгам
        не имеет отношения. Ноль тут опаснее ошибки — он выглядит как идеальный
        хедж. Граница HTTP-слоя такие порядки отсекает, но и математика обязана
        отвечать отказом, а не цифрой."""
        positions = [Position(1, "BTC", 5e11), Position(2, "ETH", 5e11)]
        returns = {1: [1e154, -1e154, 1e154], 2: [1e154, 1e154, -1e154]}
        with self.assertRaises(ValueError) as ctx:
            portfolio_dollar_volatility(positions, returns)
        self.assertIn("inf", str(ctx.exception))

    def test_basket_is_computed_on_one_common_window(self):
        """Корзина из рядов разной длины считается по общим последним
        наблюдениям, а не по попарным хвостам.

        Это не придуманный случай: на рядах 3/4/4 ниже попарные корреляции
        выходят 0.189, -1.0 и -0.663 — набор, посчитанный по РАЗНЫМ выборкам, и
        матрица из него не обязана быть полуопределённой. Дисперсия уходила в
        -427, прежний max(0.0, variance) превращал это в «риск нулевой», и панель
        советовала бы хедж на том, чего посчитать нельзя. Ряды разной длины —
        норма: так выглядит рынок, листнутый позже других."""
        positions = [
            Position(1, "A", 1000.0),
            Position(2, "B", 1000.0),
            Position(3, "C", 1000.0),
        ]
        mixed = {
            1: [-0.5, 1.0, 1.0],
            2: [-1.0, 0.0, 1.0, -0.5],
            3: [1.0, 0.0, -1.0, -1.0],
        }
        value = portfolio_dollar_volatility(positions, mixed)
        self.assertTrue(
            math.isfinite(value) and value > 0,
            f"нулевой риск на этом входе — прежний баг, а не ответ ({value!r})",
        )
        # Общий хвост = тот же ответ, что на рядах, обрезанных руками до 3 точек.
        explicit = {1: [-0.5, 1.0, 1.0], 2: [0.0, 1.0, -0.5], 3: [0.0, -1.0, -1.0]}
        self.assertAlmostEqual(
            value, portfolio_dollar_volatility(positions, explicit), places=12
        )
        self.assertLessEqual(value, naive_dollar_volatility(positions, mixed))

    def test_short_candidate_does_not_break_the_hedge_request(self):
        """Кандидат с рядом из одного наблюдения не участвует в переборе — и не
        должен обрывать расчёт: раньше он отсекался по нулевой волатильности, и
        общее окно обязано сохранять это поведение."""
        target = Position(1, "A", 1000.0)
        returns = {1: [0.1, -0.2, 0.3, -0.1], 2: [0.05], 3: [0.05, -0.05, 0.1, 0.2]}
        suggestion = suggest_hedge(target, [(2, "B"), (3, "C")], returns)
        self.assertIsNotNone(
            suggestion, "короткий кандидат не имеет права обнулить ответ"
        )
        self.assertEqual(suggestion.market_id, 3)

    def test_full_hedge_still_reads_as_zero_not_as_an_error(self):
        """Граничный случай того же отказа: длинная и короткая позиции одного
        риска (ряды совпадают, знаки нотционалей противоположны) дают дисперсию
        ровно ноль — с плавающей ошибкой, у которой может быть любой знак. Такой
        шум зажимается в ноль, а не превращается в отказ: иначе «портфель
        захеджирован» падал бы ошибкой, а это ровно тот ответ, который человек
        ждёт от панели."""
        positions = [Position(1, "A", 1000.0), Position(2, "B", -1000.0)]
        returns = {1: [0.1, 0.2, 0.3], 2: [0.1, 0.2, 0.3]}
        self.assertAlmostEqual(portfolio_dollar_volatility(positions, returns), 0.0)
        self.assertAlmostEqual(diversification_score(positions, returns), 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
