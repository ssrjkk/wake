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
from math import isfinite


def price_returns(prices: list) -> list:
    """Простые доходности по закрытиям.

    Нулевое, отрицательное или неконечное значение в ЛЮБОЙ точке пары — это
    отсутствующие данные, а не наблюдение: close=0 у неликвидной свечи раньше
    давал либо ZeroDivisionError (синхронный роут падал), либо "-100%" и
    бесконечность на следующем шаге, и обе ветки выглядят как настоящая
    волатильность. Пара выбрасывается целиком."""
    out = []
    for prev, current in zip(prices, prices[1:]):
        if not isfinite(prev) or not isfinite(current) or prev <= 0 or current <= 0:
            continue
        out.append((current - prev) / prev)
    return out


def _finite(returns: list) -> list:
    return [x for x in returns if isfinite(x)]


def volatility(returns: list) -> float:
    returns = _finite(returns)
    n = len(returns)
    if n < 2:
        return 0.0
    mean = sum(returns) / n
    variance = sum((x - mean) ** 2 for x in returns) / n
    return variance**0.5


def pearson_correlation(returns_a: list, returns_b: list) -> float:
    """Корреляция по ПОСЛЕДНИМ min(len_a, len_b) значениям.

    Ряды приходят с разных рынков и разной длины: у нового листа меньше свечей,
    чем у BTC за то же окно. Прежняя проверка «серии равной длины, иначе
    ValueError» роняла весь расчётRisk-панели одним сообщением про длину массива,
    которое человек не мог ни на что опереться. Усечение по общему хвосту —
    стандартная пара-в-пара работа с несопоставимыми по истории рядами: сравниваются
    одни и те же интервалы, а не «всё, что было у каждого».
    """
    a = _finite(list(returns_a))
    b = _finite(list(returns_b))
    n = min(len(a), len(b))
    if n < 2:
        raise ValueError(
            f"для корреляции нужно минимум 2 общих значения, есть {len(a)} и {len(b)}"
        )
    a, b = a[-n:], b[-n:]
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    cov = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n)) / n
    std_a = (sum((x - mean_a) ** 2 for x in a) / n) ** 0.5
    std_b = (sum((x - mean_b) ** 2 for x in b) / n) ** 0.5
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


def _require_series(positions: list, returns_by_market: dict) -> None:
    """Ряд должен быть у каждого рынка корзины. Молча пропущенный рынок — это
    волатильность портфеля, посчитанная по половине портфеля, и выглядит она
    ровно как настоящая цифра."""
    missing = sorted(
        {p.market_id for p in positions if p.market_id not in returns_by_market}
    )
    if missing:
        raise ValueError(
            f"нет ряда доходностей для рынков {missing} — корреляции считать не по чему"
        )


def portfolio_dollar_volatility(positions: list, returns_by_market: dict) -> float:
    """Портфельная (не наивная сумма) волатильность в долларах — учитывает,
    что скоррелированные позиции складывают риск, а некоррелированные и
    противоположные — гасят его. Стандартная формула var(sum) через матрицу
    ковариаций, не приближение."""
    _require_series(positions, returns_by_market)
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
    _require_series(positions, returns_by_market)
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
    unhedged_vol_usd: float
    """Цель без хеджа рядом. Без этой цифры «результирующая волатильность 800$»
    не читается никак: непонятно, стало лучше или хуже, и панель предлагала бы
    хедж, который риск увеличил."""


def suggest_hedge(
    target: Position, candidates: list, returns_by_market: dict
) -> HedgeSuggestion | None:
    """Minimum-variance hedge ratio: h* = corr(target,candidate) * vol_target / vol_candidate.
    Перебирает кандидатов, выбирает того, кто даёт наименьшую результирующую
    портфельную волатильность (не просто наибольшую |корреляцию| — это разные
    вещи, если у кандидатов сильно разная собственная волатильность).

    Кандидат, который риска не убавил, отсеивается: «лучший из худших» — это не
    предложение хеджа, а предложение открыть вторую позицию, которая двигает
    портфель в ту же сторону."""
    _require_series([target], returns_by_market)
    target_vol = volatility(returns_by_market[target.market_id])
    if target_vol == 0:
        return None
    unhedged = abs(target.signed_notional_usd) * target_vol

    best = None
    for candidate_id, candidate_symbol in candidates:
        if candidate_id == target.market_id:
            continue
        if candidate_id not in returns_by_market:
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
        if resulting_vol >= unhedged:
            continue

        if best is None or resulting_vol < best.resulting_portfolio_vol_usd:
            best = HedgeSuggestion(
                candidate_id,
                candidate_symbol,
                hedge_notional,
                corr,
                resulting_vol,
                unhedged,
            )

    return best
