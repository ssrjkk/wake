"""
Аудит-лог для чувствительных действий — кто, что, когда. Не для дебага
(для этого есть logging), а конкретно для разбора «что произошло», если что-то
пошло не так с чужими деньгами или ключами.

Раньше жил в отдельном SQLite-файле (audit.db). Теперь — таблица audit_log в
той же PostgreSQL, что и остальное: файл в контейнере переживает рестарт
ровно настолько, насколько сам контейнер, а разбору подлежит как раз то, что
осталось после.

Колонка времени в Postgres называется created_at, а не timestamp, как в
прежнем SQLite-файле; наружу по-прежнему отдаётся epoch-секундами.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select

from database import async_session_factory
from pg_models import AuditLog


@dataclass(frozen=True)
class AuditEntry:
    actor: str
    action: str
    resource: str | None = None
    details: dict | None = None
    success: bool = True


def _row(a: AuditLog) -> dict:
    return {
        "id": a.id,
        "timestamp": a.created_at.timestamp() if a.created_at else 0.0,
        "actor": a.actor,
        "action": a.action,
        "resource": a.resource,
        "details": a.details,
        "success": 1 if a.success else 0,
    }


async def log_action(entry: AuditEntry) -> None:
    async with async_session_factory() as session:
        session.add(
            AuditLog(
                created_at=datetime.now(UTC),
                actor=entry.actor,
                action=entry.action,
                resource=entry.resource,
                details=json.dumps(entry.details) if entry.details else None,
                success=entry.success,
            )
        )
        await session.commit()


async def recent_actions(
    actor: str | None = None, action: str | None = None, limit: int = 100
) -> list[dict]:
    # id как второй ключ сортировки: строки, записанные пачкой в один тик часов,
    # иначе могли бы идти в разном порядке между двумя подряд запросами.
    stmt = (
        select(AuditLog)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(limit)
    )
    if actor:
        stmt = stmt.where(AuditLog.actor == actor)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    async with async_session_factory() as session:
        return [_row(a) for a in (await session.scalars(stmt)).all()]


async def failed_actions_since(since_timestamp: float) -> list[dict]:
    stmt = (
        select(AuditLog)
        .where(
            AuditLog.success.is_(False),
            AuditLog.created_at >= datetime.fromtimestamp(since_timestamp, UTC),
        )
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    async with async_session_factory() as session:
        return [_row(a) for a in (await session.scalars(stmt)).all()]
