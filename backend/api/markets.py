"""
Обзор рынков одним запросом: GET /markets/overview — те же строки, что печатает
бот по /markets (lighter_rest.get_market_overview), плюс funding по каждому
рынку из того же ответа, что отдаёт /funding/rates.

Зачем роут, если фронт может сам дёргать Lighter: ранжирование по реальному
$-обороту за 24 часа считается по часовым свечам — это 18 запросов к
Lighter на каждое обновление страницы. Здесь они делаются один раз и кэшируются
на 60 секунд (cache.py), поэтому фронт получает готовые числа и не расходится с
ботом ни методом, ни сетью.

Ранжирование — quote_volume_24h, а не open interest: OI в ответе Lighter пришёл
строкой в БАЗОВЫХ единицах актива (BTC "370.840860"), то есть 370 BTC и 370 DOGE
неразличимы, и сортировать по нему было бы ложью. Метод и список рынков
описаны в комментарии к MAJOR_PERPS в lighter_rest.py.
"""

from fastapi import APIRouter, HTTPException

import lighter_rest
from config import LIGHTER_NETWORK
from funding_arb import HOURS_PER_YEAR, funding_by_market, snapshot_from_signed_rate

router = APIRouter()


@router.get("/markets/overview")
def markets_overview():
    try:
        overview = lighter_rest.get_market_overview(network=LIGHTER_NETWORK)
        rates = funding_by_market(lighter_rest.get_funding_rates(LIGHTER_NETWORK))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    rows = []
    for r in overview["rows"]:
        signed = rates.get(r["market_id"])
        snapshot = snapshot_from_signed_rate(r["market_id"], r["symbol"], signed) if signed is not None else None
        rows.append(dict(r) | {
            "funding_hourly": snapshot.hourly_rate if snapshot else None,
            "funding_annualized": snapshot.hourly_rate * HOURS_PER_YEAR if snapshot else None,
            # direction — это КТО платит: "long" = платят лонги, ставку забирают шорты.
            "funding_payer": snapshot.direction if snapshot else None,
        })
    return {
        "network": overview["network"],
        "ranked_by": overview["ranked_by"],
        "epoch_hours": 1,
        "count": len(rows),
        "rows": rows,
        "no_market": overview["no_market"],
        "no_data": overview["no_data"],
    }
