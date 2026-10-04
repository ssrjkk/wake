"""
Тесты переноса SQLite -> PostgreSQL (migrate_sqlite_to_pg.py).

Целевая БД в тестах — aiosqlite: проверяются чтение из legacy-файлов,
преобразования колонок и идемпотентность, а не конкретный диалект. Реальный
PostgreSQL отдельно проверен на alembic upgrade head + полном переносе.
"""

import asyncio
import os
import sqlite3
import tempfile
import unittest
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import audit_log as audit_module
import db as db_module
import migrate_sqlite_to_pg as m
import predict_db as predict_module
from pg_models import Base, Follower, Leader

EPOCH = 1_700_000_000.0


def _make_sqlite(directory: str) -> dict[str, str]:
    """Создаёт legacy wake.db и audit.db с одной строкой в каждой таблице."""
    wake = os.path.join(directory, "wake.db")
    audit = os.path.join(directory, "audit.db")
    conn = sqlite3.connect(wake)
    conn.executescript(db_module.SCHEMA)
    conn.executescript(predict_module.SCHEMA)
    conn.execute(
        "INSERT INTO leaders (id, lighter_account_index, handle, fee_bps, created_at) "
        "VALUES ('ldr_1', 42, 'whale', 12, ?)",
        (EPOCH,),
    )
    conn.execute(
        "INSERT INTO followers (id, l1_address, lighter_account_index, telegram_id, "
        "created_at) VALUES ('tg_777', 'tg:777', NULL, 777, ?)",
        (EPOCH + 100,),
    )
    conn.execute(
        "INSERT INTO follows (id, follower_id, leader_id, allocation_usd, max_leverage, "
        "current_mirrored_size, paused, created_at) "
        "VALUES ('fol_1', 'tg_777', 'ldr_1', 250.0, 5.0, 0.0, 1, ?)",
        (EPOCH + 200,),
    )
    conn.execute(
        "INSERT INTO mirror_log (id, follow_id, market_id, side, base_amount, "
        "reduce_only, status, reason, tx_hash, created_at) "
        "VALUES ('mir_1', 'fol_1', 6, 'buy', 0.15, 1, 'sent', NULL, '0xtx', ?)",
        (EPOCH + 300,),
    )
    conn.execute(
        "INSERT INTO predict_markets (id, kind, question, lighter_market_id, threshold, "
        "comparator, resolve_at, b, q_yes, q_no, status, outcome, resolved_by, "
        "evidence_url, created_at) VALUES ('pm_1', 'price', 'BTC above 100k?', 6, "
        "100000.0, '>=', ?, 10.0, 0.62, 0.38, 'open', NULL, NULL, NULL, ?)",
        (EPOCH + 1000, EPOCH + 400),
    )
    conn.execute(
        "INSERT INTO predict_positions (id, user_id, market_id, outcome, shares, claimed) "
        "VALUES ('pp_1', 'tg_777', 'pm_1', 'yes', 12.5, 1)"
    )
    conn.execute(
        "INSERT INTO predict_trades (id, user_id, market_id, outcome, shares, cost_usd, "
        "created_at) VALUES ('pt_1', 'tg_777', 'pm_1', 'yes', 12.5, 7.75, ?)",
        (EPOCH + 500,),
    )
    conn.commit()
    conn.close()

    aconn = sqlite3.connect(audit)
    aconn.executescript(audit_module.SCHEMA)
    aconn.execute(
        "INSERT INTO audit_log (timestamp, actor, action, resource, details, success) "
        "VALUES (?, 'tg_777', 'auth.telegram', 'tg:777', '{}', 1)",
        (EPOCH + 600,),
    )
    aconn.commit()
    aconn.close()
    return {"wake": wake, "audit": audit}


def _url(directory: str, name: str = "target.db") -> str:
    path = os.path.join(directory, name).replace(os.sep, "/")
    return f"sqlite+aiosqlite:///{path}"


async def _create_target(url: str) -> None:
    """Поднимает схему цели. В проде это делает alembic upgrade head."""
    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    finally:
        await engine.dispose()


async def _counts(url: str) -> dict[str, int]:
    engine = create_async_engine(url)
    try:
        factory = async_sessionmaker(engine, class_=AsyncSession)
        async with factory() as session:
            return {
                transfer.name: await session.scalar(
                    select(func.count()).select_from(transfer.table)
                )
                for transfer in m.TRANSFERS
            }
    finally:
        await engine.dispose()


