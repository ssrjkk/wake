"""
Cross-asset portfolio risk: /portfolio/risk и /portfolio/hedge.
Единая маржа Lighter через крипту/акции/форекс/commodities делает эту фичу
структурно возможной. Математика (portfolio_risk.py) — 16/16 тестов, реальные
свойства теории портфеля, не приближение.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from portfolio_risk import Position, portfolio_dollar_volatility, naive_dollar_volatility, diversification_score, suggest_hedge

router = APIRouter()


class PortfolioPosition(BaseModel):
    market_id: int
    symbol: str
    signed_notional_usd: float


class PortfolioRiskRequest(BaseModel):
    positions: list[PortfolioPosition]
    returns_by_market: dict  # market_id (как строка в JSON) -> список returns


class HedgeRequest(BaseModel):
    target: PortfolioPosition
    candidates: list  # [[market_id, symbol], ...]
    returns_by_market: dict


@router.post("/portfolio/risk")
def portfolio_risk_endpoint(req: PortfolioRiskRequest):
    positions = [Position(p.market_id, p.symbol, p.signed_notional_usd) for p in req.positions]
    returns_by_market = {int(k): v for k, v in req.returns_by_market.items()}
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
    target = Position(req.target.market_id, req.target.symbol, req.target.signed_notional_usd)
    candidates = [(c[0], c[1]) for c in req.candidates]
    returns_by_market = {int(k): v for k, v in req.returns_by_market.items()}
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
        }
    }