"""
Перенос данных из legacy SQLite в PostgreSQL.

Читает wake.db / audit.db синхронным sqlite3, пишет в PostgreSQL через async
SQLAlchemy-слой пачками по CHUNK строк. Вставка идемпотентна (ON CONFLICT DO
NOTHING по первичному ключу), поэтому скрипт можно перезапускать после обрыва.

Переносим 8 таблиц. Две таблицы PostgreSQL-схемы (agent_trades, subscriptions)
SQLite-предшественников не имеют — раньше они жили в dict'ах процессов, так что
переносить оттуда нечего, они наполняются рантаймом.

Запуск:
    python migrate_sqlite_to_pg.py --dry-run
    python migrate_sqlite_to_pg.py
    python migrate_sqlite_to_pg.py --database-url postgresql+asyncpg://u:p@h:5432/db

Совместимость со схемой: имена колонок в SQLite и PostgreSQL совпадают
(см. pg_models.py), кроме трёх мест, где отличается тип или имя. Поэтому это
не «COPY из одной таблицы в другую», а перенос с явным преобразованием:

    SQLite                     PostgreSQL
    -----------------------    -------------------------
    created_at REAL (epoch)    TIMESTAMPTZ
    paused / reduce_only /     BOOLEAN
      claimed / success INT
    audit_log.timestamp        audit_log.created_at
"""

import argparse
import asyncio
import os
import sqlite3
import sys
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import Table, func, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from config import settings
from pg_models import (
    AgentTrade,
    AuditLog,
    Base,
    Follower,
    Follow,
    Leader,
    MirrorLog,
    PredictMarket,
    PredictPosition,
    PredictTrade,
    Subscription,
)

CHUNK = 500

Row = dict[str, object]
Transform = Callable[[Row], Row]


def _dt(value: object) -> datetime | None:
    """Unix-seconds из SQLite REAL -> tz-aware datetime для TIMESTAMPTZ."""
    if value is None:
        return None
    return datetime.fromtimestamp(float(value), tz=UTC)


def _flag(value: object) -> bool:
    """SQLite boolean-as-INTEGER -> Python bool."""
    return bool(value)


# ── Преобразования колонок: по одной функции на таблицу ──────────────────────


def _leader(row: Row) -> Row:
    return {
        "id": row["id"],
        "lighter_account_index": row["lighter_account_index"],
        "handle": row["handle"],
        "fee_bps": row["fee_bps"],
        "created_at": _dt(row["created_at"]),
    }


def _follower(row: Row) -> Row:
    # telegram_id появился отдельной миграцией (migrate.add_follower_telegram_id),
    # в самых старых файлах wake.db колонки может не быть.
    return {
        "id": row["id"],
        "l1_address": row["l1_address"],
        "lighter_account_index": row["lighter_account_index"],
        "telegram_id": row.get("telegram_id"),
        "created_at": _dt(row["created_at"]),
    }


def _follow(row: Row) -> Row:
    return {
        "id": row["id"],
        "follower_id": row["follower_id"],
        "leader_id": row["leader_id"],
        "allocation_usd": row["allocation_usd"],
        "max_leverage": row["max_leverage"],
        "current_mirrored_size": row["current_mirrored_size"],
        "paused": _flag(row["paused"]),
        "created_at": _dt(row["created_at"]),
    }


def _mirror_log(row: Row) -> Row:
    return {
        "id": row["id"],
        "follow_id": row["follow_id"],
        "market_id": row["market_id"],
        "side": row["side"],
        "base_amount": row["base_amount"],
        "reduce_only": _flag(row["reduce_only"]),
        "status": row["status"],
        "reason": row["reason"],
        "tx_hash": row["tx_hash"],
        "created_at": _dt(row["created_at"]),
    }


def _predict_market(row: Row) -> Row:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "question": row["question"],
        "lighter_market_id": row["lighter_market_id"],
        "threshold": row["threshold"],
        "comparator": row["comparator"],
        "resolve_at": _dt(row["resolve_at"]),
        "b": row["b"],
        "q_yes": row["q_yes"],
        "q_no": row["q_no"],
        "status": row["status"],
        "outcome": row["outcome"],
        "resolved_by": row["resolved_by"],
        "evidence_url": row["evidence_url"],
        "created_at": _dt(row["created_at"]),
    }


def _predict_position(row: Row) -> Row:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "market_id": row["market_id"],
        "outcome": row["outcome"],
        "shares": row["shares"],
        "claimed": _flag(row["claimed"]),
    }


def _predict_trade(row: Row) -> Row:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "market_id": row["market_id"],
        "outcome": row["outcome"],
        "shares": row["shares"],
        "cost_usd": row["cost_usd"],
        "created_at": _dt(row["created_at"]),
    }


