"""
Слой базы данных. SQLite — осознанно, не потому что "для прототипа сойдёт", а
потому что для количества подписчиков, с которым Wake реально стартует, SQLite
плюс нормальные индексы выдержит с запасом, а разворачивать Postgres до того,
как есть хоть один живой пользователь, — преждевременная сложность.

Это НЕ место, где хранятся API-ключи подписчиков — это делает key_store.py,
намеренно отдельно, чтобы утечка одной базы (переписки, аллокации, история)
не была равна утечке торговых ключей.

Всё в этом файле реально прогнано (см. test_db.py) — не только написано.
"""

import sqlite3
import time
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS leaders (
    id TEXT PRIMARY KEY,
    lighter_account_index INTEGER NOT NULL,
    handle TEXT NOT NULL,
    fee_bps INTEGER NOT NULL DEFAULT 8,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS followers (
    id TEXT PRIMARY KEY,
    l1_address TEXT NOT NULL UNIQUE,
    lighter_account_index INTEGER,
    telegram_id INTEGER UNIQUE,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    follower_id TEXT NOT NULL REFERENCES followers(id),
    leader_id TEXT NOT NULL REFERENCES leaders(id),
    allocation_usd REAL NOT NULL,
    max_leverage REAL NOT NULL DEFAULT 3,
    current_mirrored_size REAL NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    UNIQUE(follower_id, leader_id)
);

CREATE TABLE IF NOT EXISTS mirror_log (
    id TEXT PRIMARY KEY,
    follow_id TEXT NOT NULL REFERENCES follows(id),
    market_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    base_amount REAL NOT NULL,
    reduce_only INTEGER NOT NULL,
    status TEXT NOT NULL,      -- 'planned' | 'skipped' | 'dry_run' | 'sent' | 'failed'
    reason TEXT,                -- причина skip, если status='skipped'
    tx_hash TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_follows_leader ON follows(leader_id, paused);
CREATE INDEX IF NOT EXISTS idx_mirror_log_follow ON mirror_log(follow_id, created_at);
"""


@contextmanager
def connect(path: str = "wake.db"):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db(path: str = "wake.db"):
    with connect(path) as conn:
        conn.executescript(SCHEMA)


def upsert_leader(
    conn, id_: str, lighter_account_index: int, handle: str, fee_bps: int = 8
):
    conn.execute(
        "INSERT INTO leaders (id, lighter_account_index, handle, fee_bps, created_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET handle=excluded.handle, fee_bps=excluded.fee_bps",
        (id_, lighter_account_index, handle, fee_bps, time.time()),
    )


def upsert_follower(
    conn,
    id_: str,
    l1_address: str,
    lighter_account_index: int | None = None,
    telegram_id: int | None = None,
):
    # COALESCE, а не прямое присваивание: логин через кошелёк не должен стирать telegram_id
    # предыдущего входа через Telegram, и наоборот.
    conn.execute(
        "INSERT INTO followers (id, l1_address, lighter_account_index, telegram_id, created_at) VALUES (?,?,?,?,?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "lighter_account_index = COALESCE(excluded.lighter_account_index, followers.lighter_account_index), "
        "telegram_id = COALESCE(excluded.telegram_id, followers.telegram_id)",
        (id_, l1_address, lighter_account_index, telegram_id, time.time()),
    )


def create_follow(
    conn,
    id_: str,
    follower_id: str,
    leader_id: str,
    allocation_usd: float,
    max_leverage: float = 3,
):
    conn.execute(
        "INSERT INTO follows (id, follower_id, leader_id, allocation_usd, max_leverage, created_at) VALUES (?,?,?,?,?,?)",
        (id_, follower_id, leader_id, allocation_usd, max_leverage, time.time()),
    )


def active_follows_for_leader(conn, leader_id: str):
    """Всё, что нужно для compute_mirror_plan() и реального исполнения по конкретному
    лидеру, одним запросом — включая lighter_account_index подписчика, не только его
    внутренний follower_id."""
    return conn.execute(
        "SELECT f.id as follow_id, f.follower_id, f.allocation_usd, f.max_leverage, f.current_mirrored_size, "
        "fw.lighter_account_index as follower_account_index "
        "FROM follows f JOIN followers fw ON fw.id = f.follower_id "
        "WHERE f.leader_id = ? AND f.paused = 0",
        (leader_id,),
    ).fetchall()


def set_paused(conn, follow_id: str, paused: bool):
    conn.execute(
        "UPDATE follows SET paused = ? WHERE id = ?", (1 if paused else 0, follow_id)
    )


def update_mirrored_size(conn, follow_id: str, new_size: float):
    conn.execute(
        "UPDATE follows SET current_mirrored_size = ? WHERE id = ?",
        (new_size, follow_id),
    )


def log_mirror_result(
    conn,
    id_: str,
    follow_id: str,
    market_id: int,
    side: str,
    base_amount: float,
    reduce_only: bool,
    status: str,
    reason: str | None = None,
    tx_hash: str | None = None,
):
    conn.execute(
        "INSERT INTO mirror_log (id, follow_id, market_id, side, base_amount, reduce_only, status, reason, tx_hash, created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            id_,
            follow_id,
            market_id,
            side,
            base_amount,
            1 if reduce_only else 0,
            status,
            reason,
            tx_hash,
            time.time(),
        ),
    )
