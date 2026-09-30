"""
Funding rate арбитраж: /funding-arb/check и /funding-arb/size.
Уникально для Lighter: перп+спот одного актива на одном аккаунте с одной
маржой. Математика — funding_arb.py, 11/11 тестов, включая проверку на
самую вероятную реальную ошибку (перепутать 1-часовой эпох с 8-часовым).

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from funding_arb import FundingSnapshot, find_opportunity, size_delta_neutral_position

router = APIRouter()


class FundingCheckRequest(BaseModel):
    market_id: int
    symbol: str
    hourly_rate: float
    direction: str
    min_annualized_yield: float = 0.05


class FundingSizeRequest(BaseModel):
    capital_usd: float
    price: float
    perp_size_decimals: int
    spot_size_decimals: int
    perp_min_base_amount: float
    spot_min_base_amount: float


@router.post("/funding-arb/check")
def check_funding_arb(req: FundingCheckRequest):
    snapshot = FundingSnapshot(req.market_id, req.symbol, req.hourly_rate, req.direction)
    opp = find_opportunity(snapshot, req.min_annualized_yield)
    if opp is None:
        return {"opportunity": None}
    return {
        "opportunity": {
            "symbol": opp.symbol, "market_id": opp.market_id,
            "annualized_yield": opp.annualized_yield, "perp_side": opp.perp_side,
            "spot_needed": opp.spot_needed, "hourly_rate": opp.hourly_rate,
        }
    }


@router.post("/funding-arb/size")
def size_funding_position(req: FundingSizeRequest):
    pos = size_delta_neutral_position(
        req.capital_usd, req.price, req.perp_size_decimals, req.spot_size_decimals,
        req.perp_min_base_amount, req.spot_min_base_amount,
    )
    if pos is None:
        return {"position": None, "reason": "капитала недостаточно на минимальный размер обеих ног, либо неверные входные данные"}
    return {"position": {
        "perp_notional_usd": pos.perp_notional_usd, "spot_notional_usd": pos.spot_notional_usd,
        "perp_base_amount": pos.perp_base_amount, "spot_base_amount": pos.spot_base_amount,
    }}