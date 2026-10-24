"""
Путь исполнения агента: сколько зеркалить, чем отвечать на мусор и что делать,
когда сервис подписи исчез в середине запроса.

python3 -m unittest test_agent_execution -v

Почему отдельный файл, а ещё один класс в test_llm_agent.py: там проверяется
разбор ответа модели, здесь — что происходит с этим ответом в денежном пути.
Сеть не нужна ни там, ни там: urlopen подменяется, и тесты видят ровно те байты,
которые ушли бы в signing_service.

Три утверждения закреплены сознательно, потому что каждое из них было неверным:

  - размер ордера решает источник решения, а не base_size_usd: мусорный ответ
    модели (size_usd=0 при валидном action) подменялся базовым размером и
    превращался в сделку на $100, которых модель не называла;
  - "failed" и "unknown" — разные исходы. "failed" можно повторять, "unknown"
    нет: повтор идёт с новым client_order_index, то есть вторым ордером, если
    первый всё-таки дошёл;
  - закрытие позиции не блокируется лимитами — иначе защита от ущерба мешает
    из ущерба выйти.
"""

import http.client
import io
import json
import socket
import unittest
import urllib.error
import urllib.request
import uuid
from contextlib import ExitStack, contextmanager
from unittest.mock import patch

# Тестовое окружение задаёт testsupport, и он обязан быть импортирован раньше
# config: api.agent тянет за собой agent_db и database, а config читает env один
# раз при импорте. Без этой строки алфавитный порядок сборки (этот файл идёт
# перед test_api_smoke) оставлял тесты входа на фиктивных секретах из backend/.env.
import testsupport  # noqa: E402, F401  (импорт ради порядка env)
import agent_runner  # noqa: E402
from agent_decision import AgentDecision, rule_based_decision  # noqa: E402
from agent_memory import AgentMemoryStore  # noqa: E402
from agent_runner import (  # noqa: E402
    MAX_CONTEXT_NOTE_CHARS,
    SubmissionUnconfirmed,
    _client_order_index,
    run_agent_step,
)
from api.agent import _market_constraints  # noqa: E402
from risk_limits import RiskLimits, UserRiskState  # noqa: E402

BTC = 100_000.0
UP = [BTC, 103_000.0]  # momentum +3% -> long
DOWN = [BTC, 90_000.0]  # momentum -10% -> против открытой long -> close
SIZE_DECIMALS = 5
PRICE_DECIMALS = 2


class Recorder:
    """Фейковый urlopen: помнит ушедшие запросы, отвечает одно из двух."""

    def __init__(self, body=None, error=None):
        self.sent = []
        self._body = body
        self._error = error

    def __call__(self, req, timeout=None):
        self.sent.append(
            {
                "payload": json.loads(req.data.decode()),
                "timeout": timeout,
                "url": req.full_url,
            }
        )
        if self._error is not None:
            raise self._error
        return _Response(self._body)


class _Response:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def ok(tx_hash="0xabc", dry_run=False, **extra):
    return Recorder(
        body=json.dumps({"tx_hash": tx_hash, "dry_run": dry_run, **extra}).encode()
    )


@contextmanager
def signer(*, urlopen=None, decide=rule_based_decision, dry_run=False):
    """Никакой сети и никакого LLM на время шага: решение — детерминированное
    правило, адрес сервиса — фиктивный, urlopen — подменён."""
    with ExitStack() as stack:
        stack.enter_context(patch.object(agent_runner, "DRY_RUN", dry_run))
        stack.enter_context(
            patch.object(agent_runner, "SIGNING_SERVICE_URL", "http://signer.test")
        )
        stack.enter_context(patch.object(agent_runner, "llm_decision", decide))
        if urlopen is not None:
            stack.enter_context(patch("urllib.request.urlopen", urlopen))
        yield


def step(
    memory,
    *,
    prices=UP,
    market_id=4,
    base_size_usd=100,
    limits=None,
    state=None,
):
    return run_agent_step(
        memory,
        market_id,
        prices,
        SIZE_DECIMALS,
        PRICE_DECIMALS,
        base_size_usd,
        limits,
        state if state is not None else UserRiskState(user_id="u"),
    )


