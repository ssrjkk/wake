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

# ── Окружение тестового процесса — задается здесь, а не в тестовом модуле ─────
# config читает env один раз при импорте и на этом импорте строит настройки,
# поэтому значение должно быть установлено ДО первого импорта config — в любом
# порядкеCollection. Пока это делал только test_api_smoke, прогон `pytest
# test_db.py test_api_smoke.py` падал не из-за кода, а из-за порядка: test_db
# импортировал config раньше, чем test_api_smoke успевал подменить env, и
# подпись Telegram не совпадала с токеном, который уже был в config.
#
# Все шесть значений — фиктивные, сеть и живые деньги ими не задеваются.
CURATOR_TOKEN = "smoke-test-token"
SESSION_SECRET = "smoke-test-session-secret-0123456789abcdef"
BOT_TOKEN = "123456:smoke-test-bot-token"

os.environ["WAKE_CURATOR_TOKEN"] = CURATOR_TOKEN
os.environ["WAKE_SESSION_SECRET"] = SESSION_SECRET
os.environ["TELEGRAM_BOT_TOKEN"] = BOT_TOKEN
# llm_agent читает ключ при импорте и без него решает по правилу. Пустая строка
# тут не «выключить фичу», а закрыть зависимость результата теста от того, что
# случайно окажется в окружении запускающего.
os.environ["ANTHROPIC_API_KEY"] = ""
# Все запросы идут с одного client IP, поэтому несколько классов подряд
# выбивают дефолтное ведро (40) и роуты начинают отдавать 429 вместо своих
# 200/401/404. Сам лимитер проверен в test_rate_limiter.py — здесь он не предмет
# теста, а помеха.
os.environ["WAKE_RATE_LIMIT_CAPACITY"] = "100000"
os.environ["WAKE_RATE_LIMIT_REFILL"] = "100000"

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


_schema_ready = False


async def _reset() -> None:
    """Пересоздаёт схему при первом вызове в процессе и очищает таблицы всегда.

    Схема берётся из pg_models (create_all), а не из alembic: тестам важна
    схема, с которой работают репозитории, а применённые миграции проверяются
    отдельным прогоном `alembic upgrade head` на чистой базе.

    drop_all перед create_all — не перестраховка: create_all молча оставляет
    существующие таблицы как есть, и на локальной базе, созданной до нового
    столбца, тесты падали с UndefinedColumnError вместо «схема разошлась с
    моделью». Базе с суффиксом _test пересоздание схемы не вредит — имя
    проверяется выше именно ради того, чтобы её можно было чистить.
    """
    global _schema_ready
    async with engine.begin() as conn:
        if not _schema_ready:
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
            _schema_ready = True
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
