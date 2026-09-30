"""
Ядро копи-движка: чистая логика вычисления зеркальных ордеров.

Никакого исполнения, никаких приватных ключей, никакой сети — только математика.
Именно поэтому этот файл можно писать и тестировать прямо сейчас, безопасно,
до того как решён вопрос хранения чужих API-ключей (см. ROADMAP-TO-PRODUCTION.md, раздел 2).

Как это стыкуется с остальным:

    LeaderEvent --> [этот файл] --> список MirrorOrder --> place_order_example.py
    (для каждого ордера — свой API-ключ конкретного подписчика) --> Lighter

Этот файл — явный, протестированный ответ на две конкретные открытые развилки
из ROADMAP-TO-PRODUCTION.md:

  - "что если у подписчика не хватило маржи?"
    -> здесь: явный skip с причиной в MirrorPlan.skipped, не тихий сбой и не
       произвольное урезание без объяснения.

  - "лидер закрывает — как ведут себя подписчики?"
    -> здесь: пропорциональное закрытие от ТЕКУЩЕГО зеркального размера
       подписчика (сколько у НЕГО открыто), а не пересчёт от позиции лидера —
       подписчик мог зайти позже лидера, с другим размером и по другой цене,
       и должен закрываться от своей позиции, а не от чужой.

Модель сайзинга — proportional risk, не 1:1 копирование размера. Лидер с
$50,000 на счету и подписчик с $200 аллокации НЕ должны выставлять одинаковый
базовый размер ордера — подписчик получает ту же ДОЛЮ риска от СВОЕЙ аллокации,
какую лидер берёт от своего equity. Это стандартный подход серьёзных
копи-трейдинг платформ, а не единственно возможный — но он осознанный выбор,
а не то, что осталось нерешённым.
"""

from dataclasses import dataclass, field
from enum import Enum


class Side(Enum):
    LONG = "long"
    SHORT = "short"


@dataclass(frozen=True)
class LeaderEvent:
    market_id: int
    side: Side
    is_increase: bool           # True = открытие/наращивание, False = уменьшение/закрытие
    size_delta: float           # изменение размера позиции лидера, base-units, всегда > 0
    price: float                 # цена исполнения (для маркет-ордеров — примерная)
    leader_equity_usd: float     # equity лидера на момент сделки — обязателен при is_increase
    leader_position_before: float = 0.0  # размер позиции лидера ДО этого изменения —
                                          # обязателен при not is_increase, для доли закрытия


@dataclass(frozen=True)
class MarketConstraints:
    min_base_amount: float
    size_decimals: int


@dataclass(frozen=True)
class FollowerConfig:
    follower_id: str
    allocation_usd: float
    available_margin_usd: float
    max_leverage: float
    current_mirrored_size: float = 0.0   # текущий размер зеркальной позиции подписчика


@dataclass(frozen=True)
class MirrorOrder:
    follower_id: str
    market_id: int
    side: Side
    base_amount: float
    reduce_only: bool


@dataclass(frozen=True)
class SkippedFollower:
    follower_id: str
    reason: str  # "leader_equity_unavailable" | "below_min_order_size" |
                 # "no_mirrored_position_to_reduce" | "leader_position_before_unavailable" |
                 # "reduce_amount_below_min"


@dataclass(frozen=True)
class MirrorPlan:
    orders: list = field(default_factory=list)    # list[MirrorOrder]
    skipped: list = field(default_factory=list)    # list[SkippedFollower]


def _round_down(value: float, decimals: int) -> float:
    """Всегда вниз — переисполнить чужой ордер хуже, чем недоисполнить."""
    factor = 10 ** decimals
    return int(round(value * factor, 6)) / factor  # round() гасит float-шум перед int()


def compute_mirror_plan(
    event: LeaderEvent,
    followers: list,  # list[FollowerConfig]
    constraints: MarketConstraints,
) -> MirrorPlan:
    plan = MirrorPlan()

    if event.is_increase:
        if event.leader_equity_usd <= 0:
            for f in followers:
                plan.skipped.append(SkippedFollower(f.follower_id, "leader_equity_unavailable"))
            return plan

        leader_notional = event.size_delta * event.price
        leader_risk_fraction = leader_notional / event.leader_equity_usd

        for f in followers:
            desired_notional = leader_risk_fraction * f.allocation_usd
            max_notional_by_margin = f.available_margin_usd * f.max_leverage
            capped_notional = min(desired_notional, max_notional_by_margin)

            base_amount = _round_down(capped_notional / event.price, constraints.size_decimals)

            if base_amount < constraints.min_base_amount:
                plan.skipped.append(SkippedFollower(f.follower_id, "below_min_order_size"))
                continue

            plan.orders.append(MirrorOrder(f.follower_id, event.market_id, event.side, base_amount, reduce_only=False))
        return plan

    # --- уменьшение / закрытие лидером ---
    for f in followers:
        if f.current_mirrored_size <= 0:
            plan.skipped.append(SkippedFollower(f.follower_id, "no_mirrored_position_to_reduce"))
            continue

        if event.leader_position_before <= 0:
            plan.skipped.append(SkippedFollower(f.follower_id, "leader_position_before_unavailable"))
            continue

        close_fraction = min(1.0, event.size_delta / event.leader_position_before)
        reduce_amount = _round_down(f.current_mirrored_size * close_fraction, constraints.size_decimals)

        if reduce_amount < constraints.min_base_amount:
            plan.skipped.append(SkippedFollower(f.follower_id, "reduce_amount_below_min"))
            continue

        plan.orders.append(MirrorOrder(f.follower_id, event.market_id, event.side, reduce_amount, reduce_only=True))

    return plan