class TestDecisionSizeIsAuthoritative(unittest.TestCase):
    """Размер ордера приходит из решения. Всё остальное — домысел."""

    def test_llm_size_of_zero_opens_nothing_at_base_size(self):
        def junk(*args, **kwargs):
            return AgentDecision("long", 0.9, 0.0, "[LLM] мусор")

        memory = AgentMemoryStore()
        state = UserRiskState(user_id="u")
        with signer(decide=junk, dry_run=True):
            decision, execution = step(memory, state=state)
        self.assertEqual(execution["status"], "blocked_by_risk_limit")
        self.assertIn("положительным", execution["reason"])
        self.assertEqual(memory.trades, [], "сделка не должна появиться в памяти")
        self.assertEqual(state.volume_today_usd, 0.0)
        self.assertEqual(state.open_position_usd, {})

    def test_size_above_the_order_limit_is_blocked_not_cut(self):
        """Лимит на транзакцию именно отклоняет: молча урезанный ордер человек
        спутал бы с тем, который он попросил."""

        def big(*args, **kwargs):
            return AgentDecision("long", 0.9, 5_000.0, "[LLM] много")

        memory = AgentMemoryStore()
        with signer(decide=big, dry_run=True):
            _, execution = step(memory, limits=RiskLimits(max_order_usd=500.0))
        self.assertEqual(execution["status"], "blocked_by_risk_limit")
        self.assertIn("превышает лимит", execution["reason"])
        self.assertEqual(memory.trades, [])

    def test_size_above_the_daily_room_is_capped(self):
        """А вот остаток дневного объёма и остаток лимита позиции — урезаются:
        сделка по меньшему размеру честнее отказа, и в ответе это видно."""
        memory = AgentMemoryStore()
        state = UserRiskState(user_id="u", volume_today_usd=1_950.0)
        with signer(dry_run=True):
            decision, execution = step(
                memory,
                limits=RiskLimits(max_order_usd=500.0, max_daily_volume_usd=2_000.0),
                state=state,
            )
        self.assertEqual(execution["status"], "dry_run")
        self.assertEqual(decision.size_usd, 50.0)
        self.assertEqual(state.volume_today_usd, 2_000.0)

    def test_close_is_sized_by_the_real_position(self):
        """size_usd у закрытия равен 0 по построению — размер берётся из открытой
        позиции, иначе ордер выходит нулевым, а лимиты считаются по нулю."""
        memory = AgentMemoryStore()
        memory.record_open("t1", 4, "long", 100_000.0, 3.0)
        with signer(dry_run=True):
            decision, execution = step(memory, prices=DOWN)
        self.assertEqual(decision.action, "close")
        self.assertEqual(decision.size_usd, 3.0 * 90_000.0)
        self.assertEqual(execution["status"], "dry_run")
        self.assertEqual(memory.open_trades(4), [])

    def test_huge_close_is_not_blocked_by_the_order_limit(self):
        """reduce_only проходит поверх max_order_usd: лимит на ущерб не имеет
        права мешать из этого ущерба выйти."""
        memory = AgentMemoryStore()
        memory.record_open("t1", 4, "long", 100_000.0, 3.0)
        limits = RiskLimits(max_order_usd=500.0, max_daily_volume_usd=2_000.0)
        state = UserRiskState(user_id="u")
        recorder = ok()
        with signer(urlopen=recorder):
            _, execution = step(memory, prices=DOWN, limits=limits, state=state)
        self.assertEqual(execution["status"], "sent")
        payload = recorder.sent[0]["payload"]
        self.assertTrue(payload["reduce_only"])
        self.assertTrue(payload["is_ask"], "закрытие лонга — это ask")
        self.assertEqual(payload["base_amount"], 300_000, "3.0 монеты по 1e-5")
        self.assertEqual(payload["price"], 9_000_000)
        self.assertEqual(state.open_position_usd, {4: 0.0})

    def test_reasoning_from_the_model_is_stored_bounded(self):
        """context_note уходит в agent_trades и оттуда — в промпт каждого
        следующего шага, поэтому её длина ограничена на записи."""

        def wordy(*args, **kwargs):
            return AgentDecision("long", 0.9, 100.0, "x" * (MAX_CONTEXT_NOTE_CHARS * 4))

        memory = AgentMemoryStore()
        with signer(decide=wordy, dry_run=True):
            step(memory)
        self.assertEqual(len(memory.trades), 1)
        self.assertEqual(len(memory.trades[0].context_note), MAX_CONTEXT_NOTE_CHARS)

    def test_hold_returns_no_execution_and_leaves_nothing_pending(self):
        """api/agent.py читает execution["status"] только когда в памяти есть
        незаписанное. hold отвечает execution=None — значит таких пар
        (нет исполнения, есть запись) существовать не должно, иначе обработчик
        упадёт на None при полностью честном ответе правила."""
        memory = AgentMemoryStore()
        recorder = ok()
        with signer(urlopen=recorder):
            decision, execution = step(memory, prices=[100_000.0, 100_000.0])
        self.assertEqual(decision.action, "hold")
        self.assertIsNone(execution)
        self.assertEqual(recorder.sent, [])
        self.assertEqual(memory.trades, [], "hold ничего не записывает")

    def test_close_without_a_position_is_skipped(self):
        """Правило само по себе не предлагает close без позиции, поэтому решение
        подставляется: проверка в том, что пустой close не уходит на биржу
        reduce-only ордером и не закрывает чужую позицию."""

        def close(*args, **kwargs):
            return AgentDecision("close", 0.9, 0.0, "правило")

        recorder = ok()
        memory = AgentMemoryStore()
        with signer(urlopen=recorder, decide=close):
            _, execution = step(memory)
        self.assertEqual(execution["status"], "skipped")
        self.assertIn("нет открытой позиции", execution["reason"])
        self.assertEqual(recorder.sent, [], "ни одного запроса в сервис подписи")
        self.assertEqual(memory.trades, [])


