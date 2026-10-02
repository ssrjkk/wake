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
from config import LIGHTER_NETWORK, LIGHTER_HOSTS
from funding_arb import base_asset, snapshot_from_signed_rate

MAX_RETRIES = 3
RETRY_DELAY = 1.0

# Длительность интервала в мс — те же разрешения, что принимает /candles.
RESOLUTION_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
                 "1h": 3_600_000, "4h": 14_400_000, "12h": 43_200_000, "1d": 86_400_000}


def _base(network: str) -> str:
    """Хосты берутся из config.LIGHTER_HOSTS: сеть, из которой тянутся данные,
    не может разойтись с сетью, на которой работают ордера. Неизвестная сеть —
    ValueError с внятным текстом, а не KeyError внутри уже начатого запроса
    (WAKE_LIGHTER_NETWORK с опечаткой — частый случай)."""
    host = LIGHTER_HOSTS.get(network)
    if host is None:
        raise ValueError(
            f"неизвестная сеть Lighter: {network!r}. Доступно: {', '.join(sorted(LIGHTER_HOSTS))}"
        )
    return f"https://{host}/api/v1"


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
def get_order_books(network: str = LIGHTER_NETWORK) -> list:
    """Список всех рынков с их параметрами (min_base_amount, supported_size_decimals и т.д.).
    Нужен для динамического получения constraints в leader_listener.py.
    Кэшируется на 30 секунд — список рынков не меняется часто."""
    url = f"{_base(network)}/orderBooks?filter=all"
    data = _get(url)
    return data.get("order_books", [])


def get_mark_price(market_id: int, network: str = LIGHTER_NETWORK) -> float:
    """Последняя цена закрытия по market_id — close последней 1-минутной свечи.
    Для резолюции price-рынков достаточно точно; для чего-то более
    времячувствительного лучше websocket (см. leader_position_tracker.py —
    тот же принцип, другой канал)."""
    candles = get_candles(market_id, "1m", 10, network)
    if not candles:
        raise RuntimeError(f"нет свечей для market_id={market_id}")
    return float(candles[-1]["c"])


@cached("funding_rates", ttl=60)
def get_funding_rates(network: str = LIGHTER_NETWORK) -> list:
    """Все ставки funding разом. Фильтр market_id в query Lighter игнорирует —
    ответ всегда полный (~700 строк: 4 площадки × ~200 рынков), поэтому
    дёргать этот запрос на каждый рынок бессмысленно."""
    data = _get(f"{_base(network)}/funding-rates")
    return data.get("funding_rates", data.get("rates", []))


def get_candles(market_id: int, resolution: str = "1h", count: int = 24,
                network: str = LIGHTER_NETWORK) -> list:
    """Ровно последние `count` свечей.

    Живое поведение (замерено на mainnet 2026-10-02, а не по докам): количество
    свечей задаёт ОКНО, а не count_back — при start_timestamp=0 Lighter отдаёт
    500 свечей независимо от count_back, при вменяемом окне отдаёт
    окно/разрешение, т.е. count_back=24 на окне в 26 интервалов возвращает 26
    свечей. Поэтому окно берётся с запасом в 2 интервала (чтобы округление по
    таймстемпам не откусило нужную свечу), а лишнее отрезается здесь — иначе
    «оборот за 24ч» молча считается по 26 часам.
    """
    interval_ms = RESOLUTION_MS[resolution]
    now_ms = int(time.time() * 1000)
    url = (
        f"{_base(network)}/candles?market_id={market_id}&resolution={resolution}"
        f"&start_timestamp={now_ms - (count + 2) * interval_ms}&end_timestamp={now_ms}"
        f"&count_back={count}&set_timestamp_to_end=true"
    )
    data = _get(url)
    return data.get("c", [])[-count:]


def get_24h_stats(market_id: int, network: str = LIGHTER_NETWORK) -> dict:
    """Цена, изменение и оборот за 24 часа по 24 часовым свечам.

    Все три числа считаются по одному запросу и одному источнику, поэтому
    «оборот 24ч» — это сумма quote-объёма реальных свечей (поле V), а не
    оценка и не поле, которого в ответе Lighter нет. Самая свежая свеча ещё
    формируется: изменение — от открытия первой свечи окна к её текущему close."""
    candles = get_candles(market_id, "1h", 24, network)
    if not candles:
        raise RuntimeError(f"нет свечей для market_id={market_id}")
    first_open = float(candles[0]["o"])
    last_close = float(candles[-1]["c"])
    return {
        "price": last_close,
        "change_24h": (last_close / first_open - 1) if first_open > 0 else 0.0,
        "quote_volume_24h": sum(float(c["V"]) for c in candles),
        "candles_used": len(candles),
    }


