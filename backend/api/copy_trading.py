"""
Копи-трейдинг: followers/leaders/follows + ручной прогон mirror_engine через
HTTP (/simulate-mirror). Логика в db.py + mirror_engine.py, протестирована;
этот слой — только HTTP-обвязка и Pydantic-модели.

Перенесено из app.py при рефакторинге: было одним файлом-монолитом,
стало отдельным роутером с явной границей по продукту.
"""

import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import db
import audit_log as al
from mirror_engine import (
    LeaderEvent, FollowerConfig, MarketConstraints, Side, compute_mirror_plan,
)
from config import DB_PATH, AUDIT_DB_PATH

router = APIRouter()


class RegisterFollower(BaseModel):
    l1_address: str
    lighter_account_index: int | None = None


class RegisterLeader(BaseModel):
    lighter_account_index: int
    handle: str
    fee_bps: int = 8


class CreateFollow(BaseModel):
    follower_id: str
    leader_id: str
    allocation_usd: float
    max_leverage: float = 3


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


@router.get("/follows/by-leader/{leader_id}")
def list_follows_for_leader(leader_id: str):
    with db.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT * FROM follows WHERE leader_id = ? AND paused = 0", (leader_id,)
        ).fetchall()
    total_aum = sum(r["allocation_usd"] for r in rows)
    return {"follower_count": len(rows), "total_aum_usd": total_aum, "follows": [dict(r) for r in rows]}


@router.get("/leaders")
def list_leaders():
    with db.connect(DB_PATH) as conn:
        rows = conn.execute("SELECT * FROM leaders ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


@router.get("/follows/by-follower/{follower_id}")
def list_follows_for_follower(follower_id: str):
    with db.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT f.*, l.handle as leader_handle FROM follows f "
            "JOIN leaders l ON l.id = f.leader_id WHERE f.follower_id = ?",
            (follower_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.delete("/follows/{follow_id}")
def delete_follow(follow_id: str):
    with db.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM follows WHERE id = ?", (follow_id,))
    return {"status": "deleted"}


@router.post("/followers")
def register_follower(req: RegisterFollower):
    with db.connect(DB_PATH) as conn:
        existing = conn.execute(
            "SELECT id FROM followers WHERE l1_address = ?", (req.l1_address,)
        ).fetchone()
        if existing:
            return {"follower_id": existing["id"]}
        follower_id = str(uuid.uuid4())
        db.upsert_follower(conn, follower_id, req.l1_address, req.lighter_account_index)
    return {"follower_id": follower_id}


@router.post("/leaders")
def register_leader(req: RegisterLeader):
    with db.connect(DB_PATH) as conn:
        existing = conn.execute(
            "SELECT id FROM leaders WHERE lighter_account_index = ?", (req.lighter_account_index,)
        ).fetchone()
        if existing:
            return {"leader_id": existing["id"]}
        leader_id = str(uuid.uuid4())
        db.upsert_leader(conn, leader_id, req.lighter_account_index, req.handle, req.fee_bps)
        al.log_action(conn, al.AuditEntry(
            actor=f"leader:{leader_id}",
            action="leader_registered",
            resource=f"leader:{leader_id}",
            details={"handle": req.handle, "fee_bps": req.fee_bps, "lighter_account_index": req.lighter_account_index},
            success=True,
        ))
    return {"leader_id": leader_id}


@router.post("/follows")
def create_follow(req: CreateFollow):
    follow_id = str(uuid.uuid4())
    try:
        with db.connect(DB_PATH) as conn:
            db.create_follow(conn, follow_id, req.follower_id, req.leader_id, req.allocation_usd, req.max_leverage)
    except Exception as e:
        # Скорее всего UNIQUE(follower_id, leader_id) — уже подписан на этого лидера.
        raise HTTPException(status_code=400, detail=str(e))
    return {"follow_id": follow_id}


@router.post("/follows/{follow_id}/pause")
def pause_follow(follow_id: str):
    with db.connect(DB_PATH) as conn:
        db.set_paused(conn, follow_id, True)
    return {"status": "paused"}


@router.post("/follows/{follow_id}/resume")
def resume_follow(follow_id: str):
    with db.connect(DB_PATH) as conn:
        db.set_paused(conn, follow_id, False)
    return {"status": "active"}


@router.post("/simulate-mirror")
def simulate_mirror(req: SimulateMirrorRequest):
    """Ручной прогон mirror_engine через HTTP — без живого WS-события от лидера.
    Полезно, чтобы своими глазами увидеть MirrorPlan для конкретных подписчиков
    из базы, не поднимая leader_listener.py целиком."""
    with db.connect(DB_PATH) as conn:
        rows = db.active_follows_for_leader(conn, req.leader_id)

    followers = [
        FollowerConfig(
            follower_id=r["follower_id"],
            allocation_usd=r["allocation_usd"],
            available_margin_usd=r["allocation_usd"],  # упрощение: реальная свободная маржа с Lighter API не подтянута здесь
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
    constraints = MarketConstraints(min_base_amount=req.min_base_amount, size_decimals=req.size_decimals)

    plan = compute_mirror_plan(event, followers, constraints)
    return {
        "orders": [o.__dict__ | {"side": o.side.value} for o in plan.orders],
        "skipped": [s.__dict__ for s in plan.skipped],
    }