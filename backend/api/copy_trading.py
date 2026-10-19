"""
Копи-трейдинг: подписчики, лидеры, подписки, журнал зеркалирования и ручной
прогон mirror_engine через HTTP.

Логика доступа к базе — в db.py, сам движок — в mirror_engine.py; этот слой —
HTTP-обвязка и Pydantic-модели, без SQL: запросы, уехавшие в эндпоинты, не
проверяются на владении записью.

Кто есть кто решает токен сессии (api/guards.py), а не поля запроса. Раньше
follower_id приезжал в теле или query, и эндпоинт верил: зная чужой id, можно
было прочитать чужой mirror-лог, поставить чужой подписке паузу и забрать её
выигрыш. Теперь субъект токена — единственное, чем измеряется «своё».

Индекс аккаунта Lighter тоже берется не из запроса: его привязывает вход
кошелька (api/auth.py, proof-of-ownership), иначе опубликовать лидера можно было
под чужим аккаунтом и его статистикой.
"""

import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import IntegrityError

import audit_log as al
import db
from api.guards import deny, require_curator, require_user
from mirror_engine import (
    FollowerConfig,
    LeaderEvent,
    MarketConstraints,
    Side,
    compute_mirror_plan,
)

router = APIRouter()

FEE_BPS_MAX = 500
LEVERAGE_MAX = 50


class RegisterLeader(BaseModel):
    handle: str
    fee_bps: int = 8

    @field_validator("handle")
    @classmethod
    def handle_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not 1 <= len(v) <= 48:
            raise ValueError("handle: 1–48 символов без пробелов по краям")
        return v

    @field_validator("fee_bps")
    @classmethod
    def fee_in_range(cls, v: int) -> int:
        if not 0 <= v <= FEE_BPS_MAX:
            raise ValueError(f"fee_bps вне диапазона 0–{FEE_BPS_MAX} (0–5%)")
        return v


class CreateFollow(BaseModel):
    leader_id: str
    allocation_usd: float
    max_leverage: float = 3

    @field_validator("allocation_usd")
    @classmethod
    def allocation_positive(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("allocation_usd — положительное конечное число")
        return v

    @field_validator("max_leverage")
    @classmethod
    def leverage_in_range(cls, v: float) -> float:
        if not math.isfinite(v) or not 1 <= v <= LEVERAGE_MAX:
            raise ValueError(
                f"max_leverage вне диапазона 1–{LEVERAGE_MAX}: "
                "за этим пределом копия сделки — не копия, а верная ликвидация"
            )
        return v


class UpdateLeaderFee(BaseModel):
    fee_bps: int

    @field_validator("fee_bps")
    @classmethod
    def fee_in_range(cls, v: int) -> int:
        if not 0 <= v <= FEE_BPS_MAX:
            raise ValueError(f"fee_bps вне диапазона 0–{FEE_BPS_MAX} (0–5%)")
        return v


class SimulateMirrorRequest(BaseModel):
    leader_id: str
    market_id: int
    side: str  # "long" | "short"
    is_increase: bool
    size_delta: float
    price: float
    leader_equity_usd: float
    leader_position_before: float = 0
    min_base_amount: float = 0.001
    size_decimals: int = 3


async def _own_account_index(user_id: str) -> int | None:
    """Индекс Lighter, привязанный к этой записи подписчика входом кошелька."""
    row = await db.follower(user_id)
    if row is None:
        raise deny(
            401,
            "SESSION_UNKNOWN_USER",
            "Токен выдан для записи, которой больше нет в базе — войди заново",
        )
    return row["lighter_account_index"]


# ── Публичное чтение: это витрина, она открыта без входа ──────────────────────


@router.get("/leaders")
async def list_leaders():
    return await db.all_leaders()


@router.get("/follows/by-leader/{leader_id}")
async def list_follows_for_leader(leader_id: str):
    rows = await db.follows_for_leader(leader_id)
    return {
        "follower_count": len(rows),
        "total_aum_usd": sum(r["allocation_usd"] for r in rows),
        "follows": rows,
    }


# ── Всё, у чего есть владелец ────────────────────────────────────────────────


@router.post("/leaders")
async def register_leader(req: RegisterLeader, user_id: str = Depends(require_user)):
    """Публикация лидера. Индекс аккаунта берётся из записи, привязанной входом
    кошелька: без этого шага неясно, чью статистику покажет карточка в Discover."""
    account_index = await _own_account_index(user_id)
    if account_index is None:
        raise deny(
            403,
            "LIGHTER_ACCOUNT_NOT_LINKED",
            "Лидер публикуется по индексу аккаунта Lighter — войди ещё и кошельком, "
            "чтобы адрес подтвердился подписью",
        )

    existing = await db.leader_by_account_index(account_index)
    if existing:
        return {"leader_id": existing["id"]}

    leader_id = str(uuid.uuid4())
    await db.upsert_leader(leader_id, account_index, req.handle, req.fee_bps)
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="leader_registered",
            resource=f"leader:{leader_id}",
            details={
                "handle": req.handle,
                "fee_bps": req.fee_bps,
                "lighter_account_index": account_index,
            },
            success=True,
        )
    )
    return {"leader_id": leader_id}


