"""
Общая фикстура тестов, которые ходят в PostgreSQL.

Тесты идут в настоящую базу, а не в mock: db.py, predict_db.py и audit_log.py
пишут PostgreSQL-специфичный SQL (ON CONFLICT DO UPDATE, TIMESTAMPTZ, FOR
UPDATE), и проверять его на другом диалекте — значит проверять не тот код,
который работает в проде.

База обязана быть отдельной: перед каждым тестом таблицы очищаются TRUNCATE,
поэтому имя с суффиксом _test проверяется здесь, а не подразумевается, —
случайный запуск pytest не должен стирать рабочую базу.

WAKE_TEST_DATABASE_URL подменяется до импорта config и database: оба читают
env при импорте и на этом импорте строят движок с пулом, поэтому импортировать
этот модуль нужно первым.
"""

import asyncio
import os
import unittest

from sqlalchemy import text

_TEST_URL = os.environ.get("WAKE_TEST_DATABASE_URL")
if not _TEST_URL:
    raise RuntimeError(
        "WAKE_TEST_DATABASE_URL не задан, а тесты идут в отдельную базу. "
        "Например: createdb wake_test && export WAKE_TEST_DATABASE_URL="
        "postgresql+asyncpg://wake:wake@localhost:5432/wake_test"
    )
_db_name = _TEST_URL.rstrip("/").split("/")[-1]
if not _db_name.endswith("_test"):
    raise RuntimeError(
        f"База для тестов должна называться с суффиксом _test, получено {_db_name!r}"
    )

os.environ["WAKE_DATABASE_URL"] = _TEST_URL

from database import engine  # noqa: E402
from pg_models import Base  # noqa: E402


def run(coro):
    """Прогоняет корутину в собственном цикле и отдаёт пул до выхода из него.

    Соединение asyncpg привязано к циклу, в котором открыто: оставить его в пуле
    после закрытия цикла — значит передать чужому циклу мёртвый сокет, и на Windows
    это AttributeError в глубине пула, а не ошибка проверяемого кода. Поэтому dispose
    происходит в том же цикле, где и работа, и между запусками в пуле не остаётся
    ничего: тесты с sync-вызовами и тесты на async-цикле (PgCase, HTTP-слой) могут
    идти в одном процессе и в одном пуле.
    """

    async def _in_this_loop():
        try:
            return await coro
        finally:
            await engine.dispose()

    return asyncio.run(_in_this_loop())


async def _reset() -> None:
    """Создаёт схему, если её ещё нет, и очищает все таблицы.

    Схема берётся из pg_models (create_all), а не из alembic: тестам важна
    схема, с которой работают репозитории, а применённые миграции проверяются
    отдельным прогоном `alembic upgrade head` на чистой базе.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))


def reset() -> None:
    run(_reset())


class PgCase(unittest.IsolatedAsyncioTestCase):
    """То же, что reset() + run(), но для тестов, которые живут в async-цикле.

    Нужен, когда тест сам ведёт цикл: у IsolatedAsyncioTestCase он свой на каждый
    тест, поэтому teardown обязан отдать пул — иначе соединение из закрытого
    цикла досталось бы следующему тесту.
    """

    async def asyncSetUp(self):
        await _reset()

    async def asyncTearDown(self):
        await engine.dispose()
