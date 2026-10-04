"""
Лимиты на размер транзакции и дневной объём — реальная защита от масштаба
ущерба одного бага, не декорация. Чистая, тестируемая логика: даём запрос на
ордер + текущее состояние лимитов пользователя, получаем разрешение или отказ
с причиной.

Что это НЕ решает, и почему это важно сказать прямо: лимит на транзакцию
защищает от одного огромного ошибочного ордера (баг в decimals, например).
Он НЕ защищает от скомпрометированного ключа, который использует ЧУЖОЙ
процесс много раз подряд в пределах лимита — по чуть-чуть, но постоянно,
пока не заметят. Это не аргумент "не делать лимиты", это аргумент "лимиты и
безопасное хранение ключей — это ответы на РАЗНЫЕ вопросы", и один не
заменяет другой.
"""

from dataclasses import dataclass, field


@dataclass
class RiskLimits:
    max_order_usd: float = 500.0
    max_daily_volume_usd: float = 2000.0
    max_position_usd: float = 1000.0  # суммарная открытая позиция по одному рынку


@dataclass
class UserRiskState:
    user_id: str
    volume_today_usd: float = 0.0
    open_position_usd: dict = field(default_factory=dict)  # market_id -> usd


@dataclass(frozen=True)
class RiskCheckResult:
    allowed: bool
    reason: str = ""
    capped_size_usd: float = 0.0  # если allowed=True, но размер урезан под лимит


def check_order(
    limits: RiskLimits,
    state: UserRiskState,
    market_id: int,
    requested_usd: float,
    is_reduce_only: bool = False,
) -> RiskCheckResult:
    if requested_usd <= 0:
        return RiskCheckResult(False, "размер ордера должен быть положительным")

    if is_reduce_only:
        # Закрытие позиции не должно блокироваться лимитами — иначе лимит
        # мешает выйти из уже открытой позиции, что хуже, чем не иметь лимита.
        return RiskCheckResult(
            True, "reduce_only — лимиты не применяются", capped_size_usd=requested_usd
        )

    if requested_usd > limits.max_order_usd:
        return RiskCheckResult(
            False,
            f"ордер ${requested_usd:.0f} превышает лимит на транзакцию ${limits.max_order_usd:.0f}",
        )

    remaining_daily = limits.max_daily_volume_usd - state.volume_today_usd
    if remaining_daily <= 0:
        return RiskCheckResult(
            False, f"дневной лимит объёма ${limits.max_daily_volume_usd:.0f} исчерпан"
        )

    current_position = state.open_position_usd.get(market_id, 0.0)
    remaining_position_room = limits.max_position_usd - current_position
    if remaining_position_room <= 0:
        return RiskCheckResult(
            False,
            f"лимит позиции по рынку {market_id} (${limits.max_position_usd:.0f}) исчерпан",
        )

    allowed_size = min(requested_usd, remaining_daily, remaining_position_room)
    if allowed_size < requested_usd:
        return RiskCheckResult(
            True, "размер урезан под оставшийся лимит", capped_size_usd=allowed_size
        )

    return RiskCheckResult(
        True, "в пределах всех лимитов", capped_size_usd=requested_usd
    )


def record_executed(
    state: UserRiskState,
    market_id: int,
    executed_usd: float,
    is_reduce_only: bool = False,
):
    state.volume_today_usd += executed_usd
    current = state.open_position_usd.get(market_id, 0.0)
    if is_reduce_only:
        state.open_position_usd[market_id] = max(0.0, current - executed_usd)
    else:
        state.open_position_usd[market_id] = current + executed_usd
