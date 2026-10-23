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
import logging
import time
import random
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from cache import cached
from config import LIGHTER_NETWORK, LIGHTER_HOSTS
from funding_arb import base_asset, snapshot_from_signed_rate

logger = logging.getLogger("wake.lighter")

MAX_RETRIES = 3
RETRY_DELAY = 1.0

# Длительность интервала в мс — те же разрешения, что принимает /candles.
RESOLUTION_MS = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "12h": 43_200_000,
    "1d": 86_400_000,
}


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
    """GET с повторами только там, где повтор имеет смысл.

    HTTPError — подкласс URLError, поэтому прежний код трижды долбил и 403, и
    404, и 429 с паузами 1+2 с: запрос к закрытому эндпоинту (например
    /orderBooks с depth, который Lighter отдаёт 403) висел по 3.5 секунды и
    сжигал квоту, а на 429 просил ещё больше. Повторяются только сетевые сбои и
    5xx — то, что действительно может пройти при следующем попытке.
    """
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise RuntimeError(
                    f"Lighter API: HTTP {e.code} для {url.split('?')[0]}"
                ) from e
            last_err = e
            if attempt < MAX_RETRIES - 1:
                delay = RETRY_DELAY * (2**attempt) + random.uniform(0, 0.5)
                time.sleep(delay)
        except urllib.error.URLError as e:
            last_err = e
            if attempt < MAX_RETRIES - 1:
                # Exponential backoff with jitter: 1s, 2s, 4s + random 0-0.5s
                delay = RETRY_DELAY * (2**attempt) + random.uniform(0, 0.5)
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


def get_account_index_by_l1(
    l1_address: str, network: str = LIGHTER_NETWORK
) -> int | None:
    """Индекс аккаунта Lighter по его L1-адресу, None если аккаунта нет.

    Нужен бэкенду, а не только фронту: вход кошелька привязывает к подписчику
    индекс, извлечённый здесь, а не присланный клиентом. Иначе «опубликовать
    лидера» можно было бы чужим индексом аккаунта, и Discover показывал бы чужую
    статистику под чужим handle.
    """
    data = _get(f"{_base(network)}/account?by=l1_address&value={l1_address}")
    accounts = data.get("accounts") or []
    return int(accounts[0]["index"]) if accounts else None


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


def get_candles(
    market_id: int,
    resolution: str = "1h",
    count: int = 24,
    network: str = LIGHTER_NETWORK,
    end_ms: int | None = None,
) -> list:
    """Ровно последние `count` свечей, оканчивая моментом `end_ms` (по умолчанию
    — сейчас).

    Живое поведение (замерено на mainnet 2026-10-02, а не по докам): количество
    свечей задаёт ОКНО, а не count_back — при start_timestamp=0 Lighter отдаёт
    500 свечей независимо от count_back, при вменяемом окне отдаёт
    окно/разрешение, т.е. count_back=24 на окне в 26 интервалов возвращает 26
    свечей. Поэтому окно берётся с запасом в 2 интервала (чтобы округление по
    таймстемпам не откусило нужную свечу), а лишнее отрезается здесь — иначе
    «оборот за 24ч» молча считается по 26 часам.

    end_ms нужен для резолюции price-рынков: окно обязано заканчиваться дедлайном
    рынка, а не моментом, в который резолвер наконец проснулся.
    """
    interval_ms = RESOLUTION_MS[resolution]
    last_ms = int(time.time() * 1000) if end_ms is None else int(end_ms)
    url = (
        f"{_base(network)}/candles?market_id={market_id}&resolution={resolution}"
        f"&start_timestamp={last_ms - (count + 2) * interval_ms}&end_timestamp={last_ms}"
        f"&count_back={count}&set_timestamp_to_end=true"
    )
    data = _get(url)
    return data.get("c", [])[-count:]


