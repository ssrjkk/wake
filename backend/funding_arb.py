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
- rate — беззнаковая величина, знак/направление в отдельном поле direction
  ("long" = лонги платят шортам = позитивный funding в обычном смысле).
"""

from dataclasses import dataclass

HOURS_PER_YEAR = 24 * 365  # эпох funding в год у Lighter — 1-часовой эпох, не 8-часовой


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
