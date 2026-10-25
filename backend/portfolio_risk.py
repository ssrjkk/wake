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

# Относительная граница «это ещё шум, а уже и не шум». float64 копит ошибку
# порядка eps на каждом сложении: при 2500 слагаемых (50 позиций, матрица 50x50
# — потолок роута) это ~2500 * 2.2e-16 ≈ 5e-13 от масштаба дисперсии. Взято 1e-9:
# запас в четыре порядка над худшим случаем округления и на шесть порядков ниже
# любой величины, которую человек назвал бы «портфель стал менее рискованным».
_VARIANCE_NOISE_REL = 1e-9


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
    ValueError» роняла весь расчёт Risk-панели одним сообщением про длину массива,
    которое человек не мог ни на что опереться. Усечение по общему хвосту —
    стандартная пара-в-пара работа с несопоставимыми по истории рядами: сравниваются
    одни и те же интервалы, а не «всё, что было у каждого».

    Для корзины этой primitive уже недостаточно: набор попарных хвостов считает
    корреляции по разным выборкам, и матрица из них не обязана быть
    полуопределённой. Caller корзины обязан привести ряды к одному окну
    (_aligned_tails) и позвонить сюда уже согласованными рядами.
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


def _aligned_tails(returns_by_market: dict, market_ids: list) -> dict:
    """Ряды корзины приводятся к ОБЩЕМУ окну — последним min(len) значениям.

    Это не аккуратность, а условие того, что матрицы корреляций вообще существует.
    Прежний способ — попарный общий хвост — считает каждую пару на СВОЁМ
    подвыборочном окне, и из трёх рынков с рядами 40, 12 и 5 наблюдений получается
    набор чисел, который не обязан быть положительно полуопределённым: дисперсия
    портфеля уходила в минус, а max(0.0, variance) прятал это за «нулём риска».
    Матрица, посчитанная по одной и той же выборке, полуопределена по построению
    (это Gram-матрица стандартизованных векторов), и нечисловой ответ больше не
    нужен.

    Короткий ряд не обрывает расчёт, а укорачивает окно всем — listwise-вырубка,
    стандартная цена согласованной матрицы."""
    window = min(len(returns_by_market[mid]) for mid in market_ids)
    if window < 2:
        raise ValueError(
            f"общее окно корзины — {window} знач. (минимум 2): ряды слишком "
            "короткие, коррелировать не по чему"
        )
    return {mid: list(returns_by_market[mid])[-window:] for mid in market_ids}


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
    ковариаций, не приближение.

    Ряды корзины сначала приводятся к общему окну (_aligned_tails), и это не
    косметика: без него матрица попарных корреляций не обязана быть
    полуопределённой. Отрицательная дисперсия зажимается в ноль только в шуме
    плавающей точки; раньше это делал max(0.0, variance) без условий, и у него
    было два ложных оправдания — inf - inf = nan (max(0.0, nan) в Python даёт
    0.0, то есть мусор на входе превращался в «риск нулевой») и отрицательная по
    существу матрица, которую общий хвост пары рядов разной длины и рождал."""
    _require_series(positions, returns_by_market)
    returns_by_market = _aligned_tails(
        returns_by_market, sorted({p.market_id for p in positions})
    )
    vols = {p.market_id: volatility(returns_by_market[p.market_id]) for p in positions}

    variance = 0.0
    # Масштаб — сумма диагональных слагаемых: он того же порядка, что и само
    # variance, поэтому от него можно брать шумовую границу в относительных
    # единицах, а не в условном «1e-9 долларов». Умножение, а не возведение в
    # степень: на ряду вроде [1e154, ...] ** даёт OverflowError ещё до проверки
    # ниже, то есть 500 вместо внятного отказа.
    scale = 0.0
    for p in positions:
        diagonal = p.signed_notional_usd * vols[p.market_id]
        scale += diagonal * diagonal
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
    if not isfinite(variance):
        raise ValueError(
            "дисперсия портфеля сошлась к inf/nan — ряды доходностей должны быть "
            "разумного порядка, а ноль на таком входе означал бы «нулевой риск»"
        )
    if variance < 0:
        if variance >= -_VARIANCE_NOISE_REL * scale:
            return 0.0
        raise ValueError(
            f"отрицательная дисперсия портфеля ({variance:.6g}) вне шумовой "
            "границы: матрица корреляций не полуопределена, корень из неё "
            "неизвлекаем — нулём это закрывать нельзя"
        )
    return variance**0.5


def naive_dollar_volatility(positions: list, returns_by_market: dict) -> float:
    """Если бы риски просто складывались без учёта корреляции — точка сравнения
    для diversification_score. Окно то же, что у портфельной волатильности:
    сравнивать число, посчитанное по 40 наблюдениям, с числом по 5 наблюдениям
    бессмысленно, и score на такой паре врал бы сильнее, чем сама волатильность."""
    _require_series(positions, returns_by_market)
    aligned = _aligned_tails(
        returns_by_market, sorted({p.market_id for p in positions})
    )
    return sum(
        abs(p.signed_notional_usd) * volatility(aligned[p.market_id]) for p in positions
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
    портфель в ту же сторону.

    Окно общее для цели и всех кандидатов, и берётся оно не из самой короткой
    строки вообще, а из самой короткой ПРИГОДНОЙ: ряд длиннее одного значения —
    то, при котором волатильность ещё определима. Кандидат с одним наблюдением
    не обрывает запрос, он не участвует в переборе (именно так вёл себя и прежний
    код: volatility ряда из одного значения даёт 0, и такой кандидат отсекался
    до первой корреляции)."""
    _require_series([target], returns_by_market)
    if len(returns_by_market[target.market_id]) < 2:
        return None
    usable = [
        candidate_id
        for candidate_id, _ in candidates
        if candidate_id != target.market_id
        and len(returns_by_market.get(candidate_id, [])) >= 2
    ]
    returns_by_market = _aligned_tails(returns_by_market, [target.market_id, *usable])
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