def get_price_at(
    market_id: int, when_s: float, network: str = LIGHTER_NETWORK
) -> float:
    """Цена закрытия минуты, в которую попал момент `when_s`.

    Для резолюции price-рынка это единственный корректный оракул: исход «BTC
    выше 100k на 1 октября» обязан решаться ценой 1 октября. Прежний
    get_mark_price брал последнюю свечу НА МОМЕНТ ЗАПРОСА, и пока резолвер был
    жив (тик 300 с) это было почти верно, но пропуск на сутки-неделю превращал
    исход в цену совсем другого дня — а по этим исходам люди получают выплаты.
    Окно заканчивается дедлайном, так что ответ не зависит от того, когда
    процесс проснулся."""
    interval_ms = RESOLUTION_MS["1m"]
    when_ms = int(when_s * 1000)
    candles = get_candles(market_id, "1m", 6, network, end_ms=when_ms + interval_ms)
    # Свеча покрывает [t, t+1м): нужна последняя с t <= when_ms.
    covering = [c for c in candles if int(c["t"]) <= when_ms]
    if not covering:
        raise RuntimeError(
            f"нет свечей, покрывающих момент {when_s}, для market_id={market_id}"
        )
    return float(covering[-1]["c"])


def stats_from_candles(candles: list) -> dict:
    """Цена, изменение, оборот и диапазон окна по готовым свечам.

    Вынесено из get_24h_stats, чтобы у бота путь был один: он уже держит свечи
    ради спарклайна, и второй запрос за теми же числами только удвоил бы
    задержку ответа. Считается по тому же набору, что и изменение, — «диапазон
    24ч» из тех же 24 часов, а не из другого окна.

    Самая свежая свеча ещё формируется, поэтому high/low включают её текущий
    максимум: это диапазон наблюдавшихся цен, а не закрытых часов."""
    if not candles:
        return {}
    first_open = float(candles[0]["o"])
    last_close = float(candles[-1]["c"])
    return {
        "price": last_close,
        "change_24h": (last_close / first_open - 1) if first_open > 0 else 0.0,
        "quote_volume_24h": sum(float(c["V"]) for c in candles),
        "high_24h": max(float(c["h"]) for c in candles),
        "low_24h": min(float(c["l"]) for c in candles),
        "closes": [float(c["c"]) for c in candles],
        "candles_used": len(candles),
    }


def get_24h_stats(market_id: int, network: str = LIGHTER_NETWORK) -> dict:
    """Цена, изменение и оборот за 24 часа по 24 часовым свечам.

    Все числа считаются по одному запросу и одному источнику, поэтому «оборот
    24ч» — это сумма quote-объёма реальных свечей (поле V), а не оценка и не
    поле, которого в ответе Lighter нет. Самая свежая свеча ещё формируется:
    изменение — от открытия первой свечи окна к её текущему close."""
    stats = stats_from_candles(get_candles(market_id, "1h", 24, network))
    if not stats:
        raise RuntimeError(f"нет свечей для market_id={market_id}")
    return stats


@cached("funding_rate", ttl=60)
def get_funding_rate(market_id: int, network: str = LIGHTER_NETWORK) -> dict:
    """Ставка funding по конкретному рынку Lighter.

    Без фильтра по exchange бралась бы последняя строка ответа — то есть чужая
    площадка (для market_id=1 так приходила ставка LIT с hyperliquid). Поле
    direction в ответе отсутствует, знак живёт в самом числе, поэтому
    направление выводится из знака, а не подставляется "long" по умолчанию."""
    market_id = int(market_id)

    def _same_market(row) -> bool:
        """Совпадение по market_id площадки Lighter.

        int() от поля, которое в других ответах этой же книги приходит СТРОКОЙ,
        бросает ValueError на любой мусорной строке — раньше один битый market_id
        в ответе /funding-rates вешал весь /funding и бота. Строку-не-число
        просто не считаем совпадением."""
        if row.get("exchange") != "lighter":
            return False
        try:
            return int(row.get("market_id", -1)) == market_id
        except (TypeError, ValueError):
            return False

    row = next((r for r in get_funding_rates(network) if _same_market(r)), None)
    if row is None:
        raise RuntimeError(f"нет funding rate для market_id={market_id}")
    try:
        signed = float(row["rate"])
    except (KeyError, TypeError, ValueError) as e:
        raise RuntimeError(f"ставка funding для market_id={market_id} не число") from e
    snapshot = snapshot_from_signed_rate(market_id, row.get("symbol", ""), signed)
    return {
        "market_id": market_id,
        "symbol": snapshot.symbol,
        "rate": snapshot.hourly_rate,
        "signed_rate": signed,
        "direction": snapshot.direction,
    }


