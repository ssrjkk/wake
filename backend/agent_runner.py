"""
Связывает agent_memory + llm_agent (с fallback на agent_decision) с реальным
исполнением через signing_service.py. Тот же принцип безопасности, что в
leader_listener.py: WAKE_DRY_RUN=true по умолчанию, реальный запрос идёт,
только если это осознанно выключено.

[!]  Сам HTTP-вызов к signing_service не тестировался мной (нужен реально
поднятый FastAPI-сервис). Логика принятия решения — да, целиком, через
agent_memory.py (14 тестов) и agent_decision.py (11 тестов).
"""

import os
import time
import uuid
import dataclasses
import urllib.request
import urllib.error
import json

from agent_memory import AgentMemoryStore
from llm_agent import llm_decision
from risk_limits import RiskLimits, UserRiskState, check_order, record_executed

DRY_RUN = os.environ.get("WAKE_DRY_RUN", "true").lower() != "false"
SIGNING_SERVICE_URL = os.environ.get("WAKE_SIGNING_SERVICE_URL", "http://localhost:8787")


def _place_order_via_signing_service(market_index: int, base_amount: int, price: int, is_ask: bool) -> dict:
    payload = json.dumps({
        "market_index": market_index,
        "client_order_index": int(time.time() * 1000) % 1_000_000,
        "base_amount": base_amount,
        "price": price,
        "is_ask": is_ask,
        "reduce_only": False,
    }).encode()
    req = urllib.request.Request(
        f"{SIGNING_SERVICE_URL}/place-order", data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def run_agent_step(memory: AgentMemoryStore, market_id: int, recent_prices: list,
                    size_decimals: int, price_decimals: int, base_size_usd: float = 100,
                    risk_limits: RiskLimits | None = None, risk_state: UserRiskState | None = None):
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

    print(f"[agent] {decision.action} confidence={decision.confidence:.2f} size=${decision.size_usd:.0f} — {decision.reasoning}")

    if decision.action == "hold":
        return decision, None

    is_reduce = decision.action == "close"
    risk_check = check_order(risk_limits, risk_state, market_id, decision.size_usd or base_size_usd, is_reduce_only=is_reduce)
    if not risk_check.allowed:
        print(f"[agent] ЗАБЛОКИРОВАНО лимитом риска: {risk_check.reason}")
        return decision, {"status": "blocked_by_risk_limit", "reason": risk_check.reason}
    if risk_check.capped_size_usd != decision.size_usd:
        print(f"[agent] размер урезан лимитом: ${decision.size_usd:.0f} -> ${risk_check.capped_size_usd:.0f}")
        decision = dataclasses.replace(decision, size_usd=risk_check.capped_size_usd)

    if DRY_RUN:
        print("[agent] DRY_RUN=true — не исполняю реально")
        if decision.action in ("long", "short"):
            memory.record_open(str(uuid.uuid4()), market_id, decision.action, price,
                                decision.size_usd / price, context_note=decision.reasoning)
        record_executed(risk_state, market_id, decision.size_usd, is_reduce_only=is_reduce)
        return decision, {"status": "dry_run"}

    try:
        base_amount = int((decision.size_usd / price) * 10 ** size_decimals)
        price_int = int(price * 10 ** price_decimals)
        is_ask = decision.action == "short"
        result = _place_order_via_signing_service(market_id, base_amount, price_int, is_ask)
        if decision.action in ("long", "short"):
            memory.record_open(str(uuid.uuid4()), market_id, decision.action, price,
                                decision.size_usd / price, context_note=decision.reasoning)
        return decision, {"status": "sent", **result}
    except (urllib.error.URLError, Exception) as e:
        print(f"[agent] исполнение не удалось: {e}")
        return decision, {"status": "failed", "error": str(e)}
