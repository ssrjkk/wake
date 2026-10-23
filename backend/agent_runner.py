"""
Связывает agent_memory + llm_agent (с fallback на agent_decision) с реальным
исполнением через signing_service.py. Тот же принцип безопасности, что в
leader_listener.py: WAKE_DRY_RUN=true по умолчанию, реальный запрос идёт,
только если это осознанно выключено.

[!]  Сам HTTP-вызов к signing_service не тестировался мной (нужен реально
поднятый FastAPI-сервис). Логика принятия решения — да, целиком, через
agent_memory.py (14 тестов) и agent_decision.py (11 тестов).
"""

import uuid
import dataclasses
import logging
import urllib.request
import json

from agent_memory import AgentMemoryStore, TradeRecord
from config import DRY_RUN, SIGNING_SERVICE_URL
from llm_agent import llm_decision
from quant import scale_to_int
from risk_limits import RiskLimits, UserRiskState, check_order, record_executed

logger = logging.getLogger("wake.agent")


def _client_order_index(trade_uid: str) -> int:
    """Уникальный на каждую замысел индекс ордера, выводимый из id сделки.

    Прежний `int(time.time() * 1000) % 1_000_000` повторяется каждые ~16,7
    минуты и совпадает у двух запросов в одну миллисекунду. signing_service
    держит idempotency-кэш на этом индексе (час), поэтому второй ордер молча
    считался повтором первого: пользователь получал tx_hash прошлой сделки, а
    нового ордера в Lighter не было.
    """
    return int(uuid.UUID(trade_uid).int % 2**31)


def _place_order_via_signing_service(
    market_index: int,
    base_amount: int,
    price: int,
    is_ask: bool,
    client_order_index: int,
    reduce_only: bool = False,
) -> dict:
    payload = json.dumps(
        {
            "market_index": market_index,
            "client_order_index": client_order_index,
            "base_amount": base_amount,
            "price": price,
            "is_ask": is_ask,
            "reduce_only": reduce_only,
        }
    ).encode()
    req = urllib.request.Request(
        f"{SIGNING_SERVICE_URL}/place-order",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def run_agent_step(
    memory: AgentMemoryStore,
    market_id: int,
    recent_prices: list,
    size_decimals: int,
    price_decimals: int,
    base_size_usd: float = 100,
    risk_limits: RiskLimits | None = None,
    risk_state: UserRiskState | None = None,
):
    """Один шаг: посчитать решение, ПРОВЕРИТЬ ЛИМИТЫ, записать в память, и если
    не dry-run — реально попытаться исполнить через signing_service. Возвращает
    (decision, execution_result). risk_limits/risk_state — если не переданы,
    используются дефолтные RiskLimits() и разовое пустое состояние (то есть
    лимиты всё равно применяются, просто без памяти между вызовами — передавай
    их из вызывающего кода, чтобы дневной объём реально накапливался)."""
    risk_limits = risk_limits or RiskLimits()
    risk_state = risk_state or UserRiskState(user_id="unknown")

    decision = llm_decision(memory, market_id, recent_prices, base_size_usd)
    price = recent_prices[-1]

    logger.info(
        f"{decision.action} confidence={decision.confidence:.2f} size=${decision.size_usd:.0f} — {decision.reasoning}"
    )

    if decision.action == "hold":
        return decision, None

    is_reduce = decision.action == "close"

    # "close" без открытой позиции по этому рынку — не сделка, а пустой reduce_only
    # ордер (биржа его отклонит), и тем более не закрытие чужой позиции.
    closing: TradeRecord | None = None
    if is_reduce:
        open_here = memory.open_trades(market_id)
        if not open_here:
            return decision, {
                "status": "skipped",
                "reason": "по этому рынку нет открытой позиции",
            }
        closing = open_here[0]

    # size_usd у "close" равен 0 — берём стоимость реальной открытой позиции, иначе
    # лимиты и учёт объёма считаются по нулю, а ордер выйдет нулевым по размеру.
    trade_size_usd = decision.size_usd or (
        closing.size * price if closing else base_size_usd
    )

    risk_check = check_order(
        risk_limits, risk_state, market_id, trade_size_usd, is_reduce_only=is_reduce
    )
    if not risk_check.allowed:
        logger.warning("ЗАБЛОКИРОВАНО лимитом риска: %s", risk_check.reason)
        return decision, {
            "status": "blocked_by_risk_limit",
            "reason": risk_check.reason,
        }
    capped = min(trade_size_usd, risk_check.capped_size_usd)
    if capped != trade_size_usd:
        logger.info("размер урезан лимитом: $%.0f -> $%.0f", trade_size_usd, capped)
    decision = dataclasses.replace(decision, size_usd=capped)

    # Один id на замысел: он попадает и в память, и в client_order_index, так
    # что строка agent_trades и ордер в Lighter описывают одно и то же.
    trade_uid = str(uuid.uuid4())

    if DRY_RUN:
        logger.info("DRY_RUN=true — не исполняю реально")
        _apply_to_memory(memory, decision, market_id, price, closing, trade_uid)
        record_executed(risk_state, market_id, capped, is_reduce_only=is_reduce)
        return decision, {"status": "dry_run"}

    try:
        # Закрытие — тем объёмом, что реально открыт, и только в обратную сторону.
        # scale_to_int, а не int(): на float-арифметике int(0.29 * 10**2) = 28, и
        # ордер уходил на шаг меньше посчитанного; для цены то же самое означало
        # лимитку не на том порядке величины.
        base_amount = scale_to_int(
            closing.size if closing else capped / price, size_decimals
        )
        price_int = scale_to_int(price, price_decimals)
        is_ask = decision.action == "short" or (
            closing is not None and closing.side == "long"
        )
        result = _place_order_via_signing_service(
            market_id,
            base_amount,
            price_int,
            is_ask,
            _client_order_index(trade_uid),
            reduce_only=is_reduce,
        )
        if result.get("dry_run") or result.get("tx_hash") is None:
            # Сервис подписи сам в сухом режиме: ордера нет, но ответ есть.
            # Записать сделку в память в этом случае — значит научить агента
            # позиции, которой не существует, и показать «sent» пользователю.
            _apply_to_memory(memory, decision, market_id, price, closing, trade_uid)
            record_executed(risk_state, market_id, capped, is_reduce_only=is_reduce)
            return decision, {"status": "dry_run", **result}
        _apply_to_memory(memory, decision, market_id, price, closing, trade_uid)
        record_executed(risk_state, market_id, capped, is_reduce_only=is_reduce)
        return decision, {"status": "sent", **result}
    except Exception as e:
        logger.error("исполнение не удалось: %s", e)
        return decision, {"status": "failed", "error": str(e)}


def _apply_to_memory(
    memory: AgentMemoryStore,
    decision,
    market_id: int,
    price: float,
    closing: TradeRecord | None,
    trade_uid: str,
) -> None:
    """Память должна отражать и входы, и выходы: без record_close закрытых сделок
    и win_rate в ней не появляется никогда."""
    if decision.action in ("long", "short"):
        memory.record_open(
            trade_uid,
            market_id,
            decision.action,
            price,
            decision.size_usd / price,
            context_note=decision.reasoning,
        )
    elif decision.action == "close" and closing is not None:
        memory.record_close(closing.id, price)