def _epoch(value: datetime) -> float:
    """Эпоха прочитанного времени. Диалект SQLite не хранит таймзону и отдаёт
    naive-datetime, PostgreSQL (TIMESTAMPTZ) — aware; naive трактуем как UTC,
    иначе .timestamp() применит локальную зону машины."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.timestamp()


class TransformTests(unittest.TestCase):
    def test_epoch_becomes_utc_datetime(self):
        self.assertEqual(m._dt(EPOCH), datetime.fromtimestamp(EPOCH, tz=UTC))
        self.assertIsNone(m._dt(None))

    def test_sqlite_integer_flags_become_bools(self):
        self.assertTrue(m._flag(1))
        self.assertFalse(m._flag(0))

    def test_audit_timestamp_is_renamed_to_created_at(self):
        row = {
            "id": 1,
            "timestamp": EPOCH,
            "actor": "tg_777",
            "action": "auth.telegram",
            "resource": None,
            "details": None,
            "success": 0,
        }
        out = m._audit(row)
        self.assertNotIn("timestamp", out)
        self.assertEqual(out["created_at"], m._dt(EPOCH))
        self.assertFalse(out["success"])

    def test_follower_without_telegram_column(self):
        """Самые старые wake.db были до миграции add_follower_telegram_id."""
        out = m._follower(
            {
                "id": "fl_1",
                "l1_address": "0xABC",
                "lighter_account_index": 9,
                "created_at": EPOCH,
            }
        )
        self.assertIsNone(out["telegram_id"])


class CoverageTests(unittest.TestCase):
    def test_every_pg_table_is_accounted_for(self):
        """Новая таблица в pg_models не должна молча выпасть из переноса."""
        transferred = {t.name for t in m.TRANSFERS}
        self.assertEqual(
            transferred | set(m.NO_SQLITE_SOURCE),
            set(Base.metadata.tables),
        )

    def test_redact_hides_password(self):
        self.assertEqual(
            m.redact("postgresql+asyncpg://wake:s3cret@host:5432/db"),
            "postgresql+asyncpg://wake:***@host:5432/db",
        )


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="wake-xfer-")
        self.paths = _make_sqlite(self.dir)
        self.url = _url(self.dir)
        asyncio.run(_create_target(self.url))

    def test_every_row_reaches_target(self):
        sources = m.read_sources(self.paths, None)
        code = asyncio.run(m.write_all(self.url, sources))
        self.assertEqual(code, 0)
        self.assertEqual(
            asyncio.run(_counts(self.url)),
            {
                "leaders": 1,
                "followers": 1,
                "follows": 1,
                "mirror_log": 1,
                "predict_markets": 1,
                "predict_positions": 1,
                "predict_trades": 1,
                "audit_log": 1,
            },
        )

    def test_rerun_does_not_duplicate(self):
        sources = m.read_sources(self.paths, None)
        asyncio.run(m.write_all(self.url, sources))
        code = asyncio.run(m.write_all(self.url, sources))
        self.assertEqual(code, 0)
        self.assertEqual(asyncio.run(_counts(self.url))["followers"], 1)
        self.assertEqual(asyncio.run(_counts(self.url))["audit_log"], 1)

    def test_timestamps_survive_the_round_trip(self):
        sources = m.read_sources(self.paths, None)
        asyncio.run(m.write_all(self.url, sources))
        engine = create_async_engine(self.url)

        async def read():
            try:
                async with AsyncSession(engine) as session:
                    leader = await session.scalar(
                        select(Leader.created_at).where(Leader.id == "ldr_1")
                    )
                    follower = await session.scalar(
                        select(Follower.telegram_id).where(Follower.id == "tg_777")
                    )
                    return leader, follower
            finally:
                await engine.dispose()

        created_at, telegram_id = asyncio.run(read())
        self.assertAlmostEqual(_epoch(created_at), EPOCH, places=3)
        self.assertEqual(telegram_id, 777)

    def test_dry_run_reads_without_touching_target(self):
        code = m.main(
            [
                "--dry-run",
                "--wake-db",
                self.paths["wake"],
                "--audit-db",
                self.paths["audit"],
                "--database-url",
                _url(self.dir, "never_created.db"),
            ]
        )
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "never_created.db")))

    def test_unknown_table_is_rejected(self):
        code = m.main(["--tables", "nope", "--wake-db", self.paths["wake"]])
        self.assertEqual(code, 2)

    def test_missing_source_file_is_rejected(self):
        code = m.main(
            [
                "--wake-db",
                os.path.join(self.dir, "absent.db"),
                "--audit-db",
                self.paths["audit"],
            ]
        )
        self.assertEqual(code, 2)


class SourceReaderTests(unittest.TestCase):
    def test_absent_table_reads_as_empty(self):
        """Пустая/неинициализированная база не должна ронять перенос."""
        empty = os.path.join(tempfile.mkdtemp(prefix="wake-xfer-empty-"), "wake.db")
        sqlite3.connect(empty).close()
        sources = m.read_sources({"wake": empty, "audit": empty}, None)
        self.assertEqual(sources["leaders"], [])
        self.assertEqual(sources["audit_log"], [])


if __name__ == "__main__":
    unittest.main()
