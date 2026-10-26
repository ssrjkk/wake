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

import logging
import math
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError

import audit_log as al
import db
from starlette.concurrency import run_in_threadpool
from api.guards import deny, require_curator, require_user
import lighter_rest
from config import LIGHTER_NETWORK
from mirror_engine import (
    FollowerConfig,
    LeaderEvent,
    MarketConstraints,
    Side,
    SkippedFollower,
    compute_mirror_plan,
)

logger = logging.getLogger("wake.api.copy_trading")

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
    allocation_usd: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)
    max_leverage: float = 3

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


class UpdateLeaderActive(BaseModel):
    """`active` — строго bool. В мягком режиме pydantic превращает в истину
    «yes», «1» и «on», и запрос, который человек писал как «выключить», стал бы
    включением: строка в JSON-поле — это не то же самое, что false."""

    active: bool = Field(strict=True)


class SimulateMirrorRequest(BaseModel):
    """Вход ручного прогона mirror_engine.

    side — Literal, а не строка с проверкой «== "long", иначе short»: опечатка
    в side ("Long", "buy") молча переворачивала сторону зеркального ордера, и
    оператор видел в плане не ту ногу, которую собирался проверить.

    price_decimals обязателен и в границах рынка: без него base_amount и цена
    считаются в неверном масштабе, а `int()` от NaN или 1e400 — это не «пустой
    ответ», а 500 на эндпоинте, который показывает план."""

    leader_id: str
    market_id: int
    side: Literal["long", "short"]
    is_increase: bool
    size_delta: float = Field(ge=0, le=1_000_000_000, allow_inf_nan=False)
    price: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False)
    leader_equity_usd: float = Field(ge=0, le=1_000_000_000_000, allow_inf_nan=False)
    leader_position_before: float = Field(default=0, ge=0, allow_inf_nan=False)
    min_base_amount: float = Field(default=0.001, ge=0, allow_inf_nan=False)
    size_decimals: int = Field(default=3, ge=0, le=8)
    price_decimals: int = Field(ge=0, le=8)


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


async def _owned_leader(user_id: str, leader_id: str) -> dict:
    """Лидер, которым владеет этот субъект токена: 404, если записи нет, 403,
    если она есть, но аккаунт Lighter подтверждён входом кошелька у другого."""
    row = await db.leader(leader_id)
    if not row:
        raise deny(404, "LEADER_NOT_FOUND", "Лидер не найден")
    if row["lighter_account_index"] != await _own_account_index(user_id):
        raise deny(
            403,
            "LEADER_NOT_OWNED",
            "Это читает или меняет только тот, чей вход подтвердил этот аккаунт Lighter",
        )
    return row


# ── Публичное чтение: это витрина, она открыта без входа ──────────────────────


@router.get("/leaders")
async def list_leaders():
    return await db.all_leaders()


@router.get("/leaders/mine")
async def own_leader(user_id: str = Depends(require_user)):
    """Свой лидер — вместе с выключенными публикациями.

    Публичный GET /leaders отдаёт только активных, поэтому по нему интерфейс не
    может восстановить положение рубильника после перезагрузки страницы: выключен
    лидер или его никогда не было. Здесь ответ — строка целиком, с active.
    """
    account_index = await _own_account_index(user_id)
    if account_index is None:
        return {"leader": None}
    row = await db.leader_by_account_index(account_index)
    return {"leader": row}


@router.get("/follows/by-leader/{leader_id}")
async def leader_stats_for_leader(leader_id: str):
    """Публичная витрина лидера: сколько людей и какой капитал — агрегатом.

    Поштучных строк здесь нет. Тот же список по подписчику отдаёт
    GET /leaders/{id}/followers, и он закрыт владением лидером: «аллокации и
    размеры — не публичные данные» — это не про id подписчика, а про сами суммы,
    и список людей с суммами, которые они вложили в чужие сделки, остаётся
    списком людей с суммами, даже если имя каждого заменено на строку таблицы."""
    rows = await db.follows_for_leader(leader_id)
    return {
        "follower_count": len(rows),
        "total_aum_usd": sum(r["allocation_usd"] for r in rows),
    }


@router.get("/leaders/{leader_id}/followers")
async def list_own_leader_followers(
    leader_id: str, user_id: str = Depends(require_user)
):
    """Консоль лидера: кто и на сколько подписан, построчно.

    Тот же список, что отдаётся публично, но агрегатом ниже — с follower_id и
    current_mirrored_size. Право на него решает владение лидером, а не знание
    его ID: список людей с суммами, которые они вложили в чужие сделки, это не
    витрина."""
    await _owned_leader(user_id, leader_id)
    return await db.follows_for_leader(leader_id)


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
        if not existing["active"]:
            # «Стать лидером» на уже существующей записи включает её: иначе
            # человек нажал бы включатель, получил бы leader_id и уверенность,
            # что публикуется, а mirror_engine по-прежнему не видел бы ни одного
            # подписчика.
            await db.set_leader_active(existing["id"], True)
        return {"leader_id": existing["id"], "active": True}

    leader_id = str(uuid.uuid4())
    try:
        await db.upsert_leader(leader_id, account_index, req.handle, req.fee_bps)
    except IntegrityError:
        # UNIQUE leaders.lighter_account_index: параллельный запрос уже успел
        # завести запись на этот аккаунт. Идемпотентный ответ — тот же id, что
        # вернул бы обычный путь «сначала проверь», а не 500 на втором клике.
        existing = await db.leader_by_account_index(account_index)
        if existing is None:
            raise
        return {"leader_id": existing["id"], "active": existing["active"]}
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
    return {"leader_id": leader_id, "active": True}


