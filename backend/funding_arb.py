"""
Funding rate арбитраж между перпом и спотом ОДНОГО актива на Lighter —
единственное, что физически строится только там, где перп и спот одного
инструмента живут на одном аккаунте с одной маржой. У большинства бирж это
разделено (или спота вообще нет); у Lighter — в одном месте, подтверждено
живым API (ETH/USDC и другие спот-пары рядом с теми же перпами).

Механика (стандартная "cash and carry", не изобретена):
positive funding (лонги платят шортам) -> шорт перпа + лонг спота того же
актива = дельта-нейтрально, получаешь funding, не зависишь от направления
цены. Это НЕ работает симметрично в обратную сторону без займа актива для
шорта спота — здесь намеренно поддержан только positive-funding случай,
самый доступный, не требующий заёмных механизмов, которых на Lighter не
подтверждено.

Факты, на которых построена математика (не предположены):
- Эпох funding rate у Lighter — 1 ЧАС, не 8, как у многих бирж (подтверждено
  независимым источником, не только их доками) — годовая ставка считается
  на 24*365 эпох, не 3*365. Перепутать это — недооценить APR в 8 раз.
- Ставка в живом ответе /api/v1/funding-rates — СО ЗНАКОМ (на момент проверки
  105 из 737 строк отрицательные), поля direction в ответе нет вовсе:
  keys = exchange, market_id, rate, symbol. Знак и есть направление:
  rate > 0 — лонги платят шортам. FundingSnapshot ниже хранит беззнаковую
  ставку + direction, поэтому знак превращается в direction на границе
  (lighter_rest.get_funding_rate), а не в догадку "всегда long".
- Ответ /funding-rates игнорирует query-параметр market_id: он отдаёт все
  строки разом (несколько площадок на символ — lighter, binance, bybit,
  hyperliquid). Фильтрация по рынку — обязанность клиента.
"""

from dataclasses import dataclass

HOURS_PER_YEAR = 24 * 365  # эпох funding в год у Lighter — 1-часовой эпох, не 8-часовой
VENUES = ("lighter", "binance", "bybit", "hyperliquid")


@dataclass(frozen=True)
class FundingSnapshot:
    market_id: int
    symbol: str
    hourly_rate: float       # беззнаковая величина за час, доля (0.0001 = 0.01%/час)
    direction: str            # "long" | "short" — кто платит: "long" значит лонги платят шортам


@dataclass(frozen=True)
class ArbOpportunity:
    symbol: str
    market_id: int
    annualized_yield: float       # простая (не сложная) годовая доходность, доля
    perp_side: str                  # "short" — сторона перпа, которую нужно открыть
    spot_needed: bool               # True — нужно держать/купить спот того же актива
    hourly_rate: float


def annualized_yield(snapshot: FundingSnapshot) -> float:
    """Простая (не compound) годовая доходность — консервативнее, funding не
    реинвестируется автоматически в размер позиции, как проценты в депозите."""
    return snapshot.hourly_rate * HOURS_PER_YEAR


def snapshot_from_signed_rate(market_id: int, symbol: str, rate: float) -> FundingSnapshot:
    """Живой /funding-rates отдаёт знак в самом числе, а не в отдельном поле.
    Приводим к беззнаковой ставке + direction, которые ожидает остальной модуль:
    rate > 0 — платят лонги (direction="long"), rate < 0 — платят шорты.
    Молча передать отрицательную ставку как direction="long" означало бы
    предложить шортить перп там, где шорты сами платят."""
    return FundingSnapshot(
        market_id=market_id,
        symbol=symbol,
        hourly_rate=abs(rate),
        direction="long" if rate > 0 else "short",
    )


