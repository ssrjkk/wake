"""
Аудит-лог для чувствительных действий — кто, что, когда. Не для дебага
(для этого logging/print), а конкретно для разбора «что произошло», если
что-то пошло не так с чужими деньгами или ключами.
"""

import json
import time
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass, field

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp REAL NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT,
    details TEXT,
    success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_log(actor, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log(action, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource);
"""


@contextmanager
def connect(path: str = "audit.db"):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        # Ленивая инициализация: таблица создаётся при первом подключении,
        # если её ещё нет. Это делает audit_log самодостаточным — любой код,
        # который пишет в аудит-лог (например predict_resolution.py), не обязан
        # помнить про явный init_audit_db() перед этим.
        has_table = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'"
        ).fetchone()
        if has_table is None:
            conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_audit_db(path: str = "audit.db"):
    with connect(path) as conn:
        conn.executescript(SCHEMA)


@dataclass(frozen=True)
class AuditEntry:
    actor: str
    action: str
    resource: str | None = None
    details: dict | None = None
    success: bool = True


def log_action(conn, entry: AuditEntry):
    conn.execute(
        "INSERT INTO audit_log (timestamp, actor, action, resource, details, success) VALUES (?,?,?,?,?,?)",
        (time.time(), entry.actor, entry.action, entry.resource,
         json.dumps(entry.details) if entry.details else None, 1 if entry.success else 0),
    )


def recent_actions(conn, actor: str | None = None, action: str | None = None, limit: int = 100):
    query = "SELECT * FROM audit_log WHERE 1=1"
    params = []
    if actor:
        query += " AND actor = ?"
        params.append(actor)
    if action:
        query += " AND action = ?"
        params.append(action)
    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)
    return conn.execute(query, params).fetchall()


def failed_actions_since(conn, since_timestamp: float):
    return conn.execute(
        "SELECT * FROM audit_log WHERE success = 0 AND timestamp >= ? ORDER BY timestamp DESC",
        (since_timestamp,),
    ).fetchall()
