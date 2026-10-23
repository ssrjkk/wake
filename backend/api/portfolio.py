"""
Cross-asset portfolio risk: /portfolio/risk и /portfolio/hedge.
Единая маржа Lighter через крипту/акции/форекс/commodities делает эту фичу
структурно возможной. Математика (portfolio_risk.py) — 16/16 тестов, реальные
свойства теории портфеля, не приближение.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

import math

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from portfolio_risk import (
    Position,
    portfolio_dollar_volatility,
    naive_dollar_volatility,
    diversification_score,
    suggest_hedge,
)

router = APIRouter()


class PortfolioPosition(BaseModel):
    market_id: int
    symbol: str
    # allow_inf_nan=False не косметика: inf в нотионале доходил до JSON ответа и
    # Starlette падала на сериализации (allow_nan=False по RFC), а NaN проходил
    # как «портфель почти без риска» — score 1.0 по мусорным входным данным.
    signed_notional_usd: float = Field(allow_inf_nan=False, le=1e12, ge=-1e12)


# candidates на проводе — массив пар [market_id, symbol]; tuple[int, str]
# фиксирует и длину, и типы. Прежний list без схемы внутри допускал [[1]] и
# ["x"], и `c[0]` на них давал IndexError/TypeError мимо try-блока — 500 вместо
# честного 422 на ручном запросе.
HedgeCandidate = tuple[int, str]


class _SeriesRequest(BaseModel):
    """Общая проверка рядов для обоих роутов.

    Формат на проводе не меняется: {"1": [0.01, -0.02]} — массив чисел на
    market_id. Ключ приводит к int сам pydantic, поэтому "abc" в ключе — это
    422 на границе, а не ValueError в разборщике внутри роутера (прежний
    `{int(k): v}` стоял ДО try-блока и собирал отказ общим обработчиком).

    Ряды разной длины разрешены намеренно: pearson_correlation работает по
    общим последним значениям, и рынок, листнутый вчера, не имеет права обрывать
    расчёт всей корзины."""

    returns_by_market: dict[int, list[float]] = Field(max_length=64)

    @field_validator("returns_by_market")
    @classmethod
    def series_are_usable(cls, v: dict[int, list[float]]) -> dict[int, list[float]]:
        for market_id, series in v.items():
            if len(series) > 500:
                raise ValueError(
                    f"рынок {market_id}: ряд длиннее 500 значений — считаем по "
                    "часовым свечам, а не по тикам"
                )
            if not all(math.isfinite(x) for x in series):
                raise ValueError(
                    f"рынок {market_id}: в ряду доходностей есть NaN или inf"
                )
        return v


class PortfolioRiskRequest(_SeriesRequest):
    positions: list[PortfolioPosition] = Field(min_length=1, max_length=50)


class HedgeRequest(_SeriesRequest):
    target: PortfolioPosition
    candidates: list[HedgeCandidate] = Field(default_factory=list, max_length=50)


def _series_by_market(returns: dict[int, list[float]]) -> dict:
    """{market_id: [float]} — ключ остаётся int, как его ждёт математика."""
    return {
        market_id: [float(x) for x in series] for market_id, series in returns.items()
    }


@router.post("/portfolio/risk")
def portfolio_risk_endpoint(req: PortfolioRiskRequest):
    positions = [
        Position(p.market_id, p.symbol, p.signed_notional_usd) for p in req.positions
    ]
    returns_by_market = _series_by_market(req.returns_by_market)
    try:
        naive = naive_dollar_volatility(positions, returns_by_market)
        actual = portfolio_dollar_volatility(positions, returns_by_market)
        score = diversification_score(positions, returns_by_market)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {
        "naive_dollar_volatility": naive,
        "portfolio_dollar_volatility": actual,
        "diversification_score": score,
    }


@router.post("/portfolio/hedge")
def portfolio_hedge_endpoint(req: HedgeRequest):
    target = Position(
        req.target.market_id, req.target.symbol, req.target.signed_notional_usd
    )
    candidates = list(req.candidates)
    returns_by_market = _series_by_market(req.returns_by_market)
    try:
        suggestion = suggest_hedge(target, candidates, returns_by_market)
    except (KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    if suggestion is None:
        return {"suggestion": None}
    return {
        "suggestion": {
            "market_id": suggestion.market_id,
            "symbol": suggestion.symbol,
            "hedge_notional_usd": suggestion.hedge_notional_usd,
            "correlation_to_target": suggestion.correlation_to_target,
            "resulting_portfolio_vol_usd": suggestion.resulting_portfolio_vol_usd,
            "unhedged_vol_usd": suggestion.unhedged_vol_usd,
        }
    }