def _audit(row: Row) -> Row:
    return {
        "id": row["id"],
        "created_at": _dt(row["timestamp"]),
        "actor": row["actor"],
        "action": row["action"],
        "resource": row["resource"],
        "details": row["details"],
        "success": _flag(row["success"]),
    }


@dataclass(frozen=True)
class Transfer:
    """Описание переноса одной таблицы SQLite -> PostgreSQL."""

    model: type[Base]
    source: str
    primary_key: tuple[str, ...]
    transform: Transform

    @property
    def name(self) -> str:
        return self.model.__tablename__

    @property
    def table(self) -> Table:
        return self.model.__table__


# Порядок важен: SQLite читается целиком, но в PostgreSQL вставляем по FK-зависимостям.
# audit_log идёт отдельно: его SQLite-файл (audit.db) отличается от wake.db.
TRANSFERS: tuple[Transfer, ...] = (
    Transfer(Leader, "wake", ("id",), _leader),
    Transfer(Follower, "wake", ("id",), _follower),
    Transfer(Follow, "wake", ("id",), _follow),
    Transfer(MirrorLog, "wake", ("id",), _mirror_log),
    Transfer(PredictMarket, "wake", ("id",), _predict_market),
    Transfer(PredictPosition, "wake", ("id",), _predict_position),
    Transfer(PredictTrade, "wake", ("id",), _predict_trade),
    Transfer(AuditLog, "audit", ("id",), _audit),
)

# Таблицы PostgreSQL-схемы без SQLite-источника — проверяем, что не забыли.
NO_SQLITE_SOURCE: tuple[str, ...] = (
    AgentTrade.__tablename__,
    Subscription.__tablename__,
)


# ── Чтение SQLite ────────────────────────────────────────────────────────────