def funding_by_market(rows: list, venue: str = "lighter") -> dict:
    """market_id -> signed rate для одной площадки.

    /funding-rates игнорирует query-параметр market_id и всегда отдаёт все
    строки разом (на момент проверки — 737 строк: 4 площадки × ~200 рынков),
    поэтому одна карта на весь ответ, а не N фильтров. В этом ответе market_id и
    rate приходят числами (замерено на mainnet), но приводятся явно: в orderBooks
    те же поля — строки ("min_base_amount": "0.0050"), и карта с ключами-"строками"
    молча не совпала бы с int-идентификатором рынка."""
    out = {}
    for r in rows:
        if r.get("exchange") != venue:
            continue
        try:
            out[int(r["market_id"])] = float(r["rate"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


QUOTES = ("USDC", "USDT", "USD")


def base_asset(symbol: str) -> str:
    """Нормализация тикера к базовому активу: "BTC-PERP", "btcusdt", "BTC/USDC",
    "BTC" -> "BTC".

    Замерено на живом /funding-rates (mainnet, 737 строк): все четыре площадки —
    Lighter, Binance, Bybit, Hyperliquid — и так отдают голое имя базового
    актива ("BTC"). Значит это НЕ склейка разных конвенций, а обработка ВВОДА:
    юзер впишет "btcperp" или "BTC-USDC", потому что так привыкли подписывать
    инструменты на биржах, и запрос обязан найти те строки, которые API уже
    отдаёт по "BTC".

    Ограничение честно: сопоставление по имени, а не по идентификатору
    инструмента. Тикер, который сам заканчивается на название стейбла (PYUSD),
    сократится неверно — поэтому наружу всегда отдаётся и исходный symbol
    строки, и совпадение смотрятся по нему тоже."""
    s = str(symbol).upper().strip()
    s = s.split("/")[0]
    if s in QUOTES:
        return s  # сам стейбл — тоже актив, превращать его в "C" нельзя
    for junk in ("-PERP", "_PERP"):
        if s.endswith(junk):
            s = s[: -len(junk)]
            break
    for quote in QUOTES:
        if s.endswith(quote) and len(s) > len(quote):
            s = s[: -len(quote)]
            break
    return s


def find_opportunity(snapshot: FundingSnapshot, min_annualized_yield: float = 0.05) -> ArbOpportunity | None:
    """min_annualized_yield по умолчанию 5% — ниже этого операционная сложность
    (открыть 2 ноги, следить за позицией) обычно не стоит свеч. Порог настраиваемый,
    не зашит жёстко."""
    if snapshot.direction != "long":
        # Negative funding (shorts платят longs) — симметричная стратегия потребовала бы
        # шортить спот, то есть занимать актив. Такого механизма на Lighter не
        # подтверждено — намеренно не притворяемся, что это доступно всем.
        return None

    apy = annualized_yield(snapshot)
    if apy < min_annualized_yield:
        return None

    return ArbOpportunity(
        symbol=snapshot.symbol,
        market_id=snapshot.market_id,
        annualized_yield=apy,
        perp_side="short",
        spot_needed=True,
        hourly_rate=snapshot.hourly_rate,
    )


@dataclass(frozen=True)
class DeltaNeutralPosition:
    perp_notional_usd: float
    spot_notional_usd: float
    perp_base_amount: float
    spot_base_amount: float


def size_delta_neutral_position(
    capital_usd: float,
    price: float,
    perp_size_decimals: int,
    spot_size_decimals: int,
    perp_min_base_amount: float,
    spot_min_base_amount: float,
) -> DeltaNeutralPosition | None:
    """Капитал делится пополам — половина под маржу перпа (шорт), половина на
    покупку спота (та же номинальная стоимость, не тот же доллар капитала,
    иначе позиция не дельта-нейтральна). Округление ВНИЗ на обеих ногах —
    тот же принцип, что и everywhere в проекте: никогда не round up на
    размере ордера."""
    if capital_usd <= 0 or price <= 0:
        return None

    leg_notional = capital_usd / 2
    perp_amount = _round_down(leg_notional / price, perp_size_decimals)
    spot_amount = _round_down(leg_notional / price, spot_size_decimals)

    if perp_amount < perp_min_base_amount or spot_amount < spot_min_base_amount:
        return None  # капитала недостаточно даже на минимальный размер обеих ног

    return DeltaNeutralPosition(
        perp_notional_usd=perp_amount * price,
        spot_notional_usd=spot_amount * price,
        perp_base_amount=perp_amount,
        spot_base_amount=spot_amount,
    )


def _round_down(value: float, decimals: int) -> float:
    factor = 10 ** decimals
    return int(value * factor) / factor


@dataclass(frozen=True)
class CarryLegs:
    """Обе ноги одной дельта-нейтральной позиции на одном аккаунте Lighter."""
    symbol: str
    perp_market_id: int
    spot_market_id: int
    perp_min_base_amount: float
    spot_min_base_amount: float
    perp_size_decimals: int
    spot_size_decimals: int


def pairable_carry_markets(books: list, quote: str = "USDC") -> list:
    """Активы, у которых на Lighter прямо сейчас есть ОБЕ ноги cash-and-carry:
    активный перп и активный спот того же инструмента за тот же стейбл.

    Это и есть ответ на вопрос «где вообще работает уникальность Lighter», —
    со списком, полученным из живой книги рынков, а не из предположения.
    Спот-пары приходят как "ETH/USDC", перпы — как "ETH": без приведения к
    базе пересечение пустое, и страница выглядела бы сломанной на полностью
    рабочем API.

    Поля min_base_amount в ответе Lighter — строки ("0.0050"), отсюда явные
    float()/int(). Неактивные книги исключаются: поставить ордер в них нельзя,
    и показывать их как возможность — значит врать про ликвидность."""
    perps = {
        b["symbol"]: b
        for b in books
        if b.get("market_type") == "perp" and b.get("status") == "active" and b.get("symbol")
    }
    legs = []
    for b in books:
        if b.get("market_type") != "spot" or b.get("status") != "active":
            continue
        base, sep, quoted = str(b.get("symbol", "")).partition("/")
        perp = perps.get(base) if sep and quoted == quote else None
        if perp is None:
            continue
        legs.append(CarryLegs(
            symbol=base,
            perp_market_id=int(perp["market_id"]),
            spot_market_id=int(b["market_id"]),
            perp_min_base_amount=float(perp["min_base_amount"]),
            spot_min_base_amount=float(b["min_base_amount"]),
            perp_size_decimals=int(perp["supported_size_decimals"]),
            spot_size_decimals=int(b["supported_size_decimals"]),
        ))
    return sorted(legs, key=lambda l: l.symbol)
