"""
Подключение к PostgreSQL: движок, сессии, закрытие пула.

Единственный путь в базу для всего бэкенда: api/auth.py работает через Depends
(get_db), репозитории (db.py, predict_db.py, audit_log.py) открывают короткую
сессию на операцию — держать соединение пула через сетевой вызов нельзя.

DATABASE_URL — из WAKE_DATABASE_URL, echo — из WAKE_DB_ECHO; оба читаются через
config.py, который умеет и .env.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

# Один источник правды — pydantic-settings (config.py), который читает .env.
# Прямой os.environ.get() здесь пропускал .env: движок всегда уходил в
# дефолтный localhost PostgreSQL, а /ready честно отвечал database: fail.
# echo болел тем же: WAKE_DB_ECHO из .env до движка не доходил.
from config import DATABASE_URL, DB_ECHO

engine = create_async_engine(
    DATABASE_URL,
    echo=DB_ECHO,
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


async def close_db() -> None:
    """Dispose engine connections (called on app shutdown)."""
    await engine.dispose()