class TestSubmissionOutcomes(unittest.TestCase):
    """Ответил / не ответил / ответил невнятно — три разных ответа, и только
    первый означает «можно повторять»."""

    def test_sent_carries_market_scaled_numbers_and_charges_state(self):
        recorder = ok()
        memory = AgentMemoryStore()
        state = UserRiskState(user_id="u")
        with signer(urlopen=recorder):
            _, execution = step(memory, state=state)
        payload = recorder.sent[0]["payload"]
        self.assertEqual(
            payload,
            {
                # 100$ по 103000 = 0.00097087… монеты -> 97 тиков по 1e-5;
                # цена 103000 * 10**2 тиков. Ближайший тик, не int().
                "market_index": 4,
                "base_amount": 97,
                "price": 10_300_000,
                "is_ask": False,
                "reduce_only": False,
                "client_order_index": payload["client_order_index"],
            },
        )
        self.assertEqual(recorder.sent[0]["url"], "http://signer.test/place-order")
        self.assertEqual(
            recorder.sent[0]["timeout"], agent_runner.ORDER_REQUEST_TIMEOUT_S
        )
        self.assertEqual(execution["status"], "sent")
        self.assertEqual(execution["tx_hash"], "0xabc")
        self.assertEqual(len(memory.trades), 1)
        self.assertEqual(state.volume_today_usd, 100.0)
        self.assertEqual(state.open_position_usd, {4: 100.0})

    def test_short_is_ask_and_long_is_bid(self):
        def short(*args, **kwargs):
            return AgentDecision("short", 0.9, 100.0, "правило")

        recorder = ok()
        with signer(urlopen=recorder, decide=short):
            step(AgentMemoryStore())
        self.assertTrue(recorder.sent[0]["payload"]["is_ask"])

    def test_service_in_dry_mode_reports_dry_not_sent(self):
        recorder = ok(tx_hash=None, dry_run=True)
        memory = AgentMemoryStore()
        with signer(urlopen=recorder):
            _, execution = step(memory)
        self.assertEqual(execution["status"], "dry_run")
        self.assertEqual(len(memory.trades), 1, "симуляция тоже сделка агента")

    def test_answer_without_tx_hash_is_not_a_filled_order(self):
        recorder = Recorder(body=json.dumps({"dry_run": False}).encode())
        with signer(urlopen=recorder):
            _, execution = step(AgentMemoryStore())
        self.assertEqual(execution["status"], "dry_run")

    def test_rejection_keeps_the_service_body_as_the_reason(self):
        """Тело ответа signing_service — это причина отказа Lighter. Без него в
        UI остаётся "HTTP Error 400: Bad Request", и человеку не на чем решить,
        что исправлять."""
        error = urllib.error.HTTPError(
            "http://signer.test/place-order",
            400,
            "Bad Request",
            None,
            io.BytesIO(b'{"detail":"Lighter: insufficient margin"}'),
        )
        recorder = Recorder(error=error)
        memory = AgentMemoryStore()
        state = UserRiskState(user_id="u")
        with signer(urlopen=recorder):
            _, execution = step(memory, state=state)
        self.assertEqual(execution["status"], "failed")
        self.assertIn("insufficient margin", execution["error"])
        self.assertEqual(memory.trades, [], "отклонённый ордер не позиция")
        self.assertEqual(state.volume_today_usd, 0.0)

    def test_connection_refused_is_a_plain_failure(self):
        """Соединение не установлено — запрос не дошёл, повторять можно."""
        recorder = Recorder(
            error=urllib.error.URLError(ConnectionRefusedError(111, "refused"))
        )
        memory = AgentMemoryStore()
        with signer(urlopen=recorder):
            _, execution = step(memory)
        self.assertEqual(execution["status"], "failed")
        self.assertNotIn("client_order_index", execution)
        self.assertEqual(memory.trades, [])

    def test_dns_failure_is_a_plain_failure(self):
        recorder = Recorder(
            error=urllib.error.URLError(socket.gaierror(-2, "name not known"))
        )
        with signer(urlopen=recorder):
            _, execution = step(AgentMemoryStore())
        self.assertEqual(execution["status"], "failed")

    def test_timeout_after_send_is_unknown_not_failed(self):
        """Ключевое различие: оборванное после отправки соединение не даёт права
        сказать «не исполнилось»."""
        recorder = Recorder(error=socket.timeout("The read operation timed out"))
        memory = AgentMemoryStore()
        state = UserRiskState(user_id="u")
        with signer(urlopen=recorder):
            _, execution = step(memory, state=state)
        self.assertEqual(execution["status"], "unknown")
        self.assertIn("мог исполниться", execution["reason"])
        self.assertEqual(
            execution["client_order_index"],
            recorder.sent[0]["payload"]["client_order_index"],
        )
        self.assertEqual(memory.trades, [], "неизвестное не записывается позицией")
        self.assertEqual(state.volume_today_usd, 0.0)
        self.assertEqual(state.open_position_usd, {})

    def test_unparsable_answer_is_unknown_too(self):
        recorder = Recorder(body=b"signer said what")
        memory = AgentMemoryStore()
        with signer(urlopen=recorder):
            _, execution = step(memory)
        self.assertEqual(execution["status"], "unknown")
        self.assertEqual(memory.trades, [])

    def test_remote_disconnect_is_unknown_too(self):
        recorder = Recorder(error=http.client.RemoteDisconnected("closed"))
        with signer(urlopen=recorder):
            _, execution = step(AgentMemoryStore())
        self.assertEqual(execution["status"], "unknown")

    def test_unconfirmed_never_escapes_the_step(self):
        """Исключение-маркер остаётся внутренним: наружу уходит статус."""
        with self.assertRaises(SubmissionUnconfirmed):
            with signer(urlopen=Recorder(error=socket.timeout("t"))):
                agent_runner._place_order_via_signing_service(1, 1, 1, False, 1)
        with signer(urlopen=Recorder(error=socket.timeout("t"))):
            _, execution = step(AgentMemoryStore())
        self.assertEqual(execution["status"], "unknown")


