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
import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select

from database import async_session_factory
from pg_models import AuditLog

logger = logging.getLogger("wake.audit")

# Потолок строк на один запрос. Аудит читает человек при разборе инцидента, и
# «покажи всё» не имеет права превращаться в выгрузку всей таблицы в память
# процесса: rows в audit_log растут вместе с числом сделок и не чистятся.
MAX_ROWS = 500
DEFAULT_ROWS = 100


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
        # details — колонка Text, поэтому наружу она идёт строкой JSON, как её
        # хранит база. Разбирает её тот, кто показывает: GET /audit декодирует
        # в объект, потому что клиенту строка внутри JSON полезна ровно как лишний
        # парсер.
        "details": a.details,
        "success": 1 if a.success else 0,
    }


def _event_line(entry: AuditEntry, created_at: datetime) -> str:
    """Форма события для лога, которая не бросается никогда.

    Второй попытки сериализации тут не хватает ровно на один случай:
    циклическую ссылку в details не пишет ни один JSON-писатель (default=str не
    помогает — детектор цикла срабатывает раньше), и без этого except сама
    запись об отказе падала тем же исключением, которое она и описывала. repr
    цикл печатает, а потерять actor/action из-за странного объекта в details —
    худший из исходов."""
    event = {
        "actor": entry.actor,
        "action": entry.action,
        "resource": entry.resource,
        "details": entry.details,
        "success": entry.success,
        "created_at": created_at.isoformat(),
    }
    try:
        return json.dumps(event, ensure_ascii=False, default=str)
    except Exception:
        return repr(event)


async def log_action(entry: AuditEntry) -> None:
    """Записать событие аудита. Сбой записи НЕ превращается в 500 запроса.

    Причина не в удобстве: этот вызов стоит ПОСЛЕ того, как деньги уже
    изменились — record_trade закоммичен, токен выдан, ордера отправлены. Если
    база в этот момент моргнёт, клиент получил бы 500 на успешно исполненную
    сделку и разумно повторил бы запрос, то есть вторую сделку вместо одной.
    Молча потерять событие тоже нельзя: оно уходит в лог уровнем ERROR целиком и
    в той форме, в какой легло бы в таблицу (_event_line) — разбор «что
    произошло» тогда ведут по логам, а не по догадкам.

    Сериализация details стоит внутри try, а не до него. Гарантия из первого
    абзаца раньше распространялась только на базу: `details={"amount":
    Decimal("1.0")}` — Decimal обычный тип для денег в моделях SQLAlchemy, и
    положить его в details проще простого — бросал TypeError на json.dumps ДО
    try, и запрос падал 500 ровно там, где документ обещает обратное.

    default=str здесь не вежливость, а условие того, что событие доживает до
    таблицы: без него Decimal выпадал бы из записи целиком, а лог процесса
    ротируется — разбор «кому сколько выплатили» не может опираться на то, что
    стирается. Число в колонке станет строкой "12.50"; для аудита, который
    читает человек, это ровно та цена, за которую строка вообще есть."""
    created_at = datetime.now(UTC)
    try:
        row = AuditLog(
            created_at=created_at,
            actor=entry.actor,
            action=entry.action,
            resource=entry.resource,
            details=json.dumps(entry.details, default=str) if entry.details else None,
            success=entry.success,
        )
        async with async_session_factory() as session:
            session.add(row)
            await session.commit()
    except Exception as e:
        logger.error(
            "аудит не записан (%s): %s",
            e,
            _event_line(entry, created_at),
            exc_info=True,
        )


def _bounded(limit: int) -> int:
    """Limit с потолком: вызывающий код передаёт число из запроса клиента, а
    «лимит» в названии параметра обязано быть ограничением, а не пожеланием."""
    return max(1, min(int(limit), MAX_ROWS))


async def recent_actions(
    actor: str | None = None,
    action: str | None = None,
    failed_only: bool = False,
    since: float | None = None,
    limit: int = DEFAULT_ROWS,
) -> list[dict]:
    """Последние события — единственный читатель этой таблицы.

    Когда-то здесь было две функции: эта и `failed_actions_since`. Вторая ни кем
    не вызывалась (её проверяли только тесты), не имела limit и не умела
    фильтровать по actor/action, то есть оператор, который ищет «кто ломился в
    чужие аккаунты», получил бы сначала весь список неудач за всю жизнь таблицы.
    Один читатель с теми же фильтрами закрывает оба случая.

    id как второй ключ сортировки: строки, записанные пачкой в один тик часов,
    иначе шли бы в разном порядке между двумя подряд запросами."""
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    if actor:
        stmt = stmt.where(AuditLog.actor == actor)
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if failed_only:
        stmt = stmt.where(AuditLog.success.is_(False))
    if since is not None:
        stmt = stmt.where(AuditLog.created_at >= datetime.fromtimestamp(since, UTC))
    stmt = stmt.limit(_bounded(limit))
    async with async_session_factory() as session:
        return [_row(a) for a in (await session.scalars(stmt)).all()]
