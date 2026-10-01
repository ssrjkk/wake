"""
Минимальный клиент к реальному REST API Lighter — только urllib (stdlib), без
requests/httpx, чтобы это можно было гонять где угодно без pip install. Та же
логика, что в src/lib/lighter.ts, портированная в Python специально для
автоматической резолюции price-рынков (predict_resolution.py принимает готовое
число, эта функция — то, что его реально достаёт).

Кэширование: orderBooks и funding rates кэшируются на 30-60 секунд, чтобы
не нагружать API и ускорить ответы. В проде заменить на Redis.
"""

import json
import time
import random
import urllib.request
import urllib.error
from cache import cached

NETWORKS = {
    "mainnet": "https://mainnet.zklighter.elliot.ai/api/v1",
    "testnet": "https://testnet.zklighter.elliot.ai/api/v1",
}

MAX_RETRIES = 3
RETRY_DELAY = 1.0


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.URLError as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                # Exponential backoff with jitter: 1s, 2s, 4s + random 0-0.5s
                delay = RETRY_DELAY * (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(delay)
    raise RuntimeError(f"Lighter API недоступен: {last_err}")


@cached("order_books", ttl=30)
def get_order_books(network: str = "testnet") -> list:
    """Список всех рынков с их параметрами (min_base_amount, supported_size_decimals и т.д.).
    Нужен для динамического получения constraints в leader_listener.py.
    Кэшируется на 30 секунд — список рынков не меняется часто."""
    base = NETWORKS[network]
    url = f"{base}/orderBooks?filter=all"
    data = _get(url)
    return data.get("order_books", [])


def get_mark_price(market_id: int, network: str = "testnet") -> float:
    """Последняя цена закрытия по market_id — берёт последнюю 1-минутную свечу.
    Для резолюции price-рынков достаточно точно; для чего-то более
    времячувствительного лучше websocket (см. leader_position_tracker.py —
    тот же принцип, другой канал)."""
    base = NETWORKS[network]
    now_ms = int(time.time() * 1000)
    url = (
        f"{base}/candles?market_id={market_id}&resolution=1m"
        f"&start_timestamp=0&end_timestamp={now_ms}&count_back=1&set_timestamp_to_end=true"
    )
    data = _get(url)
    candles = data.get("c", [])
    if not candles:
        raise RuntimeError(f"нет свечей для market_id={market_id}")
    return float(candles[-1]["c"])


@cached("funding_rate_{market_id}", ttl=60)
def get_funding_rate(market_id: int, network: str = "testnet") -> dict:
    """Реальный эндпоинт /api/v1/funding-rates. Формат строки может отличаться
    между сетями и версиями API — парсим defensive, не падаем на отсутствующих
    полях (например, direction может отсутствовать).
    Кэшируется на 60 секунд — funding rate меняется раз в час."""
    base = NETWORKS[network]
    url = f"{base}/funding-rates?market_id={market_id}"
    data = _get(url)
    rates = data.get("funding_rates", data.get("rates", []))
    if not rates:
        raise RuntimeError(f"нет funding rate для market_id={market_id}")
    latest = rates[-1]
    return {
        "rate": float(latest.get("rate", latest.get("value", 0))),
        "direction": latest.get("direction", "long"),
        "timestamp": latest.get("timestamp", 0),
    }