class TestClientOrderIndex(unittest.TestCase):
    def test_stable_in_range_and_unique_per_intent(self):
        uid = str(uuid.uuid4())
        self.assertEqual(_client_order_index(uid), _client_order_index(uid))
        self.assertNotEqual(
            _client_order_index(uid), _client_order_index(str(uuid.uuid4()))
        )
        value = _client_order_index(uid)
        self.assertGreaterEqual(value, 0)
        self.assertLess(value, 2**31)

    def test_two_intents_in_the_same_millisecond_do_not_collide(self):
        """Прежний int(time.time()*1000) % 1e6 совпадал у двух запросов в одну
        миллисекунду, а сервис подписи помнит индекс час."""
        indices = {_client_order_index(str(uuid.uuid4())) for _ in range(500)}
        self.assertEqual(len(indices), 500)


class TestMarketConstraintsBoundary(unittest.TestCase):
    """api/agent.py берёт шаг рынка из живого ответа Lighter. Пассивный рынок,
    рынок без полей и отсутствие рынка должны отвечать разными кодами, а не
    KeyError наружу."""

    def constraints(self, *books):
        with patch("api.agent.lighter_rest.get_order_books", return_value=list(books)):
            return _market_constraints(7)

    def test_active_market_without_decimals_is_a_clean_502(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            self.constraints(
                {
                    "market_id": "7",
                    "status": "active",
                    "symbol": "BTC",
                    "supported_size_decimals": 5,
                }
            )
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertEqual(ctx.exception.detail["error"]["code"], "MARKET_DATA_UNUSABLE")

    def test_inactive_market_is_409(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            self.constraints({"market_id": 7, "status": "closed"})
        self.assertEqual(ctx.exception.status_code, 409)

    def test_unknown_market_is_404(self):
        from fastapi import HTTPException

        with self.assertRaises(HTTPException) as ctx:
            self.constraints(
                {
                    "market_id": 8,
                    "status": "active",
                    "supported_size_decimals": 5,
                    "supported_price_decimals": 2,
                }
            )
        self.assertEqual(ctx.exception.status_code, 404)

    def test_well_formed_book_returns_both_steps(self):
        got = self.constraints(
            {
                "market_id": "7",
                "status": "active",
                "symbol": "BTC",
                "supported_size_decimals": "5",
                "supported_price_decimals": 2,
            }
        )
        self.assertEqual(
            got, {"size_decimals": 5, "price_decimals": 2, "symbol": "BTC"}
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
