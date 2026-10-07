"""
Async database connection layer for PostgreSQL.

Этот модуль — async-обёртка над SQLAlchemy для PostgreSQL. Используется
новыми эндпоинтами и репозиториями; старый SQLite-слой (db.py) продолжает
работать параллельно до полной миграции.

DATABASE_URL берётся из WAKE_DATABASE_URL (env) или alembic.ini (fallback).
"""

import os
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Один источник правды — pydantic-settings (config.py), который читает .env.
# Прямой os.environ.get() здесь пропускал .env: движок всегда уходил в
# дефолтный localhost PostgreSQL, а /ready честно отвечал database: fail.
from config import DATABASE_URL

engine = create_async_engine(
    DATABASE_URL,
    echo=os.environ.get("WAKE_DB_ECHO", "false").lower() == "true",
    pool_pre_ping=True,
)

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency — yields an async session, auto-closes on exit.

    Usage in endpoints:
        @router.get("/items")
        async def list_items(db: AsyncSession = Depends(get_db)):
            ...
    """
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """Create all tables (dev/test only — production uses Alembic migrations)."""
    from pg_models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    """Dispose engine connections (called on app shutdown)."""
    await engine.dispose()


def is_connected() -> bool:
    """True, если пул движка жив (быстрая проверка без похода в БД)."""
    try:
        return engine.pool.status() != "Pool is closed"  # type: ignore[attr-defined]
    except Exception:
        return False
