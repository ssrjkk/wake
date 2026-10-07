"""
Funding rate арбитраж: расчёт ног (POST /funding-arb/check, /funding-arb/size)
плюс живые ставки Lighter (GET /funding/rates, /funding/venues) и список
активов, где обе ноги вообще существуют на одной бирже (GET
/funding/carry-markets).

Уникально для Lighter: перп+спот одного актива на одном аккаунте с одной
маржой. Проверено по живой книге: активных таких пар сейчас 7 (ETH, LINK, AAVE,
UNI, LDO, LIT, SKY) из ~200 перпов — поэтому страница показывает реальный
список, а не обещает арбитраж «на любом рынке».

Математика — funding_arb.py, оттестирована, включая самую вероятную реальную
ошибку (перепутать 1-часовой эпох Lighter с 8-часовым). Данные —
lighter_rest.py, живой REST. Ответ /funding-rates отдаёт все строки разом и
несколько площадок на символ; фильтровать по exchange обязан клиент, иначе под
BTC прилетает ставка LIT с чужой биржи.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

import lighter_rest
from config import LIGHTER_NETWORK
from funding_arb import (
    HOURS_PER_YEAR,
    VENUES,
    FundingSnapshot,
    base_asset,
    find_opportunity,
    funding_by_market,
    pairable_carry_markets,
    size_delta_neutral_position,
    snapshot_from_signed_rate,
)

router = APIRouter()


class FundingCheckRequest(BaseModel):
    market_id: int
    symbol: str
    hourly_rate: float
    direction: Literal["long", "short"]
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
    snapshot = FundingSnapshot(
        req.market_id, req.symbol, req.hourly_rate, req.direction
    )
    opp = find_opportunity(snapshot, req.min_annualized_yield)
    if opp is None:
        return {"opportunity": None}
    return {
        "opportunity": {
            "symbol": opp.symbol,
            "market_id": opp.market_id,
            "annualized_yield": opp.annualized_yield,
            "perp_side": opp.perp_side,
            "spot_needed": opp.spot_needed,
            "hourly_rate": opp.hourly_rate,
        }
    }


@router.post("/funding-arb/size")
def size_funding_position(req: FundingSizeRequest):
    pos = size_delta_neutral_position(
        req.capital_usd,
        req.price,
        req.perp_size_decimals,
        req.spot_size_decimals,
        req.perp_min_base_amount,
        req.spot_min_base_amount,
    )
    if pos is None:
        return {
            "position": None,
            "reason": "капитала недостаточно на минимальный размер обеих ног, либо неверные входные данные",
        }
    return {
        "position": {
            "perp_notional_usd": pos.perp_notional_usd,
            "spot_notional_usd": pos.spot_notional_usd,
            "perp_base_amount": pos.perp_base_amount,
            "spot_base_amount": pos.spot_base_amount,
        }
    }


@router.get("/funding/rates")
def funding_rates(limit: int = Query(25, ge=1, le=300), positive_only: bool = False):
    """Живые ставки funding Lighter, отранжированные по годовой.

    Эпох Lighter — 1 час, поэтому годовая = ставка × 24 × 365. Это те самые
    числа, которые раньше нужно было вводить руками в форме /funding-arb/check,
    хотя они бесплатно отдаются API."""
    try:
        rows = lighter_rest.get_funding_rates(LIGHTER_NETWORK)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    rates = funding_by_market(rows)
    symbols = {
        int(r["market_id"]): r.get("symbol") or ""
        for r in rows
        if r.get("exchange") == "lighter"
    }
    out = []
    for market_id, rate in rates.items():
        symbol = symbols.get(market_id) or f"market {market_id}"
        snapshot = snapshot_from_signed_rate(market_id, symbol, rate)
        if positive_only and snapshot.direction != "long":
            continue
        out.append(
            {
                "market_id": market_id,
                "symbol": snapshot.symbol,
                "base": base_asset(snapshot.symbol),
                "hourly_rate": snapshot.hourly_rate,
                "signed_rate": rate,
                "direction": snapshot.direction,
                "annualized": snapshot.hourly_rate * HOURS_PER_YEAR,
            }
        )
    out.sort(key=lambda r: r["annualized"], reverse=True)
    return {
        "network": LIGHTER_NETWORK,
        "epoch_hours": 1,
        "total": len(out),
        "rates": out[:limit],
    }


@router.get("/funding/venues")
def funding_venues(symbol: str = Query("BTC", min_length=1, max_length=24)):
    """Ставки одного символа по всем площадкам, которые отдаёт Lighter, — справочно.

    Нарочно НЕ считается «спред, который можно забрать»: интервалы выплат у
    площадок разные (у Lighter час — подтверждено живым API, у остальных —
    другие), так что приводить эти числа к одному знаменателю без проверки
    нельзя. Полезное применение — увидеть, что Lighter обычно в середине
    диапазона, а не аномально высокий/низкий.

    Вход нормализуется по базовому активу: в живом ответе все четыре площадки и
    так подписывают актив голым именем ("BTC"), но юзер впишет "BTC-PERP" или
    "btcusdt", поэтому запрос ищет по базе, а наружу отдаёт и исходный тикер."""
    try:
        rows = lighter_rest.get_funding_rates(LIGHTER_NETWORK)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    wanted = base_asset(symbol)
    matched = [
        {
            "venue": r.get("exchange"),
            "symbol": r.get("symbol"),
            "market_id": r.get("market_id"),
            "signed_rate": float(r["rate"]),
        }
        for r in rows
        if r.get("exchange") in VENUES and base_asset(r.get("symbol", "")) == wanted
    ]
    if not matched:
        raise HTTPException(
            status_code=404, detail=f"нет ставок funding по символу {symbol}"
        )
    matched.sort(key=lambda m: m["signed_rate"], reverse=True)
    return {"symbol": symbol.upper(), "base": wanted, "venues": matched}


@router.get("/funding/carry-markets")
def carry_markets():
    """Активы, где cash-and-carry физически строится: активный перп + активный
    спот того же инструмента за USDC, на одном Lighter.

    Для каждой пары — минимальные размеры и шаги обеих ног (из книги) и текущая
    ставка funding (из /funding-rates), т.е. тем же запросом можно сразу
    считать, хватает ли капитала на две ноги."""
    try:
        books = lighter_rest.get_order_books(LIGHTER_NETWORK)
        rates = funding_by_market(lighter_rest.get_funding_rates(LIGHTER_NETWORK))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    legs = []
    for leg in pairable_carry_markets(books):
        signed = rates.get(leg.perp_market_id)
        snapshot = (
            snapshot_from_signed_rate(leg.perp_market_id, leg.symbol, signed)
            if signed is not None
            else None
        )
        legs.append(
            {
                "symbol": leg.symbol,
                "perp_market_id": leg.perp_market_id,
                "spot_market_id": leg.spot_market_id,
                "perp_min_base_amount": leg.perp_min_base_amount,
                "spot_min_base_amount": leg.spot_min_base_amount,
                "perp_size_decimals": leg.perp_size_decimals,
                "spot_size_decimals": leg.spot_size_decimals,
                "hourly_rate": snapshot.hourly_rate if snapshot else None,
                "direction": snapshot.direction if snapshot else None,
                "annualized": snapshot.hourly_rate * HOURS_PER_YEAR
                if snapshot
                else None,
            }
        )
    return {
        "network": LIGHTER_NETWORK,
        "quote": "USDC",
        "count": len(legs),
        "markets": legs,
    }