@router.patch("/leaders/{leader_id}/active")
async def update_leader_active(
    leader_id: str, req: UpdateLeaderActive, user_id: str = Depends(require_user)
):
    """Включить и выключить публикацию сделок.

    Право на неё решает владение лидером (_owned_leader), а не знание id.
    Выключение останавливает зеркалирование: active_follows_for_leader()
    перестаёт отдавать подписчиков, и leader_listener больше не двигает чужие
    счета по сигналам того, кто сказал «я больше не публикую». Подписки и
    mirror_log не трогаются — это состояние человека, а не его история."""
    row = await _owned_leader(user_id, leader_id)
    await db.set_leader_active(leader_id, req.active)
    await al.log_action(
        al.AuditEntry(
            actor=user_id,
            action="leader_activated" if req.active else "leader_deactivated",
            resource=f"leader:{leader_id}",
            details={"active": req.active, "handle": row["handle"]},
            success=True,
        )
    )
    return {"leader_id": leader_id, "active": req.active}


@router.patch("/leaders/{leader_id}/fee")
async def update_leader_fee(
    leader_id: str, req: UpdateLeaderFee, user_id: str = Depends(require_user)
):
    """Лидер меняет комиссию в любой момент. Влияет только на то, что подписчик
    увидит в Discover после изменения, — уже созданные строки follows не пересчитываются
    (в них нет комиссии: она хранится один раз в leaders.fee_bps)."""
    row = await _owned_leader(user_id, leader_id)
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
    """Подписка на чужого лидера.

    Подтверждённого индекса аккаунта Lighter здесь ждут не для формы: копия
    сделки ставится на счёт подписчика, и без индекса листенер не знает, чей это
    счёт, — строка follows заводится, а каждый ордер по ней кончается
    `failed / no_key` в mirror_log. Подписчик при этом видит в интерфейсе
    «подписка записана» и считает, что копирует. Тот же вход кошельком нужен и
    для публикации лидера (POST /leaders), отказ называется тем же кодом.

    На себя — отказ. Без этой строки лидер подписывается на себя своей же
    аллокацией и total_aum_usd на его витрине растёт из воздуха: AUM — единственное,
    чем Discover ранжирует лидеров, и иначе «сколько под ним капитала» остаётся
    цифрой, которую лидер печатает сам одним запросом."""
    row = await db.leader(req.leader_id)
    if row is None:
        raise deny(404, "LEADER_NOT_FOUND", "Лидер не найден")
    account_index = await _own_account_index(user_id)
    if account_index is None:
        raise deny(
            403,
            "LIGHTER_ACCOUNT_NOT_LINKED",
            "Копирование идёт на твой счёт Lighter — войди ещё и кошельком, чтобы "
            "адрес подтвердился подписью",
        )
    if row["lighter_account_index"] == account_index:
        raise deny(
            400,
            "SELF_FOLLOW_NOT_ALLOWED",
            "На своего лидера подписываться нельзя: AUM витрины считается из этих строк",
        )

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
        # UNIQUE(follower_id, leader_id): вторая подписка на того же лидера.
        # Отдельный код и 409, а не общий 400 «или данные невалидны»: клиенту
        # есть на что опереться, и «уже подписан» — это не «запрос испорчен».
        raise deny(
            409, "FOLLOW_EXISTS", "Подписка на этого лидера у тебя уже есть"
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

    Под токеном куратора: ответ перечисляет аллокации и зеркальные размеры всех
    подписчиков лидера, а это не публичные данные.

    Маржа берётся из Lighter (`get_account_equity`) — как в живом листенере, а не
    из поля follows: план, посчитанный от числа, которое подписчик вписал себе сам
    (до $1e9 на валидаторе), оператор читал бы как настоящий, и он расходился бы
    с тем, что копия исполняет. Подписчик без подтверждённых средств попадает в
    `skipped` с причиной `margin_unverified`, а не исчезает из плана молча."""
    rows = await db.active_follows_for_leader(req.leader_id)

    followers: list[FollowerConfig] = []
    skipped: list[SkippedFollower] = []
    for r in rows:
        equity = None
        if r["follower_account_index"] is not None:
            try:
                equity = await run_in_threadpool(
                    lighter_rest.get_account_equity,
                    r["follower_account_index"],
                    LIGHTER_NETWORK,
                )
            except RuntimeError as e:
                # Lighter не ответил — догадываться о марже нельзя, но отказ
                # обязан быть различим в ответе оператора.
                logger.warning(
                    "маржа подписчика %s не получена: %s", r["follower_id"], e
                )
        if equity is None:
            skipped.append(SkippedFollower(r["follower_id"], "margin_unverified"))
            continue
        followers.append(
            FollowerConfig(
                follower_id=r["follower_id"],
                allocation_usd=r["allocation_usd"],
                available_margin_usd=equity,
                max_leverage=r["max_leverage"],
                current_mirrored_size=r["current_mirrored_size"],
            )
        )

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
        min_base_amount=req.min_base_amount,
        size_decimals=req.size_decimals,
        price_decimals=req.price_decimals,
    )

    plan = compute_mirror_plan(event, followers, constraints)
    return {
        "orders": [o.__dict__ | {"side": o.side.value} for o in plan.orders],
        "skipped": [s.__dict__ for s in [*skipped, *plan.skipped]],
    }
