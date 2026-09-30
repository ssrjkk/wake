"""
[!]  НЕ ТЕСТИРОВАЛОСЬ — нет psycopg2 и нет живого Postgres в этой песочнице
(проверено: `import psycopg2` падает). Написано по стандартному паттерну
connection pooling, не выдумано, но статус честно untested, как и весь
остальной сетевой код в проекте.

Важная вещь, которую этот файл делает НЕ так, как db.py/predict_db.py, и
почему это не мелочь: SQLite сериализует запись файловой блокировкой — это
плохо для throughput, но случайно ЗАЩИЩАЕТ от гонки при параллельной записи
q_yes/q_no одного рынка предсказаний (два юзера покупают одновременно, оба
читают одно и то же состояние, один write теряется — это реальный баг
корректности, не только про скорость). Postgres с пулом соединений снимает
ограничение на throughput, но БЕЗ явной блокировки строки вернёт именно эту
гонку обратно. Поэтому record_trade() ниже использует SELECT ... FOR UPDATE —
не для производительности, а чтобы не приобрести баг, теряя SQLite.

pip install psycopg2-binary
"""

import os
import contextlib

try:
    import psycopg2
    import psycopg2.extras
    from psycopg2 import pool as pg_pool
except ImportError:
    psycopg2 = None
    pg_pool = None

from predict_amm import LMSRMarket

DATABASE_URL = os.environ.get("WAKE_DATABASE_URL")  # postgres://user:pass@host:5432/wake

_pool = None


def init_pool(minconn: int = 2, maxconn: int = 20):
    global _pool
    if psycopg2 is None:
        raise RuntimeError("psycopg2 не установлен — pip install psycopg2-binary")
    if not DATABASE_URL:
        raise RuntimeError("WAKE_DATABASE_URL не задан")
    _pool = pg_pool.ThreadedConnectionPool(minconn, maxconn, DATABASE_URL)


@contextlib.contextmanager
def connect():
    if _pool is None:
        init_pool()
    conn = _pool.getconn()
    conn.cursor_factory = psycopg2.extras.RealDictCursor
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)


def active_follows_for_leader(conn, leader_id: str):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT f.id as follow_id, f.follower_id, f.allocation_usd, f.max_leverage, "
            "f.current_mirrored_size, fw.lighter_account_index as follower_account_index "
            "FROM follows f JOIN followers fw ON fw.id = f.follower_id "
            "WHERE f.leader_id = %s AND f.paused = false",
            (leader_id,),
        )
        return cur.fetchall()


def record_predict_trade(conn, user_id: str, market_id: str, outcome: str, shares: float) -> float:
    """Postgres-версия record_trade из predict_db.py — с явной построчной
    блокировкой, которую SQLite давал бесплатно (и незаметно) через файловый лок."""
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM predict_markets WHERE id = %s FOR UPDATE", (market_id,))
        market = cur.fetchone()
        if market is None:
            raise ValueError(f"рынок {market_id} не найден")
        if market["status"] != "open":
            raise ValueError(f"рынок {market_id} не открыт")

        amm = LMSRMarket(b=float(market["b"]), q_yes=float(market["q_yes"]), q_no=float(market["q_no"]))
        cost = amm.trade(outcome, shares)

        cur.execute("UPDATE predict_markets SET q_yes = %s, q_no = %s WHERE id = %s", (amm.q_yes, amm.q_no, market_id))

        cur.execute(
            "SELECT * FROM predict_positions WHERE user_id = %s AND market_id = %s AND outcome = %s FOR UPDATE",
            (user_id, market_id, outcome),
        )
        existing = cur.fetchone()
        if existing:
            new_shares = float(existing["shares"]) + shares
            if new_shares < -1e-9:
                raise ValueError("нельзя продать больше shares, чем есть в позиции")
            cur.execute("UPDATE predict_positions SET shares = %s WHERE id = %s", (max(new_shares, 0), existing["id"]))
        else:
            if shares < 0:
                raise ValueError("нельзя продать shares без существующей позиции")
            cur.execute(
                "INSERT INTO predict_positions (user_id, market_id, outcome, shares) VALUES (%s, %s, %s, %s)",
                (user_id, market_id, outcome, shares),
            )

        cur.execute(
            "INSERT INTO predict_trades (user_id, market_id, outcome, shares, cost_usd) VALUES (%s, %s, %s, %s, %s)",
            (user_id, market_id, outcome, shares, cost),
        )
    return cost


def create_market(conn, kind: str, question: str, resolve_at, b: float,
                   lighter_market_id: int | None = None, threshold: float | None = None, comparator: str | None = None) -> str:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO predict_markets (kind, question, lighter_market_id, threshold, comparator, resolve_at, b) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (kind, question, lighter_market_id, threshold, comparator, resolve_at, b),
        )
        return str(cur.fetchone()["id"])


def list_open_markets(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM predict_markets WHERE status = 'open' ORDER BY resolve_at ASC")
        return cur.fetchall()


def resolve_market(conn, market_id: str, outcome: str, resolved_by: str | None = None, evidence_url: str | None = None):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE predict_markets SET status='resolved', outcome=%s, resolved_by=%s, evidence_url=%s WHERE id = %s",
            (outcome, resolved_by, evidence_url, market_id),
        )


def claim_winnings(conn, user_id: str, market_id: str) -> float:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM predict_markets WHERE id = %s", (market_id,))
        market = cur.fetchone()
        if market is None or market["status"] != "resolved":
            raise ValueError("рынок не резолвлен")

        # FOR UPDATE здесь предотвращает двойной claim при двух параллельных
        # запросах на выплату одной и той же позиции — тот же класс гонки,
        # что и в торговле, просто на claim, а не на trade.
        cur.execute(
            "SELECT * FROM predict_positions WHERE user_id = %s AND market_id = %s AND outcome = %s FOR UPDATE",
            (user_id, market_id, market["outcome"]),
        )
        pos = cur.fetchone()
        if pos is None or pos["claimed"]:
            return 0.0
        payout = float(pos["shares"]) * 1.0
        cur.execute("UPDATE predict_positions SET claimed = true WHERE id = %s", (pos["id"],))
    return payout


# --- Копи-трейдинг: тот же принцип блокировки на fan-out записи ------------

def update_mirrored_size_locked(conn, follow_id: str, delta: float):
    """Инкремент, не replace — при параллельных частичных заполнениях одной
    и той же зеркальной позиции replace потерял бы промежуточные обновления
    так же, как в predict-торговле. FOR UPDATE + инкремент вместо
    read-modify-write на стороне Python устраняет гонку на уровне SQL."""
    with conn.cursor() as cur:
        cur.execute("SELECT current_mirrored_size FROM follows WHERE id = %s FOR UPDATE", (follow_id,))
        row = cur.fetchone()
        if row is None:
            raise ValueError(f"follow {follow_id} не найден")
        cur.execute(
            "UPDATE follows SET current_mirrored_size = current_mirrored_size + %s WHERE id = %s",
            (delta, follow_id),
        )