def _open(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def _read(conn: sqlite3.Connection, name: str) -> Iterator[Row]:
    """Отдаёт строки таблицы словарями; отсутствующую таблицу читаем как пустую."""
    if not _table_exists(conn, name):
        return
    # Имя таблицы берётся из константы TRANSFERS, не из пользовательского ввода.
    for row in conn.execute(f"SELECT * FROM {name}"):
        yield dict(row)


def _chunks(rows: list[Row], size: int) -> Iterator[list[Row]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def read_sources(paths: dict[str, str], only: set[str] | None) -> dict[str, list[Row]]:
    """Читает SQLite-файлы и сразу применяет преобразования колонок.

    Только чтение: dry-run работает, когда PostgreSQL ещё не поднят.
    """
    conns = {key: _open(path) for key, path in paths.items()}
    try:
        return {
            transfer.name: [
                transfer.transform(row)
                for row in _read(conns[transfer.source], transfer.name)
            ]
            for transfer in TRANSFERS
            if not only or transfer.name in only
        }
    finally:
        for conn in conns.values():
            conn.close()


# ── Запись PostgreSQL ────────────────────────────────────────────────────────


def _insert_for(dialect_name: str):
    """Диалект-специфичный insert с on_conflict_do_nothing.

    PostgreSQL — целевая БД; sqlite нужен, чтобы скрипт был прогоняем в тестах
    и на локальной машине без поднятого Postgres.
    """
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        raise ValueError(
            f"Перенос поддерживает postgresql и sqlite, получено {dialect_name!r}"
        )
    return insert


async def _reset_audit_sequence(session: AsyncSession, last_id: int) -> None:
    """Перебрасывает счётчик audit_log.id после копирования явных id.

    SQLite задаёт audit_log.id целыми числами, и PostgreSQL о них не знает:
    без setval первый же рантайм-инсерт упадёт на duplicate key. В sqlite
    (тестовый прогон) автоинкремента такого вида нет.
    """
    if session.get_bind().dialect.name != "postgresql":
        return
    seq = await session.scalar(text("SELECT pg_get_serial_sequence('audit_log', 'id')"))
    if seq:
        await session.execute(
            text("SELECT setval(:seq, :last)"), {"seq": seq, "last": last_id}
        )


async def _transfer_one(
    session: AsyncSession, transfer: Transfer, rows: list[Row]
) -> None:
    """Вставляет строки одной таблицы, пропуская уже перенесённые."""
    if not rows:
        return
    insert = _insert_for(session.get_bind().dialect.name)
    stmt = insert(transfer.table).on_conflict_do_nothing(
        index_elements=[*transfer.primary_key]
    )
    for chunk in _chunks(rows, CHUNK):
        await session.execute(stmt, chunk)


async def write_all(database_url: str, sources: dict[str, list[Row]]) -> int:
    """Пишет прочитанное в PostgreSQL. Код возврата 0 — все строки источника на месте.

    ON CONFLICT DO NOTHING срабатывает только по совпадению первичного ключа,
    то есть пропущенная строка уже лежит в целевой таблице. Поэтому проверка
    одна: после вставки в целевой таблице не меньше строк, чем в источнике.
    """
    engine = create_async_engine(database_url)
    session_factory = async_sessionmaker(engine, class_=AsyncSession)
    failed = False
    try:
        async with session_factory() as session:
            for transfer in TRANSFERS:
                if transfer.name not in sources:
                    continue
                rows = sources[transfer.name]
                before = await session.scalar(
                    select(func.count()).select_from(transfer.table)
                )
                await _transfer_one(session, transfer, rows)
                after = await session.scalar(
                    select(func.count()).select_from(transfer.table)
                )
                if transfer.name == AuditLog.__tablename__ and rows:
                    await _reset_audit_sequence(
                        session, max(int(r["id"]) for r in rows)
                    )
                await session.commit()
                written = after - before
                if after < len(rows):
                    failed = True
                    print(
                        f"  {transfer.name}: НЕ ХВАТАЕТ {len(rows) - after} "
                        f"строк (источник {len(rows)}, в целевой {after})"
                    )
                else:
                    print(
                        f"  {transfer.name}: записано {written}, "
                        f"уже было {len(rows) - written}, в целевой {after}"
                    )
    except SQLAlchemyError as exc:
        # str(SQLAlchemyError) дописывает [parameters: ...] — там адреса кошельков
        # и telegram_id, поэтому берём только сообщение драйвера.
        orig = getattr(exc, "orig", None) or exc
        detail = str(orig).splitlines()[0]
        print(
            f"Запись не удалась ({redact(database_url)}): {type(orig).__name__}: {detail}"
        )
        print(
            "Откат по таблицам: уже записанные остались на месте, "
            "повторный запуск пропустит их и продолжит с проблемной."
        )
        return 2
    finally:
        await engine.dispose()
    return 1 if failed else 0


# ── CLI ──────────────────────────────────────────────────────────────────────


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Перенос данных из legacy SQLite в PostgreSQL"
    )
    parser.add_argument(
        "--database-url",
        default=settings.wake_database_url,
        help="URL целевого PostgreSQL (по умолчанию из WAKE_DATABASE_URL)",
    )
    parser.add_argument(
        "--wake-db",
        default=settings.wake_db_path,
        help=f"Путь к wake.db (по умолчанию {settings.wake_db_path})",
    )
    parser.add_argument(
        "--audit-db",
        default=settings.wake_audit_db_path,
        help=f"Путь к audit.db (по умолчанию {settings.wake_audit_db_path})",
    )
    parser.add_argument(
        "--tables",
        help=f"Выбрать таблицы через запятую (доступно: {', '.join(t.name for t in TRANSFERS)})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Посчитать и показать, ничего не записывая",
    )
    parser.add_argument(
        "--create-schema",
        action="store_true",
        help="Создать таблицы через metadata (для локального прогона; "
        "в проде схема поднимается alembic upgrade head)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # Отчёт по-русски, а консоль Windows по умолчанию в cp866 — без UTF-8
    # вместо строк читаются пропадюки.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    only: set[str] | None = None
    if args.tables:
        only = {name.strip() for name in args.tables.split(",") if name.strip()}
        unknown = only - {t.name for t in TRANSFERS}
        if unknown:
            print(f"Неизвестные таблицы: {', '.join(sorted(unknown))}")
            return 2

    paths = {"wake": args.wake_db, "audit": args.audit_db}
    missing = [path for path in paths.values() if not _file_exists(path)]
    if missing:
        print(f"Нет файлов базы: {', '.join(missing)}")
        return 2

    sources = read_sources(paths, only)
    mode = " (dry-run, ничего не пишем)" if args.dry_run else ""
    print(
        f"Перенос{mode} {args.wake_db} + {args.audit_db} -> {redact(args.database_url)}"
    )
    for transfer in TRANSFERS:
        if transfer.name in sources:
            print(f"  {transfer.name}: {len(sources[transfer.name])} строк в SQLite")
    if args.dry_run:
        return 0

    if args.create_schema:
        asyncio.run(_create_schema(args.database_url))
    return asyncio.run(write_all(args.database_url, sources))


def _file_exists(path: str) -> bool:
    return os.path.exists(path)


def redact(url: str) -> str:
    """Убирает пароль из URL, чтобы он не попал в лог/терминал."""
    if "@" not in url or "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)
    if ":" in creds:
        user, _ = creds.split(":", 1)
        creds = f"{user}:***"
    return f"{scheme}://{creds}@{host}"


async def _create_schema(database_url: str) -> None:
    engine = create_async_engine(database_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
