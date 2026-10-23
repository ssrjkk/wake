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
from pydantic import BaseModel, Field

import lighter_rest
from config import LIGHTER_NETWORK
from funding_arb import (
    FundingSnapshot,
    annualized_yield,
    base_asset,
    find_opportunity,
    funding_by_market,
    funding_rate_rows,
    pairable_carry_markets,
    size_delta_neutral_position,
    snapshot_from_signed_rate,
    venue_rate_rows,
)

router = APIRouter()


class FundingCheckRequest(BaseModel):
    """Ставка за час — беззнаковая величина доли (0.0001 = 0.01%/час).

    Границы заданы на модели, а не «проверяет математика»: NaN и inf из тела
    запроса доходили до ответа, Starlette отказывалась сериализовать Infinity
    (allow_nan=False по RFC 7159), и клиент получал 500 вместо внятного 422.
    1% за час — это ~8760% годовых; выше этой границы ставки в живом ответе
    Lighter нет ни у одной площадки, так что le=0.05 отсекает мусор, а не
    реальные рынки."""

    market_id: int = Field(ge=0)
    symbol: str = Field(min_length=1, max_length=24)
    hourly_rate: float = Field(ge=0, le=0.05, allow_inf_nan=False)
    # "none" — ставка ровно 0: никто не платит. Без этой ветки нулевой рынок
    # приходил бы как «платят шорты» (109 строк из 735 на замере 2026-10-23).
    direction: Literal["long", "short", "none"]
    min_annualized_yield: float = Field(default=0.05, ge=0, le=10, allow_inf_nan=False)


class FundingSizeRequest(BaseModel):
    """capital_usd/price — доллары и цена рынка; decimals — шаг конкретного
    рынка из книги Lighter (замер 0..6). Верхняя граница decimals не косметика:
    10**400 на int() превращается в OverflowError, то есть 500."""

    capital_usd: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)
    price: float = Field(gt=0, le=1_000_000_000_000, allow_inf_nan=False)
    perp_size_decimals: int = Field(ge=0, le=12)
    spot_size_decimals: int = Field(ge=0, le=12)
    perp_min_base_amount: float = Field(ge=0, le=1_000_000_000, allow_inf_nan=False)
    spot_min_base_amount: float = Field(ge=0, le=1_000_000_000, allow_inf_nan=False)


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

    out = funding_rate_rows(rows)
    if positive_only:
        out = [r for r in out if r["direction"] == "long"]
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
    matched = venue_rate_rows(rows, symbol)
    if not matched:
        raise HTTPException(
            status_code=404, detail=f"нет ставок funding по символу {symbol}"
        )
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
                # annualized_yield() — единственное место, где часовая ставка
                # превращается в годовую (funding_arb.py). Формула ×24×365
                # второй копией в роутере означала бы, что страница и бот могут
                # разойтись в годовой молча, и кто прав — решалось бы по
                # скриншотам.
                "annualized": annualized_yield(snapshot) if snapshot else None,
            }
        )
    return {
        "network": LIGHTER_NETWORK,
        "quote": "USDC",
        "count": len(legs),
        "markets": legs,
    }
