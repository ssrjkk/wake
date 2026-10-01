"""
Общие константы конфигурации для всех роутеров и слоёв бэкенда. Единственное
место, где задаются пути к БД и настройки rate limiting — чтобы роутеры не
дублировали эти значения и не расходились между собой.

Всё, что тут есть, можно переопределить переменными окружения — среда
(тестнет/прод, путь к файлам БД) не должна жить в коде роутеров.
"""

import os
import logging

DB_PATH = os.environ.get("WAKE_DB_PATH", "wake.db")
AUDIT_DB_PATH = os.environ.get("WAKE_AUDIT_DB_PATH", "audit.db")

# CORS origins — через env, чтобы не хардкодить localhost в проде.
# Несколько источников — через запятую.
CORS_ORIGINS = [o.strip() for o in os.environ.get("WAKE_CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

# 20 запросов/сек постоянно + запас burst 40 — на реальном трафике эти числа
# нужно откалибровать по факту, это отправная точка, не священное число.
RATE_LIMIT_CAPACITY = int(os.environ.get("WAKE_RATE_LIMIT_CAPACITY", "40"))
RATE_LIMIT_REFILL = int(os.environ.get("WAKE_RATE_LIMIT_REFILL", "20"))

# Логирование: уровень через env (DEBUG/INFO/WARNING/ERROR), формат с timestamp
LOG_LEVEL = os.environ.get("WAKE_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)