@router.patch("/leaders/{leader_id}/fee")
async def update_leader_fee(
    leader_id: str, req: UpdateLeaderFee, user_id: str = Depends(require_user)
):
    """Лидер меняет комиссию в любой момент. Влияет только на то, что подписчик
    увидит в Discover после изменения, — уже созданные строки follows не пересчитываются
    (в них нет комиссии: она хранится один раз в leaders.fee_bps)."""
    row = await db.leader(leader_id)
    if not row:
        raise deny(404, "LEADER_NOT_FOUND", "Лидер не найден")
    if row["lighter_account_index"] != await _own_account_index(user_id):
        raise deny(
            403,
            "LEADER_NOT_OWNED",
            "Комиссию меняет только тот, чей вход подтвердил этот аккаунт Lighter",
        )
    await db.upsert_leader(
        leader_id, row["lighter_account_index"], row["handle"], req.fee_bps
    )
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="leader_fee_changed",
            resource=f"leader:{leader_id}",
            details={"fee_bps": req.fee_bps},
            success=True,
        )
    )
    return {"leader_id": leader_id, "fee_bps": req.fee_bps}


@router.get("/follows")
async def list_own_follows(user_id: str = Depends(require_user)):
    return await db.follows_for_follower(user_id)


@router.post("/follows")
async def create_follow(req: CreateFollow, user_id: str = Depends(require_user)):
    follow_id = str(uuid.uuid4())
    try:
        await db.create_follow(
            follow_id,
            user_id,
            req.leader_id,
            req.allocation_usd,
            req.max_leverage,
        )
    except IntegrityError:
        # Скорее всего UNIQUE(follower_id, leader_id) — уже подписан на этого
        # лидера. Реже — FK: подписчика или лидера не существует. Форма отказа
        # одна: различие клиенту опереть не на что, оба случая значат «так нельзя».
        raise HTTPException(
            status_code=400,
            detail="Подписка уже существует или невалидны данные",
        ) from None
    return {"follow_id": follow_id}


@router.post("/follows/{follow_id}/pause")
async def pause_follow(follow_id: str, user_id: str = Depends(require_user)):
    if not await db.owned_follow(follow_id, user_id):
        raise deny(
            404, "FOLLOW_NOT_FOUND", "Подписка не найдена или не принадлежит тебе"
        )
    await db.set_paused(follow_id, True)
    return {"status": "paused"}


@router.post("/follows/{follow_id}/resume")
async def resume_follow(follow_id: str, user_id: str = Depends(require_user)):
    if not await db.owned_follow(follow_id, user_id):
        raise deny(
            404, "FOLLOW_NOT_FOUND", "Подписка не найдена или не принадлежит тебе"
        )
    await db.set_paused(follow_id, False)
    return {"status": "active"}


@router.delete("/follows/{follow_id}")
async def remove_follow(follow_id: str, user_id: str = Depends(require_user)):
    if not await db.delete_follow(follow_id, user_id):
        raise deny(
            404, "FOLLOW_NOT_FOUND", "Подписка не найдена или не принадлежит тебе"
        )
    return {"status": "deleted"}


@router.get("/mirror-log")
async def list_mirror_log(
    limit: int = Query(50, ge=1, le=200), user_id: str = Depends(require_user)
):
    return await db.mirror_log_for_follower(user_id, limit)


# ── Операторский инструмент ──────────────────────────────────────────────────


@router.post("/simulate-mirror", dependencies=[Depends(require_curator)])
async def simulate_mirror(req: SimulateMirrorRequest):
    """Ручной прогон mirror_engine через HTTP — без живого WS-события от лидера.
    Полезно, чтобы своими глазами увидеть MirrorPlan для конкретных подписчиков
    из базы, не поднимая leader_listener.py целиком.

    Под токеном куратора: ответ перечисляет аллокации и зеркаленные размеры всех
    подписчиков лидера, а это не публичные данные.
    """
    rows = await db.active_follows_for_leader(req.leader_id)

    followers = [
        FollowerConfig(
            follower_id=r["follower_id"],
            allocation_usd=r["allocation_usd"],
            available_margin_usd=r[
                "allocation_usd"
            ],  # упрощение: реальная свободная маржа с Lighter API не подтянута здесь
            max_leverage=r["max_leverage"],
            current_mirrored_size=r["current_mirrored_size"],
        )
        for r in rows
    ]

    event = LeaderEvent(
        market_id=req.market_id,
        side=Side.LONG if req.side == "long" else Side.SHORT,
        is_increase=req.is_increase,
        size_delta=req.size_delta,
        price=req.price,
        leader_equity_usd=req.leader_equity_usd,
        leader_position_before=req.leader_position_before,
    )
    constraints = MarketConstraints(
        min_base_amount=req.min_base_amount, size_decimals=req.size_decimals
    )

    plan = compute_mirror_plan(event, followers, constraints)
    return {
        "orders": [o.__dict__ | {"side": o.side.value} for o in plan.orders],
        "skipped": [s.__dict__ for s in plan.skipped],
    }
