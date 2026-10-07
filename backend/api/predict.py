"""
Модуль предсказаний: create/trade/resolve/claim для price- и event-рынков.
Логика уже протестирована отдельно (test_predict_amm.py, test_predict_resolution.py,
test_predict_db.py, test_predict_integration.py — полный цикл
create->trade->resolve->claim, test_predict_resolver.py — закрытие price-рынков).
Этот слой — только HTTP-обвязка.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

import hmac
import os
import time as _time
import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, field_validator

import predict_db as pdb
import audit_log as al
from predict_amm import LMSRMarket
from predict_resolution import resolve_price_market, resolve_event_market, Comparator
from config import DB_PATH, AUDIT_DB_PATH, LIGHTER_NETWORK

router = APIRouter()


def _require_curator(request: Request):
    """Создание рынков (price и event) и резолюция событий — только доверенные кураторы.
    Простой секретный токен в заголовке X-Curator-Token, сравнение через
    hmac.compare_digest (защита от timing-атак). Price-рынки под тем же гейтом,
    иначе любой может создать рынок с произвольным порогом и зарезолвить его
    против своей позиции. В проде заменить на полноценный auth-слой."""
    curator_token = os.environ.get("WAKE_CURATOR_TOKEN", "")
    if not curator_token:
        raise HTTPException(
            status_code=500, detail="WAKE_CURATOR_TOKEN не настроен на сервере"
        )
    auth_header = request.headers.get("X-Curator-Token", "")
    if not hmac.compare_digest(auth_header, curator_token):
        raise HTTPException(
            status_code=403, detail="Недостаточно прав: требуется токен куратора"
        )


class CreatePriceMarket(BaseModel):
    question: str
    lighter_market_id: int
    threshold: float
    comparator: Literal[">=", "<=", ">", "<"]
    resolve_at: float
    b: float = 100

    @field_validator("resolve_at")
    @classmethod
    def resolve_at_in_future(cls, v: float) -> float:
        if v <= _time.time():
            raise ValueError("resolve_at must be in the future")
        return v

    @field_validator("b")
    @classmethod
    def b_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("b must be positive")
        return v


class CreateEventMarket(BaseModel):
    question: str
    resolve_at: float
    b: float = 100

    @field_validator("resolve_at")
    @classmethod
    def resolve_at_in_future(cls, v: float) -> float:
        if v <= _time.time():
            raise ValueError("resolve_at must be in the future")
        return v

    @field_validator("b")
    @classmethod
    def b_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("b must be positive")
        return v


class TradeRequest(BaseModel):
    user_id: str
    outcome: Literal["yes", "no"]
    shares: float

    @field_validator("shares")
    @classmethod
    def shares_nonzero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("shares must not be zero")
        return v


class ResolveEventRequest(BaseModel):
    outcome: str
    resolved_by: str
    evidence_url: str


class ResolvePriceRequest(BaseModel):
    network: str = LIGHTER_NETWORK


def _with_prices(row, stats: dict) -> dict:
    amm = LMSRMarket(b=row["b"], q_yes=row["q_yes"], q_no=row["q_no"])
    s = stats.get(row["id"], {})
    return dict(row) | {
        "price_yes": amm.price_yes(),
        "price_no": amm.price_no(),
        "max_subsidy": amm.max_subsidy(),
        "volume_usd": s.get("volume_usd") or 0.0,
        "trade_count": s.get("trade_count") or 0,
    }


@router.post("/predict/markets/price")
def create_price_market(req: CreatePriceMarket, request: Request):
    _require_curator(request)
    market_id = str(uuid.uuid4())
    with pdb.connect(DB_PATH) as conn:
        pdb.create_market(
            conn,
            market_id,
            "price",
            req.question,
            req.resolve_at,
            req.b,
            lighter_market_id=req.lighter_market_id,
            threshold=req.threshold,
            comparator=req.comparator,
        )
    return {"market_id": market_id}


@router.post("/predict/markets/event")
def create_event_market(req: CreateEventMarket, request: Request):
    _require_curator(request)
    market_id = str(uuid.uuid4())
    with pdb.connect(DB_PATH) as conn:
        pdb.create_market(conn, market_id, "event", req.question, req.resolve_at, req.b)
    return {"market_id": market_id}


@router.get("/predict/markets")
def list_predict_markets(status: str = Query("open", pattern="^(open|resolved|all)$")):
    with pdb.connect(DB_PATH) as conn:
        rows = pdb.list_markets(conn, status)
        stats = pdb.market_stats(conn)
    return [_with_prices(r, stats) for r in rows]


@router.get("/predict/positions")
def list_positions(user_id: str):
    """Позиции юзера по всем рынкам — включая резолвленные, где уже можно забрать
    выигрыш. Считается по predict_trades, поэтому это данные о его же сделках,
    а не чужой статистика: эндпоинт не раскрывает позиции других."""
    with pdb.connect(DB_PATH) as conn:
        rows = pdb.list_user_positions(conn, user_id)
    result = []
    for r in rows:
        amm = LMSRMarket(b=r["b"], q_yes=r["q_yes"], q_no=r["q_no"])
        shares = r["shares"]
        net_cost = r["net_cost"] or 0.0
        market_payout = (
            shares * 1.0
            if (r["status"] == "resolved" and r["market_outcome"] == r["outcome"])
            else 0.0
        )
        result.append(
            {
                "market_id": r["market_id"],
                "question": r["question"],
                "kind": r["kind"],
                "market_status": r["status"],
                "market_outcome": r["market_outcome"],
                "resolve_at": r["resolve_at"],
                "outcome": r["outcome"],
                "shares": shares,
                "net_cost_usd": net_cost,
                "avg_entry_usd": net_cost / shares if shares > 0 else 0.0,
                "mark_price": amm.price_yes()
                if r["outcome"] == "yes"
                else amm.price_no(),
                "mark_value_usd": amm.price_yes() * shares
                if r["outcome"] == "yes"
                else amm.price_no() * shares,
                "claimable_usd": 0.0 if r["claimed"] else market_payout,
                "claimed": bool(r["claimed"]),
            }
        )
    return result


@router.get("/predict/markets/{market_id}")
def get_predict_market(market_id: str):
    with pdb.connect(DB_PATH) as conn:
        m = pdb.get_market(conn, market_id)
        if m is None:
            raise HTTPException(status_code=404, detail="рынок не найден")
        stats = pdb.market_stats(conn)
    return _with_prices(m, stats)


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
            cost = pdb.record_trade(
                conn, trade_id, req.user_id, market_id, req.outcome, req.shares
            )
        except ValueError as e:
            with al.connect(AUDIT_DB_PATH) as aconn:
                al.log_action(
                    aconn,
                    al.AuditEntry(
                        actor=req.user_id,
                        action="trade_executed",
                        resource=market_id,
                        details={
                            "outcome": req.outcome,
                            "shares": req.shares,
                            "error": str(e),
                        },
                        success=False,
                    ),
                )
            raise HTTPException(status_code=400, detail=str(e))
    with al.connect(AUDIT_DB_PATH) as aconn:
        al.log_action(
            aconn,
            al.AuditEntry(
                actor=req.user_id,
                action="trade_executed",
                resource=market_id,
                details={
                    "outcome": req.outcome,
                    "shares": req.shares,
                    "cost_usd": cost,
                    "trade_id": trade_id,
                },
                success=True,
            ),
        )
    return {"trade_id": trade_id, "cost_usd": cost}


@router.post("/predict/markets/{market_id}/resolve-event")
def resolve_event(market_id: str, req: ResolveEventRequest, request: Request):
    _require_curator(request)
    with pdb.connect(DB_PATH) as conn:
        current = pdb.get_market(conn, market_id)
    if current is None:
        raise HTTPException(status_code=404, detail="рынок не найден")
    if current["status"] != "open":
        # Проверка до audit_log: запись о резолюции, которая не состоялась,
        # ухудшает аудит хуже, чем её отсутствие.
        raise HTTPException(
            status_code=409,
            detail=f"рынок уже резолвлен с исходом {current['outcome']}",
        )
    try:
        resolution = resolve_event_market(
            req.outcome, req.resolved_by, _time.time(), req.evidence_url
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    with pdb.connect(DB_PATH) as conn:
        try:
            pdb.resolve_market(
                conn,
                market_id,
                resolution.outcome,
                resolution.resolved_by,
                resolution.evidence_url,
            )
        except ValueError as e:
            raise HTTPException(status_code=409, detail=str(e))
    return {
        "outcome": resolution.outcome,
        "resolved_by": resolution.resolved_by,
        "evidence_url": resolution.evidence_url,
    }


@router.post("/predict/markets/{market_id}/resolve-price")
def resolve_price(market_id: str, req: ResolvePriceRequest, request: Request):
    """Ручной триггер того же пути, что проходит predict_resolver.py по таймеру,
    для случая «резолвер ещё не поднят как процесс».

    Под токеном куратора, хотя цена приходит с Lighter, а не от оператора: mark-цена
    берётся в момент вызова, поэтому без гейта держатель позиции сам выбирал бы момент,
    по которому решается его же ставка. Резолвер закрывает рынок в течение
    WAKE_PREDICT_RESOLVER_TICK после дедлайна, так что ручным триггером куратор
    догоняет пропущенные тики, а не пересоздаёт исход."""
    _require_curator(request)
    from lighter_rest import get_mark_price

    now = _time.time()
    with pdb.connect(DB_PATH) as conn:
        m = pdb.get_market(conn, market_id)
        if m is None:
            raise HTTPException(status_code=404, detail="рынок не найден")
        if m["kind"] != "price":
            raise HTTPException(status_code=400, detail="не price-рынок")
        if m["status"] != "open":
            raise HTTPException(
                status_code=409, detail=f"рынок уже резолвлен с исходом {m['outcome']}"
            )
        if now < m["resolve_at"]:
            raise HTTPException(
                status_code=409,
                detail=f"дедлайн рынка ещё не наступил (resolve_at={int(m['resolve_at'])}, сейчас {int(now)})",
            )
        try:
            observed = get_mark_price(m["lighter_market_id"], req.network)
        except RuntimeError as e:
            raise HTTPException(status_code=502, detail=str(e))
        resolution = resolve_price_market(
            observed, m["threshold"], Comparator(m["comparator"])
        )
        pdb.resolve_market(
            conn, market_id, resolution.outcome, "auto:lighter_mark_price", None
        )
    return {
        "outcome": resolution.outcome,
        "observed_price": observed,
        "network": req.network,
        "resolve_at": m["resolve_at"],
    }


@router.post("/predict/markets/{market_id}/claim")
def claim_predict(market_id: str, user_id: str):
    with pdb.connect(DB_PATH) as conn:
        try:
            payout = pdb.claim_winnings(conn, user_id, market_id)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    return {"payout_usd": payout}
