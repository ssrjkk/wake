"""
Правило-базированный движок решений — детерминированный, полностью тестируемый
baseline. НЕ претендует быть "умным ИИ" — это то, что можно доверять по
построению, и одновременно sanity-check для LLM-версии (llm_agent.py): если
LLM предлагает что-то радикально другое без объяснимой причины, это сигнал
насторожиться, а не просто исполнить.

Momentum-эвристика с учётом истории побед на конкретном рынке из agent_memory.py:
хуже winrate на этом рынке -> меньше размер позиции, не полный запрет.
"""

from dataclasses import dataclass
from agent_memory import AgentMemoryStore

MOMENTUM_THRESHOLD = 0.005  # 0.5% — ниже считаем шумом, не сигналом


@dataclass(frozen=True)
class AgentDecision:
    action: str  # "long" | "short" | "hold" | "close"
    confidence: float  # 0..1
    size_usd: float
    reasoning: str


def rule_based_decision(
    memory: AgentMemoryStore,
    market_id: int,
    recent_prices: list,
    base_size_usd: float = 100,
) -> AgentDecision:
    if len(recent_prices) < 2:
        return AgentDecision("hold", 0.0, 0.0, "недостаточно данных о цене для решения")

    momentum = (recent_prices[-1] - recent_prices[0]) / recent_prices[0]
    open_positions = memory.open_trades(market_id)

    if abs(momentum) < MOMENTUM_THRESHOLD:
        if open_positions:
            return AgentDecision(
                "hold",
                0.2,
                0.0,
                f"momentum {momentum:.2%} слабый — держим открытую позицию без изменений",
            )
        return AgentDecision(
            "hold",
            0.0,
            0.0,
            f"momentum {momentum:.2%} ниже порога {MOMENTUM_THRESHOLD:.2%} — сигнала нет",
        )

    direction = "long" if momentum > 0 else "short"
    confidence = min(abs(momentum) / (MOMENTUM_THRESHOLD * 4), 1.0)

    if open_positions:
        current_side = open_positions[0].side
        if current_side == direction:
            return AgentDecision(
                "hold",
                confidence,
                0.0,
                f"уже в {direction}, момент {momentum:.2%} подтверждает — держим",
            )
        return AgentDecision(
            "close",
            confidence,
            0.0,
            f"момент {momentum:.2%} развернулся против открытой {current_side}-позиции",
        )

    win_rate = memory.win_rate(market_id)
    # win_rate=None (нет истории) -> множитель 1.0 (нейтрально), win_rate=0 -> 0.5x, win_rate=1 -> 1.5x.
    # Плохая история уменьшает размер, а не блокирует сделку целиком — это осознанный выбор,
    # не единственно верный, но задокументированный.
    confidence_multiplier = 0.5 + win_rate if win_rate is not None else 1.0
    size = base_size_usd * confidence_multiplier

    return AgentDecision(
        direction,
        confidence,
        size,
        f"momentum {momentum:.2%}, winrate {'н/д' if win_rate is None else f'{win_rate:.0%}'} на этом рынке -> size ${size:.0f}",
    )
