"""
[!]   НЕ тестировалось мной — реальный вызов LLM API требует сети, которой нет
в этой песочнице (проверено многократно за этот разговор). Написано аккуратно,
тем же стилем, что и протестированный код, но статус честно другой.

Дизайн осознанно defensive: если вызов LLM падает, недоступен, или не настроен
(нет API-ключа) — функция ПАДАЕТ НАЗАД на протестированный rule_based_decision(),
а не оставляет агента без решения и не притворяется, что LLM ответил. Торговый
агент без работающего fallback на реальных деньгах — плохая идея.
"""

import json
import math
from agent_memory import AgentMemoryStore
from agent_decision import AgentDecision, rule_based_decision
from config import ANTHROPIC_API_KEY

# Потолок заимствуется из логики лимитов, а не из фантазии: больше этого риска
# check_order() не пропускает ни при каком ответе модели, и молча обрезанный
# ответ хуже ответа, где потолок назван в том же месте, где он задан.
MAX_LLM_SIZE_USD = 1_000_000

SYSTEM_PROMPT = """Ты — торговый агент на Wake (терминал поверх Lighter perp DEX).
Тебе дают сводку истории сделок и текущие цены. Отвечай ТОЛЬКО JSON без
markdown-обёртки: {"action": "long"|"short"|"hold"|"close", "confidence": 0-1,
"size_usd": число, "reasoning": "кратко почему"}.
Будь консервативен: при неуверенности выбирай "hold". Учитывай винрейт из
истории — плохая история на этом рынке должна снижать твою уверенность."""


def llm_decision(
    memory: AgentMemoryStore,
    market_id: int,
    recent_prices: list,
    base_size_usd: float = 100,
) -> AgentDecision:
    fallback = rule_based_decision(memory, market_id, recent_prices, base_size_usd)

    if not ANTHROPIC_API_KEY:
        return AgentDecision(
            fallback.action,
            fallback.confidence,
            fallback.size_usd,
            f"[fallback: ANTHROPIC_API_KEY не задан] {fallback.reasoning}",
        )

    try:
        import urllib.request
        import urllib.error

        summary = memory.summarize_for_reasoning(market_id)
        user_message = (
            f"Рынок {market_id}. Последние цены: {recent_prices}. "
            f"История:\n{summary}\nБазовый размер: ${base_size_usd}. Твоё решение?"
        )
        payload = json.dumps(
            {
                "model": "claude-sonnet-4-6",
                "max_tokens": 300,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_message}],
            }
        ).encode()

        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())

        text = data["content"][0]["text"].strip()
        parsed = json.loads(text)

        action = parsed.get("action")
        if action not in ("long", "short", "hold", "close"):
            raise ValueError(f"LLM вернул недопустимый action: {action}")

        # Числа из ответа модели не проходят в денежный путь как есть. size_usd
        # попадает в risk_limits.check_order(), а NaN обходит там все сравнения с
        # лимитами (любое сравнение с NaN — False) и уходит в ответ: Starlette
        # сериализует JSON с allow_nan=False по RFC 7159, и /agent/step падал 500
        # вместо решения. Не-число или ноль дают size_usd=0, что check_order()
        # честно отклоняет как "размер ордера должен быть положительным" — то
        # есть сломанный ответ модели стоит агенту отсутствия сделки, но не
        # сделки на выдуманную сумму.
        size_usd = _bounded_float(parsed.get("size_usd"), 0.0, 0.0, MAX_LLM_SIZE_USD)
        confidence = _bounded_float(parsed.get("confidence"), 0.5, 0.0, 1.0)

        return AgentDecision(
            action=action,
            confidence=confidence,
            size_usd=size_usd,
            reasoning=f"[LLM] {parsed.get('reasoning', '')}",
        )

    except Exception as e:
        # Любая ошибка — сеть, парсинг, неожиданный формат — падаем на протестированный
        # rule-based, не оставляем агента без решения и не роняем весь процесс.
        return AgentDecision(
            fallback.action,
            fallback.confidence,
            fallback.size_usd,
            f"[fallback: LLM-вызов не удался: {e}] {fallback.reasoning}",
        )


def _bounded_float(value: object, default: float, low: float, high: float) -> float:
    """Число из внешнего ответа, приведённое к конечному и в диапазоне.

    default вместо исключения: отказ здесь означал бы отбросить ВСЁ решение
    модели из-за одного кривого поля, а fallback-ветка и так честнее — она
    подписана в reasoning."""
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    return min(max(v, low), high)
