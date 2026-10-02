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

# Реальные ордера уходят только при WAKE_DRY_RUN=false — значение задаётся одно,
# чтобы листенер и агент не разошлись по режиму исполнения на одном хосте.
DRY_RUN = os.environ.get("WAKE_DRY_RUN", "true").lower() != "false"

# Сеть Lighter по умолчанию — mainnet. Тестнет как умолчание был источником
# неверных данных: ограничения рынка для копирования брались из тестнет-книги,
# а price-рынки резолвились ценой тестовой сети. Тестнет остаётся явным выбором
# (WAKE_LIGHTER_NETWORK=testnet).
LIGHTER_NETWORK = os.environ.get("WAKE_LIGHTER_NETWORK", "mainnet")

# Хосты Lighter. Одна сеть — одни адреса: раньше REST и WS-URL задавались в
# каждом модуле по-своему, и листенер мог слушать тестнет-стрим, беря
# ограничения рынка из mainnet-книги. Неизвестное имя сети — ошибка на старте,
# а не пустые данные в рантайме.
LIGHTER_HOSTS = {
    "mainnet": "mainnet.zklighter.elliot.ai",
    "testnet": "testnet.zklighter.elliot.ai",
}
if LIGHTER_NETWORK not in LIGHTER_HOSTS:
    raise ValueError(
        f"WAKE_LIGHTER_NETWORK={LIGHTER_NETWORK!r}: доступно только "
        f"{', '.join(sorted(LIGHTER_HOSTS))}"
    )

LIGHTER_HOST = LIGHTER_HOSTS[LIGHTER_NETWORK]
LIGHTER_BASE_URL = os.environ.get("LIGHTER_BASE_URL", f"https://{LIGHTER_HOST}")
LIGHTER_WS_URL = os.environ.get("LIGHTER_WS_URL", f"wss://{LIGHTER_HOST}/stream")

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

# Telegram bot token for authentication verification
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")