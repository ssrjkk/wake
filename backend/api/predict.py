"""
Модуль предсказаний: create/trade/resolve/claim для price- и event-рынков.
Логика уже протестирована отдельно (test_predict_amm.py 17/17,
test_predict_resolution.py 10/10, test_predict_db.py, test_predict_integration.py
— полный цикл create->trade->resolve->claim). Этот слой — только HTTP-обвязка.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

import hmac
import os
import time as _time
import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import predict_db as pdb
import audit_log as al
from predict_amm import LMSRMarket
from predict_resolution import resolve_price_market, resolve_event_market, Comparator
from config import DB_PATH, AUDIT_DB_PATH

router = APIRouter()


class CreatePriceMarket(BaseModel):
    question: str
    lighter_market_id: int
    threshold: float
    comparator: str  # ">=" | "<=" | ">" | "<"
    resolve_at: float
    b: float = 100


class CreateEventMarket(BaseModel):
    question: str
    resolve_at: float
    b: float = 100


class TradeRequest(BaseModel):
    user_id: str
    outcome: str  # "yes" | "no"
    shares: float  # >0 купить, <0 продать


class ResolveEventRequest(BaseModel):
    outcome: str
    resolved_by: str
    evidence_url: str


class ResolvePriceRequest(BaseModel):
    network: str = "testnet"


@router.post("/predict/markets/price")
def create_price_market(req: CreatePriceMarket):
    market_id = str(uuid.uuid4())
    with pdb.connect(DB_PATH) as conn:
        pdb.create_market(conn, market_id, "price", req.question, req.resolve_at, req.b,
                           lighter_market_id=req.lighter_market_id, threshold=req.threshold,
                           comparator=req.comparator)
    return {"market_id": market_id}


@router.post("/predict/markets/event")
def create_event_market(req: CreateEventMarket):
    # [!]  В проде — только для доверенных кураторов. Авторизация: простой
    # секретный токен в заголовке X-Curator-Token (сравнение через hmac.compare_digest
    # для защиты от timing-атак). В проде заменить на полноценный auth-слой.
    curator_token = os.environ.get("WAKE_CURATOR_TOKEN", "")
    if not curator_token:
        raise HTTPException(status_code=500, detail="WAKE_CURATOR_TOKEN не настроен на сервере")
    auth_header = req.headers.get("X-Curator-Token", "")
    if not hmac.compare_digest(auth_header, curator_token):
        raise HTTPException(status_code=403, detail="Недостаточно прав для создания event-рынка")
    market_id = str(uuid.uuid4())
    with pdb.connect(DB_PATH) as conn:
        pdb.create_market(conn, market_id, "event", req.question, req.resolve_at, req.b)
    return {"market_id": market_id}


@router.get("/predict/markets")
def list_predict_markets():
    with pdb.connect(DB_PATH) as conn:
        rows = pdb.list_open_markets(conn)
    result = []
    for r in rows:
        amm = LMSRMarket(b=r["b"], q_yes=r["q_yes"], q_no=r["q_no"])
        result.append(dict(r) | {"price_yes": amm.price_yes(), "price_no": amm.price_no()})
    return result


@router.get("/predict/markets/{market_id}")
def get_predict_market(market_id: str):
    with pdb.connect(DB_PATH) as conn:
        m = pdb.get_market(conn, market_id)
        if m is None:
            raise HTTPException(status_code=404, detail="рынок не найден")
    amm = LMSRMarket(b=m["b"], q_yes=m["q_yes"], q_no=m["q_no"])
    return dict(m) | {"price_yes": amm.price_yes(), "price_no": amm.price_no()}


@router.get("/predict/markets/{market_id}/preview")
def preview_trade(market_id: str, outcome: str, shares: float):
    with pdb.connect(DB_PATH) as conn:
        m = pdb.get_market(conn, market_id)
        if m is None:
            raise HTTPException(status_code=404, detail="рынок не найден")
    amm = LMSRMarket(b=m["b"], q_yes=m["q_yes"], q_no=m["q_no"])
    try:
        cost = amm.cost_to_trade(outcome, shares)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"cost_usd": cost}


@router.post("/predict/markets/{market_id}/trade")
def trade_predict_market(market_id: str, req: TradeRequest):
    trade_id = str(uuid.uuid4())
    with pdb.connect(DB_PATH) as conn:
        try:
            cost = pdb.record_trade(conn, trade_id, req.user_id, market_id, req.outcome, req.shares)
        except ValueError as e:
            with al.connect(AUDIT_DB_PATH) as aconn:
                al.log_action(aconn, al.AuditEntry(
                    actor=req.user_id, action="trade_executed", resource=market_id,
                    details={"outcome": req.outcome, "shares": req.shares, "error": str(e)}, success=False,
                ))
            raise HTTPException(status_code=400, detail=str(e))
    with al.connect(AUDIT_DB_PATH) as aconn:
        al.log_action(aconn, al.AuditEntry(
            actor=req.user_id, action="trade_executed", resource=market_id,
            details={"outcome": req.outcome, "shares": req.shares, "cost_usd": cost, "trade_id": trade_id}, success=True,
        ))
    return {"trade_id": trade_id, "cost_usd": cost}


@router.post("/predict/markets/{market_id}/resolve-event")
def resolve_event(market_id: str, req: ResolveEventRequest):
    try:
        resolution = resolve_event_market(req.outcome, req.resolved_by, _time.time(), req.evidence_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    with pdb.connect(DB_PATH) as conn:
        pdb.resolve_market(conn, market_id, resolution.outcome, resolution.resolved_by, resolution.evidence_url)
    return {"outcome": resolution.outcome}


@router.post("/predict/markets/{market_id}/resolve-price")
def resolve_price(market_id: str, req: ResolvePriceRequest):
    from lighter_rest import get_mark_price  # не тестировалось живьём — нет сети в этой песочнице
    with pdb.connect(DB_PATH) as conn:
        m = pdb.get_market(conn, market_id)
        if m is None or m["kind"] != "price":
            raise HTTPException(status_code=400, detail="не price-рынок")
        observed = get_mark_price(m["lighter_market_id"], req.network)
        resolution = resolve_price_market(observed, m["threshold"], Comparator(m["comparator"]))
        pdb.resolve_market(conn, market_id, resolution.outcome, "auto:lighter_mark_price", None)
    return {"outcome": resolution.outcome, "observed_price": observed}


@router.post("/predict/markets/{market_id}/claim")
def claim_predict(market_id: str, user_id: str):
    with pdb.connect(DB_PATH) as conn:
        try:
            payout = pdb.claim_winnings(conn, user_id, market_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    return {"payout_usd": payout}