@cached("funding_rate", ttl=60)
def get_funding_rate(market_id: int, network: str = LIGHTER_NETWORK) -> dict:
    """Ставка funding по конкретному рынку Lighter.

    Без фильтра по exchange бралась бы последняя строка ответа — то есть чужая
    площадка (для market_id=1 так приходила ставка LIT с hyperliquid). Поле
    direction в ответе отсутствует, знак живёт в самом числе, поэтому
    направление выводится из знака, а не подставляется "long" по умолчанию."""
    market_id = int(market_id)
    row = next((r for r in get_funding_rates(network)
                if r.get("exchange") == "lighter" and int(r.get("market_id", -1)) == market_id), None)
    if row is None:
        raise RuntimeError(f"нет funding rate для market_id={market_id}")
    snapshot = snapshot_from_signed_rate(market_id, row.get("symbol", ""), float(row["rate"]))
    return {
        "market_id": market_id,
        "symbol": snapshot.symbol,
        "rate": snapshot.hourly_rate,
        "signed_rate": float(row["rate"]),
        "direction": snapshot.direction,
    }


# Именованная вселенная для рейтингов «что ликвиднее». Это не «топ по обороту со
# всей книги»: цены и оборота в orderBooks нет (замерено 2026-10-03 — там есть
# open_interest в БАЗОВЫХ единицах, а он несопоставим между BTC и LIT), поэтому
# ранжирование возможно только по свечам, а свечей на 211 активных перпов —
# 211 запросов. Каждый символ ниже проверен как активный перп mainnet; TON и
# MATIC среди них отсутствуют, и в списке их нет осознанно, а не по забывчивости.
MAJOR_PERPS = ("BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "LINK", "AVAX",
               "UNI", "AAVE", "LIT", "HYPE", "1000PEPE", "WLD", "ARB", "OP", "SUI")


def _num(row: dict, key: str, default: float = 0.0) -> float:
    """Числовые поля книги Lighter приходит СТРОКАМИ ("min_base_amount":
    "0.00007", "open_interest": "372.658848") — приведение явное, и отсутствующее
    поле не должно обрывать целый обзор ради одного рынка."""
    try:
        return float(row[key])
    except (KeyError, TypeError, ValueError):
        return default


@cached("market_overview", ttl=60)
def get_market_overview(symbols: tuple = MAJOR_PERPS,
                        network: str = LIGHTER_NETWORK) -> dict:
    """Цена, изменение и оборот за 24ч по каждому рынку, отсортированные по обороту.

    Один запрос к книге + по одному свечному запросу на рынок, всё под общим
    TTL 60с — /markets в боте и главный экран сайта считают один и тот же
    показатель по одним и тем же данным.

    Нет активного перпа по символу — символ попадает в no_market; нет свечей —
    в no_data. Молча выбросить рынок из «рейтинга» означало бы соврать про то,
    что на Lighter вообще торгуется."""
    books = get_order_books(network)
    by_base = {}
    for book in books:
        if book.get("market_type") != "perp" or book.get("status") != "active":
            continue
        by_base.setdefault(base_asset(str(book.get("symbol", ""))), book)

    rows, no_market, no_data = [], [], []
    for symbol in symbols:
        book = by_base.get(base_asset(str(symbol)))
        if book is None:
            no_market.append(symbol)
            continue
        market_id = int(book["market_id"])
        try:
            stats = get_24h_stats(market_id, network)
        except RuntimeError:
            no_data.append(symbol)
            continue
        rows.append({
            "market_id": market_id,
            "symbol": str(book.get("symbol", "")),
            "base": base_asset(str(book.get("symbol", ""))),
            "price": stats["price"],
            "change_24h": stats["change_24h"],
            "quote_volume_24h": stats["quote_volume_24h"],
            "open_interest_base": _num(book, "open_interest"),
            "min_base_amount": _num(book, "min_base_amount"),
            "size_decimals": int(_num(book, "supported_size_decimals")),
            "taker_fee": _num(book, "taker_fee"),
            "maker_fee": _num(book, "maker_fee"),
        })
    rows.sort(key=lambda r: r["quote_volume_24h"], reverse=True)
    return {
        "network": network,
        "ranked_by": "quote_volume_24h",
        "count": len(rows),
        "rows": rows,
        "no_market": no_market,
        "no_data": no_data,
    }