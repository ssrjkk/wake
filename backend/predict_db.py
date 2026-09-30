"""
DB-слой модуля предсказаний. Отдельная от db.py (копи-трейдинг) схема — разные
продуктовые модули, но общая identity: user_id здесь = тот же followers.id,
что и в копи-трейдинге, чтобы не заводить второй логин.

record_trade() — единственное место, где меняется q_yes/q_no рынка, позиция
юзера и лог сделки — всё в одной транзакции. Разойтись эти три вещи не должны
никогда, поэтому это одна функция, а не три вызываемые по отдельности.
"""

import time
import sqlite3
from contextlib import contextmanager

from predict_amm import LMSRMarket

SCHEMA = """
CREATE TABLE IF NOT EXISTS predict_markets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                    -- 'price' | 'event'
    question TEXT NOT NULL,
    lighter_market_id INTEGER,              -- только kind='price'
    threshold REAL,                         -- только kind='price'
    comparator TEXT,                        -- только kind='price'
    resolve_at REAL NOT NULL,
    b REAL NOT NULL,
    q_yes REAL NOT NULL DEFAULT 0,
    q_no REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',    -- 'open' | 'resolved'
    outcome TEXT,
    resolved_by TEXT,
    evidence_url TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS predict_positions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    market_id TEXT NOT NULL REFERENCES predict_markets(id),
    outcome TEXT NOT NULL,
    shares REAL NOT NULL DEFAULT 0,
    claimed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, market_id, outcome)
);

CREATE TABLE IF NOT EXISTS predict_trades (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    market_id TEXT NOT NULL REFERENCES predict_markets(id),
    outcome TEXT NOT NULL,
    shares REAL NOT NULL,
    cost_usd REAL NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_predict_positions_user ON predict_positions(user_id, market_id);
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


def init_predict_db(path: str = "wake.db"):
    with connect(path) as conn:
        conn.executescript(SCHEMA)


def create_market(conn, id_: str, kind: str, question: str, resolve_at: float, b: float,
                   lighter_market_id: int | None = None, threshold: float | None = None,
                   comparator: str | None = None):
    if kind not in ("price", "event"):
        raise ValueError("kind должен быть 'price' или 'event'")
    if kind == "price" and (lighter_market_id is None or threshold is None or comparator is None):
        raise ValueError("price-рынок требует lighter_market_id, threshold и comparator")
    conn.execute(
        "INSERT INTO predict_markets (id, kind, question, lighter_market_id, threshold, comparator, "
        "resolve_at, b, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (id_, kind, question, lighter_market_id, threshold, comparator, resolve_at, b, time.time()),
    )


def get_market(conn, market_id: str):
    return conn.execute("SELECT * FROM predict_markets WHERE id = ?", (market_id,)).fetchone()


def list_open_markets(conn):
    return conn.execute("SELECT * FROM predict_markets WHERE status = 'open' ORDER BY resolve_at ASC").fetchall()


def record_trade(conn, trade_id: str, user_id: str, market_id: str, outcome: str, shares: float) -> float:
    """Покупка (shares>0) или продажа (shares<0). Возвращает cost_usd (положительное —
    юзер платит, отрицательное — юзеру платят). Меняет q_yes/q_no рынка, позицию и
    пишет лог — атомарно в одной функции."""
    market = get_market(conn, market_id)
    if market is None:
        raise ValueError(f"рынок {market_id} не найден")
    if market["status"] != "open":
        raise ValueError(f"рынок {market_id} не открыт (status={market['status']})")

    amm = LMSRMarket(b=market["b"], q_yes=market["q_yes"], q_no=market["q_no"])
    cost = amm.trade(outcome, shares)

    conn.execute(
        "UPDATE predict_markets SET q_yes = ?, q_no = ? WHERE id = ?",
        (amm.q_yes, amm.q_no, market_id),
    )

    existing = conn.execute(
        "SELECT * FROM predict_positions WHERE user_id = ? AND market_id = ? AND outcome = ?",
        (user_id, market_id, outcome),
    ).fetchone()
    if existing:
        new_shares = existing["shares"] + shares
        if new_shares < -1e-9:
            raise ValueError("нельзя продать больше shares, чем есть в позиции")
        conn.execute(
            "UPDATE predict_positions SET shares = ? WHERE id = ?",
            (max(new_shares, 0), existing["id"]),
        )
    else:
        if shares < 0:
            raise ValueError("нельзя продать shares без существующей позиции")
        conn.execute(
            "INSERT INTO predict_positions (id, user_id, market_id, outcome, shares) VALUES (?,?,?,?,?)",
            (trade_id + "-pos", user_id, market_id, outcome, shares),
        )

    conn.execute(
        "INSERT INTO predict_trades (id, user_id, market_id, outcome, shares, cost_usd, created_at) VALUES (?,?,?,?,?,?,?)",
        (trade_id, user_id, market_id, outcome, shares, cost, time.time()),
    )
    return cost


def resolve_market(conn, market_id: str, outcome: str, resolved_by: str | None = None, evidence_url: str | None = None):
    conn.execute(
        "UPDATE predict_markets SET status='resolved', outcome=?, resolved_by=?, evidence_url=? WHERE id = ?",
        (outcome, resolved_by, evidence_url, market_id),
    )


def get_position(conn, user_id: str, market_id: str, outcome: str):
    return conn.execute(
        "SELECT * FROM predict_positions WHERE user_id = ? AND market_id = ? AND outcome = ?",
        (user_id, market_id, outcome),
    ).fetchone()


def claim_winnings(conn, user_id: str, market_id: str) -> float:
    """Резолвнутый рынок: победившие shares стоят $1 каждая, проигравшие — $0.
    Помечает позицию claimed=1, чтобы нельзя было забрать дважды."""
    market = get_market(conn, market_id)
    if market is None or market["status"] != "resolved":
        raise ValueError("рынок не резолвлен")
    pos = get_position(conn, user_id, market_id, market["outcome"])
    if pos is None or pos["claimed"]:
        return 0.0
    payout = pos["shares"] * 1.0
    conn.execute("UPDATE predict_positions SET claimed = 1 WHERE id = ?", (pos["id"],))
    return payout
