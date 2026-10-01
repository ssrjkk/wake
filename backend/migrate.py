"""
Миграции БД — простая система версионирования схемы.

Каждая миграция — это функция, которая применяет изменения к БД.
Миграции хранятся в таблице _migrations с именем и timestamp.

Запуск: python -m migrate
"""

import os
import time
import sqlite3
from config import DB_PATH

MIGRATIONS = []


def migration(func):
    """Декоратор для регистрации миграций."""
    MIGRATIONS.append(func)
    return func


def init_migrations_table(conn):
    """Создаёт таблицу для хранения информации о миграциях."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS _migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at REAL NOT NULL
        )
    """)


def get_applied_migrations(conn):
    """Возвращает список уже применённых миграций."""
    cursor = conn.execute("SELECT name FROM _migrations ORDER BY applied_at")
    return {row[0] for row in cursor.fetchall()}


def apply_migration(conn, func):
    """Применяет одну миграцию и записывает её в таблицу."""
    func(conn)
    conn.execute(
        "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
        (func.__name__, time.time()),
    )


@migration
def add_mirror_log_indexes(conn):
    """Добавляет индексы для mirror_log."""
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_mirror_log_market ON mirror_log(market_id)
    """)


@migration
def add_predict_markets_indexes(conn):
    """Добавляет индексы для predict_markets."""
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_predict_markets_status ON predict_markets(status)
    """)


def run_migrations(db_path: str = None):
    """Запускает все неприменённые миграции."""
    db_path = db_path or DB_PATH
    conn = sqlite3.connect(db_path)
    try:
        init_migrations_table(conn)
        applied = get_applied_migrations(conn)
        pending = [m for m in MIGRATIONS if m.__name__ not in applied]
        if not pending:
            print("No pending migrations")
            return
        for func in pending:
            print(f"Applying migration: {func.__name__}")
            apply_migration(conn, func)
        conn.commit()
        print(f"Applied {len(pending)} migration(s)")
    finally:
        conn.close()


if __name__ == "__main__":
    run_migrations()