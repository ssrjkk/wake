"""
Модуль предсказаний: create/trade/resolve/claim для price- и event-рынков.
Логика уже протестирована отдельно (test_predict_amm.py, test_predict_resolution.py,
test_predict_db.py, test_predict_integration.py — полный цикл
create->trade->resolve->claim, test_predict_resolver.py — закрытие price-рынков).
Этот слой — только HTTP-обвязка.

Чем защищён этот слой:
- создание рынков и резолюция — токен куратора (api/guards.py);
- трейд, позиции и claim — субъект токена сессии. Пока user_id приезжал в теле,
  «сыграть на чужом месте» и «забрать чужой выигрыш» стоили одну строку JSON:
  market_id публичен, а user_id достаточно подсмотреть в чужих позициях.

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

import math
import time as _time
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

import predict_db as pdb
import audit_log as al
from api.guards import require_curator, require_user
from predict_amm import LMSRMarket
from predict_resolution import resolve_price_market, resolve_event_market, Comparator
from config import LIGHTER_NETWORK

router = APIRouter()

MIN_QUESTION_CHARS = 3
MAX_QUESTION_CHARS = 300
# Дальше этого срока рынок никто не ждёт, а «вечный» дедлайн означает, что
# резолюция никогда не придёт и строка будет жить в списке открытой вечно.
MAX_MARKET_HORIZON_S = 10 * 365 * 86_400
# Резерв маркетмейкера равен b·ln2 (predict_amm.max_subsidy), поэтому потолок у b
# — это потолок суммы, которую рынок вообще способен выдать трейдеру из ничего.
MAX_LMSR_B = 10_000_000
MAX_SHARES = 1_000_000_000


class CreateMarketBase(BaseModel):
    """Общее для price- и event-рынков: вопрос, дедлайн, ликвидность.

    Границы нужны здесь, а не «где-то в базе»: эти числа уезжают обратно в
    публичный JSON, а Starlette сериализует с allow_nan=False — одно NaN в строке
    рынка стоит 500 на весь GET /predict/markets для всех посетителей (проверено:
    ValueError «Out of range float values are not JSON compliant»). NaN к тому же
    проходит любую проверку вида `v <= now`, потому что сравнение с NaN — False."""

    question: str = Field(min_length=MIN_QUESTION_CHARS, max_length=MAX_QUESTION_CHARS)
    resolve_at: float = Field(gt=0, allow_inf_nan=False)
    b: float = Field(default=100.0, gt=0, le=MAX_LMSR_B, allow_inf_nan=False)

    @field_validator("resolve_at")
    @classmethod
    def resolve_at_in_future(cls, v: float) -> float:
        now = _time.time()
        if v <= now:
            raise ValueError("resolve_at must be in the future")
        if v > now + MAX_MARKET_HORIZON_S:
            raise ValueError(
                f"resolve_at не дальше {MAX_MARKET_HORIZON_S // 86_400} лет от сегодня"
            )
        return v


class CreatePriceMarket(CreateMarketBase):
    # market_id Lighter — неотрицательный индекс книги; отрицательный означал бы
    # рынок, свечей которого нет, и резолюция падала бы на дедлайне.
    lighter_market_id: int = Field(ge=0)
    threshold: float = Field(gt=0, allow_inf_nan=False)
    comparator: Literal[">=", "<=", ">", "<"]


class CreateEventMarket(CreateMarketBase):
    pass


class TradeRequest(BaseModel):
    outcome: Literal["yes", "no"]
    shares: float = Field(allow_inf_nan=False, ge=-MAX_SHARES, le=MAX_SHARES)

    @field_validator("shares")
    @classmethod
    def shares_nonzero(cls, v: float) -> float:
        if v == 0:
            raise ValueError("shares — ненулевое конечное число")
        return v


class ResolveEventRequest(BaseModel):
    """resolved_by и evidence_url ограничены по длине: обе строки попадают в
    аудит и в интерфейс рынка, где их читает каждый посетитель."""

    outcome: str
    resolved_by: str = Field(min_length=1, max_length=120)
    evidence_url: str = Field(min_length=1, max_length=2000)


class ResolvePriceRequest(BaseModel):
    network: str = LIGHTER_NETWORK


def _with_prices(row: dict, stats: dict) -> dict:
    amm = LMSRMarket(b=row["b"], q_yes=row["q_yes"], q_no=row["q_no"])
    s = stats.get(row["id"], {})
    return row | {
        "price_yes": amm.price_yes(),
        "price_no": amm.price_no(),
        "max_subsidy": amm.max_subsidy(),
        "volume_usd": s.get("volume_usd") or 0.0,
        "trade_count": s.get("trade_count") or 0,
    }


@router.post("/predict/markets/price")
async def create_price_market(
    req: CreatePriceMarket, _curator: None = Depends(require_curator)
):
    market_id = str(uuid.uuid4())
    await pdb.create_market(
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
async def create_event_market(
    req: CreateEventMarket, _curator: None = Depends(require_curator)
):
    market_id = str(uuid.uuid4())
    await pdb.create_market(market_id, "event", req.question, req.resolve_at, req.b)
    return {"market_id": market_id}


@router.get("/predict/markets")
async def list_predict_markets(
    status: str = Query("open", pattern="^(open|resolved|all)$"),
):
    rows = await pdb.list_markets(status)
    stats = await pdb.market_stats()
    return [_with_prices(r, stats) for r in rows]


@router.get("/predict/positions")
async def list_positions(user_id: str = Depends(require_user)):
    """Позиции текущего пользователя по всем рынкам — включая резолвленные, где
    уже можно забрать выигрыш. Список берётся из его же сделок, поэтому это его
    данные, а не чужая статистика: чужой user_id сюда подставить нечем."""
    rows = await pdb.list_user_positions(user_id)
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
async def get_predict_market(market_id: str):
    m = await pdb.get_market(market_id)
    if m is None:
        raise HTTPException(status_code=404, detail="рынок не найден")
    stats = await pdb.market_stats()
    return _with_prices(m, stats)


@router.get("/predict/markets/{market_id}/preview")
async def preview_trade(market_id: str, outcome: Literal["yes", "no"], shares: float):
    """Расчёт цены сделки без записи в базу. shares проверяется так же, как в
    TradeRequest: ноль и NaN здесь дают не «пустой ответ», а число в карточке
    рынка, которое человек принимает за настоящую цену."""
    m = await pdb.get_market(market_id)
    if m is None:
        raise HTTPException(status_code=404, detail="рынок не найден")
    if not math.isfinite(shares) or shares == 0 or abs(shares) > MAX_SHARES:
        raise HTTPException(status_code=400, detail="shares — ненулевое конечное число")
    amm = LMSRMarket(b=m["b"], q_yes=m["q_yes"], q_no=m["q_no"])
    try:
        cost = amm.cost_to_trade(outcome, shares)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"cost_usd": cost}


@router.post("/predict/markets/{market_id}/trade")
async def trade_predict_market(
    market_id: str, req: TradeRequest, user_id: str = Depends(require_user)
):
    trade_id = str(uuid.uuid4())
    try:
        cost = await pdb.record_trade(
            trade_id, user_id, market_id, req.outcome, req.shares
        )
    except ValueError as e:
        await al.log_action(
            al.AuditEntry(
                actor=user_id,
                action="trade_executed",
                resource=market_id,
                details={
                    "outcome": req.outcome,
                    "shares": req.shares,
                    "error": str(e),
                },
                success=False,
            )
        )
        raise HTTPException(status_code=400, detail=str(e))
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="trade_executed",
            resource=market_id,
            details={
                "outcome": req.outcome,
                "shares": req.shares,
                "cost_usd": cost,
                "trade_id": trade_id,
            },
            success=True,
        )
    )
    return {"trade_id": trade_id, "cost_usd": cost}


@router.post("/predict/markets/{market_id}/resolve-event")
async def resolve_event(
    market_id: str, req: ResolveEventRequest, _curator: None = Depends(require_curator)
):
    current = await pdb.get_market(market_id)
    if current is None:
        raise HTTPException(status_code=404, detail="рынок не найден")
    if current["status"] != "open":
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
    try:
        await pdb.resolve_market(
            market_id,
            resolution.outcome,
            resolution.resolved_by,
            resolution.evidence_url,
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    # Аудит — после того, как исход записан. Запись о резолюции, которая
    # не состоялась (409 от параллельного резолвера), ухудшает аудит сильнее,
    # чем её отсутствие.
    await al.log_action(
        al.AuditEntry(
            actor=resolution.resolved_by,
            action="market_resolution",
            resource=market_id,
            details={
                "outcome": resolution.outcome,
                "evidence_url": resolution.evidence_url,
                "resolved_at": resolution.resolved_at,
            },
            success=True,
        )
    )
    return {
        "outcome": resolution.outcome,
        "resolved_by": resolution.resolved_by,
        "evidence_url": resolution.evidence_url,
    }


@router.post("/predict/markets/{market_id}/resolve-price")
async def resolve_price(
    market_id: str, req: ResolvePriceRequest, _curator: None = Depends(require_curator)
):
    """Ручной триггер того же пути, что проходит predict_resolver.py по таймеру,
    для случая «резолвер ещё не поднят как процесс».

    Под токеном куратора, хотя цену даёт Lighter, а не оператор: право вынести
    исход по внешнему оракулу — не то, чем должен владеть держатель позиции.
    Цена берётся НЕ «какая сейчас», а на дедлайне рынка (get_price_at): иначе
    ручным триггером можно было бы резолвить рынок недельной давности ценой
    сегодняшнего дня, и куратор становился бы оракулом по своему выбору момента.
    Резолвер закрывает рынок в течение WAKE_PREDICT_RESOLVER_TICK после дедлайна,
    так что ручным триггером куратор догоняет пропущенные тики, а не пересоздаёт
    исход."""
    from lighter_rest import get_price_at

    now = _time.time()
    m = await pdb.get_market(market_id)
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
    # Сетевой вызов вне сессии БД и вне event loop: соединение с пулом не
    # держится открытым через запрос к Lighter, а блокирующий urllib не
    # останавливает остальные запросы.
    try:
        observed = await run_in_threadpool(
            get_price_at, m["lighter_market_id"], m["resolve_at"], req.network
        )
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    try:
        comparator = Comparator(m["comparator"])
    except ValueError:
        # Строка могла появиться только через прямую правку в базе: создать рынок
        # с другим значением не даёт Literal на модели. Ответ — 409 с текстом, а
        # не 500 на ValueError из enum.
        raise HTTPException(
            status_code=409,
            detail=f"рынок создан с неизвестным условием сравнения {m['comparator']!r}",
        )
    resolution = resolve_price_market(observed, m["threshold"], comparator)
    try:
        await pdb.resolve_market(
            market_id, resolution.outcome, "auto:lighter_mark_price", None
        )
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await al.log_action(
        al.AuditEntry(
            actor=f"curator:{_curator_identity()}",
            action="market_resolution",
            resource=market_id,
            details={
                "outcome": resolution.outcome,
                "observed_price": resolution.observed_price,
                "threshold": resolution.threshold,
                "comparator": resolution.comparator.value,
                "resolve_at": m["resolve_at"],
                "network": req.network,
                "trigger": "manual",
            },
            success=True,
        )
    )
    return {
        "outcome": resolution.outcome,
        "observed_price": observed,
        "observed_at": m["resolve_at"],
        "network": req.network,
        "resolve_at": m["resolve_at"],
    }


def _curator_identity() -> str:
    """Кто именно дёрнул ручной триггер. Имени у машинного токена нет, поэтому в
    аудит идёт его префикс — этого хватает, чтобы отличить ручную резолюцию от
    автоматической и не светить секрет в таблице."""
    from config import CURATOR_TOKEN

    return (CURATOR_TOKEN or "")[:8] or "curator"


@router.post("/predict/markets/{market_id}/claim")
async def claim_predict(market_id: str, user_id: str = Depends(require_user)):
    """Выплата по резолвнутому рынку. Субъект берётся из токена: до этого claim
    принимал user_id в query, и достаточно было знать чужой id (он виден в
    публичной статистике рынка), чтобы забрать чужой выигрыш."""
    try:
        payout = await pdb.claim_winnings(user_id, market_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="predict_claim",
            resource=market_id,
            details={"payout_usd": payout},
            success=payout > 0,
        )
    )
    return {"payout_usd": payout}
