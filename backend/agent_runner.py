"""
Связывает agent_memory + llm_agent (с fallback на agent_decision) с реальным
исполнением через signing_service.py. Тот же принцип безопасности, что в
leader_listener.py: WAKE_DRY_RUN=true по умолчанию, реальный запрос идёт,
только если это осознанно выключено.

Три исхода живого шага различаются намеренно: "sent" (сервис ответил),
"failed" (отказ с ответом или запрос, который заведомо никуда не дошёл) и
"unknown" (соединвание оборвалось после того, как запрос мог дойти). "failed"
означает «можно повторять», "unknown" — нет: повтор идёт с новым
client_order_index, то есть вторым ордером, если первый всё-таки исполнился.

Что покрыто тестами: выбор решения (agent_memory, agent_decision, fallback-
ветка llm_agent), границы лимитов, учёт памяти и весь HTTP-путь к
signing_service — включая оборванное соединение — через подмену urlopen в
test_agent_execution.py. Реального Lighter эти тесты не касают: они заканчивают
на адресе сервиса подписи.
"""

import http.client
import json
import logging
import socket
import urllib.error
import urllib.request
import uuid
import dataclasses

from agent_memory import AgentMemoryStore, TradeRecord
from config import DRY_RUN, SIGNING_SERVICE_URL
from llm_agent import llm_decision
from quant import scale_to_int
from risk_limits import RiskLimits, UserRiskState, check_order, record_executed

logger = logging.getLogger("wake.agent")

# Разумный потолок на ожидание ответа сервиса подписи. Больше 30 секунд — это не
# «медленно», это состояние, в котором ордер мог быть уже отправлен, а ответ не
# пришёл никогда; для такого случая есть "unknown", а не терпение.
ORDER_REQUEST_TIMEOUT_S = 30

# Заметка модели уходит в agent_trades и оттуда — в промпт каждого следующего
# шага (summarize_for_reasoning). Без потолка один длинный или нарочно
# сконструированный ответ разрастается и в строке базы, и в токене рассуждения.
MAX_CONTEXT_NOTE_CHARS = 500

# Ошибки, которые доказывают, что запрос не был передан в сеть: соединение не
# установлено, адрес не разрешился. После них ордер точно нигде не появился.
_NOT_SENT_ERRORS = (
    ConnectionRefusedError,
    socket.gaierror,
    socket.herror,
    FileNotFoundError,
    PermissionError,
)


class SubmissionUnconfirmed(Exception):
    """Запрос ушёл в сервис подписи, а ответа нет. Повторять его безопасно
    только с тем же client_order_index."""


def _request_never_left(exc: BaseException) -> bool:
    reason = getattr(exc, "reason", exc)
    return isinstance(reason, _NOT_SENT_ERRORS)


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
    """Один запрос к сервису подписи.

    HTTPError (отказ с ответом) уходит наружу как есть: исход известен. Всё, что
    случилось ПОСЛЕ передачи тела — таймаут чтения, обрыв, неразобранный JSON, —
    превращается в SubmissionUnconfirmed: ордер мог исполниться, и это не
    «отказ»."""
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
    try:
        with urllib.request.urlopen(req, timeout=ORDER_REQUEST_TIMEOUT_S) as resp:
            body = resp.read()
    except urllib.error.HTTPError:
        raise
    except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
        if _request_never_left(e):
            raise
        raise SubmissionUnconfirmed(str(e) or type(e).__name__) from e
    try:
        return json.loads(body.decode())
    except (ValueError, UnicodeDecodeError) as e:
        raise SubmissionUnconfirmed(f"ответ сервиса не разобран: {e}") from e


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

    # size_usd у "close" равен 0 по построению — берём стоимость реальной открытой
    # позиции, иначе лимиты и учёт объёма считаются по нулю, а ордер выйдет
    # нулевым по размеру. Для "long"/"short" ноль — это НЕ «базовый размер»:
    # подставлять base_size_usd сюда значит открыть сделку на сумму, которую
    # источник решения не называл. Мусорный ответ модели (size_usd=0 при
    # валидном action) ровно так и превращался в $100, которых модель не просила;
    # честный ответ здесь — отклонение в check_order().
    trade_size_usd = closing.size * price if is_reduce else decision.size_usd

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
    order_index = _client_order_index(trade_uid)

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
            order_index,
            reduce_only=is_reduce,
        )
        # Сервис подписи может сам быть в сухом режиме: ордера на рынке нет, но
        # ответ есть. Сделка в память попадает и так — тот же договор, что у
        # верхнего DRY_RUN: память агента описывает его решения, а status строки
        # в agent_trades отличает симуляцию от живого ордера (см. Agent.tsx).
        status = (
            "dry_run"
            if (result.get("dry_run") or result.get("tx_hash") is None)
            else "sent"
        )
        _apply_to_memory(memory, decision, market_id, price, closing, trade_uid)
        record_executed(risk_state, market_id, capped, is_reduce_only=is_reduce)
        return decision, {"status": status, **result}
    except SubmissionUnconfirmed as e:
        # Память и дневной объём НЕ пополняются: позиции, про которую неизвестно,
        # в них не было бы. Но и "failed" здесь соврёт: повтор шага — это новый
        # client_order_index, то есть второй ордер, если первый исполнился.
        logger.error("исполнение не подтверждено: %s", e)
        return decision, {
            "status": "unknown",
            "reason": (
                f"сервис подписи не дал ответа ({e}). Ордер мог исполниться: "
                "проверь позицию в Lighter, повтор шага откроет вторую сделку"
            ),
            "client_order_index": order_index,
        }
    except urllib.error.HTTPError as e:
        # Тело ответа signing_service — это причина отказа Lighter ("Minimal price
        # difference exceeded", "insufficient margin" и т.п.). Без него в UI и в
        # памяти оставалось бесполезное "HTTP Error 400: Bad Request", и человек
        # не мог понять, что ему исправить.
        body = ""
        try:
            body = e.read().decode(errors="replace")[:300]
        except Exception:  # noqa: BLE001 — тело ответа не важнее самого отказа
            pass
        logger.error("исполнение не удалось: HTTP %s %s", e.code, body or e.reason)
        return decision, {
            "status": "failed",
            "error": body or f"HTTP {e.code}",
        }
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
            context_note=decision.reasoning[:MAX_CONTEXT_NOTE_CHARS],
        )
    elif decision.action == "close" and closing is not None:
        memory.record_close(closing.id, price)