# Именованная вселенная для рейтингов «что ликвиднее». Это не «топ по обороту со
# всей книги»: цены и оборота в orderBooks нет (замерено 2026-10-03 — там есть
# open_interest в БАЗОВЫХ единицах, а он несопоставим между BTC и LIT), поэтому
# ранжирование возможно только по свечам, а свечей на 211 активных перпов —
# 211 запросов. Каждый символ ниже проверен как активный перп mainnet; TON и
# MATIC среди них отсутствуют, и в списке их нет осознанно, а не по забывчивости.
MAJOR_PERPS = (
    "BTC",
    "ETH",
    "SOL",
    "XRP",
    "BNB",
    "DOGE",
    "ADA",
    "LINK",
    "AVAX",
    "UNI",
    "AAVE",
    "LIT",
    "HYPE",
    "1000PEPE",
    "WLD",
    "ARB",
    "OP",
    "SUI",
)


def _num(row: dict, key: str, default: float = 0.0) -> float:
    """Числовые поля книги Lighter приходит СТРОКАМИ ("min_base_amount":
    "0.00007", "open_interest": "372.658848") — приведение явное, и отсутствующее
    поле не должно обрывать целый обзор ради одного рынка."""
    try:
        return float(row[key])
    except (KeyError, TypeError, ValueError):
        return default


@cached("market_overview", ttl=60)
def get_market_overview(
    symbols: tuple = MAJOR_PERPS, network: str = LIGHTER_NETWORK
) -> dict:
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

    known = []
    for symbol in symbols:
        book = by_base.get(base_asset(str(symbol)))
        if book is None:
            continue
        known.append((symbol, int(book["market_id"])))

    # 18 свечных запросов подряд — это 18 × сетевой RTT (на mainnet ~6с за
    # запрос, суммарно холодный ответ растягивался на ~2 минуты). Свечи разных
    # рынков не зависят друг от друга, поэтому параллелим; ThreadPoolExecutor
    # вместо async, потому что _get — блокирующий urllib, а функция синхронная.
    with ThreadPoolExecutor(max_workers=len(known) or 1) as pool:
        futures = {
            symbol: pool.submit(get_24h_stats, market_id, network)
            for symbol, market_id in known
        }
        stats_by_symbol = {}
        for symbol, future in futures.items():
            try:
                stats_by_symbol[symbol] = future.result()
            except Exception as e:
                # Не только RuntimeError: у рынка без свечей их нет, но битая
                # строка в ответе (KeyError на "c") или OverflowError не имеют
                # права вешать весь обзор — страница и бот остаются с остальными
                # рынками, а этот попадёт в no_data.
                logger.warning("рынок %s без статистики: %s", symbol, e)

    known_symbols = {symbol for symbol, _ in known}
    rows, no_market, no_data = [], [], []
    for symbol in symbols:
        if symbol not in stats_by_symbol:
            (no_market if symbol not in known_symbols else no_data).append(symbol)
            continue
        book = by_base.get(base_asset(str(symbol)))
        market_id = int(book["market_id"])
        stats = stats_by_symbol[symbol]
        rows.append(
            {
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
            }
        )
    rows.sort(key=lambda r: r["quote_volume_24h"], reverse=True)
    return {
        "network": network,
        "ranked_by": "quote_volume_24h",
        "count": len(rows),
        "rows": rows,
        "no_market": no_market,
        "no_data": no_data,
    }
