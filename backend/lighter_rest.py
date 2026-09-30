"""
Минимальный клиент к реальному REST API Lighter — только urllib (stdlib), без
requests/httpx, чтобы это можно было гонять где угодно без pip install. Та же
логика, что в src/lib/lighter.ts, портированная в Python специально для
автоматической резолюции price-рынков (predict_resolution.py принимает готовое
число, эта функция — то, что его реально достаёт).

Не тестировалось мной вживую — в этой песочнице нет сети (проверено многократно
за этот разговор). Конструкция URL и разбор ответа сделаны по той же, уже
подтверждённой OpenAPI-схеме, что и lighter.ts.
"""

import json
import urllib.request
import urllib.error

NETWORKS = {
    "mainnet": "https://mainnet.zklighter.elliot.ai/api/v1",
    "testnet": "https://testnet.zklighter.elliot.ai/api/v1",
}


def _get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Lighter API недоступен: {e}") from e


def get_mark_price(market_id: int, network: str = "testnet") -> float:
    """Последняя цена закрытия по market_id — берёт последнюю 1-минутную свечу.
    Для резолюции price-рынков достаточно точно; для чего-то более
    времячувствительного лучше websocket (см. leader_position_tracker.py —
    тот же принцип, другой канал)."""
    base = NETWORKS[network]
    import time
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


def get_funding_rate(market_id: int, network: str = "testnet") -> dict:
    """Реальный эндпоинт /api/v1/funding-rates, подтверждён независимо (не
    только доками Lighter, но и сторонним пакетом lighter-data). Формат строки:
    {timestamp, value, rate, direction} — rate беззнаковый, знак в direction.
    Не тестировалось живьём — нет сети в этой песочнице."""
    base = NETWORKS[network]
    url = f"{base}/funding-rates?market_id={market_id}"
    data = _get(url)
    rates = data.get("funding_rates", data.get("rates", []))
    if not rates:
        raise RuntimeError(f"нет funding rate для market_id={market_id}")
    latest = rates[-1]
    return {"rate": float(latest["rate"]), "direction": latest["direction"], "timestamp": latest["timestamp"]}
