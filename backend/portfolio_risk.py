"""
Portfolio-risk через классы активов разом — то, чего физически нет у
Robinhood (крипто/акции/форекс у них в разных продуктах с разной маржой)
и чего нет готовым модулем у самого Lighter, хотя его единая маржа через
BTC+акции+форекс+commodities это буквально позволяет. Это ставит Wake не
«ещё один терминал», а единственное место, где вообще можно увидеть риск
ПОРТФЕЛЯ, а не риск отдельной позиции.

Математика — стандартная портфельная теория (Markowitz), не выдумана:
портфельная дисперсия через ковариационную матрицу, диверсификационный
эффект, minimum-variance hedge ratio. Та же строгость, что LMSR в
predict_amm.py — реальная, известная формула, не "похоже на правду".
"""

from dataclasses import dataclass


def price_returns(prices: list) -> list:
    if len(prices) < 2:
        return []
    return [(prices[i] - prices[i - 1]) / prices[i - 1] for i in range(1, len(prices))]


def volatility(returns: list) -> float:
    n = len(returns)
    if n < 2:
        return 0.0
    mean = sum(returns) / n
    variance = sum((x - mean) ** 2 for x in returns) / n
    return variance**0.5


def pearson_correlation(returns_a: list, returns_b: list) -> float:
    if len(returns_a) != len(returns_b):
        raise ValueError("серии должны быть одинаковой длины")
    n = len(returns_a)
    if n < 2:
        raise ValueError("нужно минимум 2 точки")
    mean_a = sum(returns_a) / n
    mean_b = sum(returns_b) / n
    cov = sum((returns_a[i] - mean_a) * (returns_b[i] - mean_b) for i in range(n)) / n
    std_a = (sum((x - mean_a) ** 2 for x in returns_a) / n) ** 0.5
    std_b = (sum((x - mean_b) ** 2 for x in returns_b) / n) ** 0.5
    if std_a == 0 or std_b == 0:
        return 0.0  # нет вариации — корреляция не определена, трактуем как отсутствие связи
    r = cov / (std_a * std_b)
    return max(
        -1.0, min(1.0, r)
    )  # float-шум может дать 1.0000000002 — зажимаем в валидный диапазон


@dataclass(frozen=True)
class Position:
    market_id: int
    symbol: str
    signed_notional_usd: float  # + long, - short — так короткая позиция корректно гасит риск длинной в том же активе


def _correlation_between(mid_a: int, mid_b: int, returns_by_market: dict) -> float:
    if mid_a == mid_b:
        return 1.0
    return pearson_correlation(returns_by_market[mid_a], returns_by_market[mid_b])


def portfolio_dollar_volatility(positions: list, returns_by_market: dict) -> float:
    """Портфельная (не наивная сумма) волатильность в долларах — учитывает,
    что скоррелированные позиции складывают риск, а некоррелированные и
    противоположные — гасят его. Стандартная формула var(sum) через матрицу
    ковариаций, не приближение."""
    vols = {p.market_id: volatility(returns_by_market[p.market_id]) for p in positions}
    variance = 0.0
    for pi in positions:
        for pj in positions:
            corr = _correlation_between(pi.market_id, pj.market_id, returns_by_market)
            variance += (
                pi.signed_notional_usd
                * pj.signed_notional_usd
                * corr
                * vols[pi.market_id]
                * vols[pj.market_id]
            )
    return (
        max(0.0, variance) ** 0.5
    )  # float-шум изредка даёт крошечную отрицательную дисперсию


def naive_dollar_volatility(positions: list, returns_by_market: dict) -> float:
    """Если бы риски просто складывались без учёта корреляции — точка сравнения
    для diversification_score."""
    return sum(
        abs(p.signed_notional_usd) * volatility(returns_by_market[p.market_id])
        for p in positions
    )


def diversification_score(positions: list, returns_by_market: dict) -> float:
    """0 = вообще нет эффекта диверсификации (всё двигается вместе), 1 = полностью
    захеджировано. Может быть отрицательным не бывает по построению (portfolio_vol
    математически не может превысить naive sum — неравенство треугольника)."""
    naive = naive_dollar_volatility(positions, returns_by_market)
    if naive == 0:
        return 0.0
    actual = portfolio_dollar_volatility(positions, returns_by_market)
    return 1 - (actual / naive)


@dataclass(frozen=True)
class HedgeSuggestion:
    market_id: int
    symbol: str
    hedge_notional_usd: float  # знак уже учтён — это готовая к открытию позиция
    correlation_to_target: float
    resulting_portfolio_vol_usd: float


def suggest_hedge(
    target: Position, candidates: list, returns_by_market: dict
) -> HedgeSuggestion | None:
    """Minimum-variance hedge ratio: h* = corr(target,candidate) * vol_target / vol_candidate.
    Перебирает кандидатов, выбирает того, кто даёт наименьшую результирующую
    портфельную волатильность (не просто наибольшую |корреляцию| — это разные
    вещи, если у кандидатов сильно разная собственная волатильность)."""
    target_vol = volatility(returns_by_market[target.market_id])
    if target_vol == 0:
        return None

    best = None
    for candidate_id, candidate_symbol in candidates:
        if candidate_id == target.market_id:
            continue
        candidate_vol = volatility(returns_by_market[candidate_id])
        if candidate_vol == 0:
            continue
        corr = _correlation_between(target.market_id, candidate_id, returns_by_market)
        hedge_ratio = corr * target_vol / candidate_vol
        hedge_notional = -hedge_ratio * target.signed_notional_usd

        hedge_position = Position(candidate_id, candidate_symbol, hedge_notional)
        resulting_vol = portfolio_dollar_volatility(
            [target, hedge_position], returns_by_market
        )

        if best is None or resulting_vol < best.resulting_portfolio_vol_usd:
            best = HedgeSuggestion(
                candidate_id, candidate_symbol, hedge_notional, corr, resulting_vol
            )

    return best
