"""
Тесты для llm_agent.py — LLM-интеграция с fallback на rule-based.

Проверяем три пути:
1. Нет API-ключа → немедленный fallback на rule-based
2. LLM-вызов падает (сеть, парсинг) → fallback на rule-based
3. LLM отвечает корректно → парсим и возвращаем его решение

Сеть мокаем через unittest.mock.patch, чтобы тесты работали без интернета.
"""

import json
import unittest
from unittest.mock import patch, MagicMock

import llm_agent
from llm_agent import llm_decision, _bounded_float
from agent_memory import AgentMemoryStore
from agent_decision import rule_based_decision


class TestLLMAgent(unittest.TestCase):
    def setUp(self):
        # Выключатель — состояние модуля, и тесты этого класса роняют LLM-вызов
        # намеренно. Без сброса следующий тест получил бы «LLM на паузе» вместо
        # проверяемого отказа и зелёным стал бы за прошлую ошибку.
        llm_agent.reset_circuit()
        self.addCleanup(llm_agent.reset_circuit)
        self.memory = AgentMemoryStore()
        self.market_id = 1
        self.recent_prices = [50000.0, 50100.0, 50200.0, 50150.0, 50300.0]
        self.base_size_usd = 100.0

    def test_fallback_when_no_api_key(self):
        """Нет ANTHROPIC_API_KEY → немедленный fallback на rule-based."""
        with patch("llm_agent.ANTHROPIC_API_KEY", None):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        expected = rule_based_decision(
            self.memory, self.market_id, self.recent_prices, self.base_size_usd
        )

        self.assertEqual(decision.action, expected.action)
        self.assertEqual(decision.confidence, expected.confidence)
        self.assertEqual(decision.size_usd, expected.size_usd)
        self.assertIn("fallback: ANTHROPIC_API_KEY не задан", decision.reasoning)

    def test_fallback_on_network_error(self):
        """Сетевая ошибка → fallback на rule-based."""
        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", side_effect=Exception("Network error")),
        ):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        expected = rule_based_decision(
            self.memory, self.market_id, self.recent_prices, self.base_size_usd
        )

        self.assertEqual(decision.action, expected.action)
        self.assertEqual(decision.confidence, expected.confidence)
        self.assertEqual(decision.size_usd, expected.size_usd)
        self.assertIn("fallback: LLM-вызов не удался", decision.reasoning)
        self.assertIn("Network error", decision.reasoning)

    def test_fallback_on_invalid_json(self):
        """LLM вернул не-JSON → fallback на rule-based."""
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"content": [{"text": "not json"}]}'
        mock_response.__enter__ = lambda s: s

        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", return_value=mock_response),
        ):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        expected = rule_based_decision(
            self.memory, self.market_id, self.recent_prices, self.base_size_usd
        )

        self.assertEqual(decision.action, expected.action)
        self.assertIn("fallback: LLM-вызов не удался", decision.reasoning)

    def test_fallback_on_invalid_action(self):
        """LLM вернул недопустимый action → fallback на rule-based."""
        llm_response = {
            "action": "invalid_action",
            "confidence": 0.8,
            "size_usd": 150,
            "reasoning": "test",
        }
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(
            {"content": [{"text": json.dumps(llm_response)}]}
        ).encode()
        mock_response.__enter__ = lambda s: s

        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", return_value=mock_response),
        ):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        expected = rule_based_decision(
            self.memory, self.market_id, self.recent_prices, self.base_size_usd
        )

        self.assertEqual(decision.action, expected.action)
        self.assertIn("fallback: LLM-вызов не удался", decision.reasoning)

    def test_successful_llm_response(self):
        """LLM ответил корректно → используем его решение."""
        llm_response = {
            "action": "long",
            "confidence": 0.75,
            "size_usd": 150.0,
            "reasoning": "Тренд восходящий, винрейт хороший",
        }
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(
            {"content": [{"text": json.dumps(llm_response)}]}
        ).encode()
        mock_response.__enter__ = lambda s: s

        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", return_value=mock_response),
        ):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        self.assertEqual(decision.action, "long")
        self.assertEqual(decision.confidence, 0.75)
        self.assertEqual(decision.size_usd, 150.0)
        self.assertIn("[LLM]", decision.reasoning)
        self.assertIn("Тренд восходящий", decision.reasoning)

    def test_successful_hold_response(self):
        """LLM решил держать позицию → парсим корректно."""
        llm_response = {
            "action": "hold",
            "confidence": 0.6,
            "size_usd": 0,
            "reasoning": "Недостаточно данных для уверенности",
        }
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps(
            {"content": [{"text": json.dumps(llm_response)}]}
        ).encode()
        mock_response.__enter__ = lambda s: s

        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", return_value=mock_response),
        ):
            decision = llm_decision(
                self.memory, self.market_id, self.recent_prices, self.base_size_usd
            )

        self.assertEqual(decision.action, "hold")
        self.assertEqual(decision.confidence, 0.6)
        self.assertEqual(decision.size_usd, 0.0)
        self.assertIn("[LLM]", decision.reasoning)


class TestCircuitBreaker(unittest.TestCase):
    """Отказ модели не должен стоить каждому следующему шагу полного ожидания.

    Без выключателя агент с неверным ключом платил 15 с на каждом вызове:
    api.anthropic.com отвечает 401 instantly, но urllib держит запрос, а решение
    всё равно принимает правило. Проверка идёт на числе обращений к urlopen, а не
    на тексте: суть выключателя в том, вопроса не было."""

    def setUp(self):
        llm_agent.reset_circuit()
        self.addCleanup(llm_agent.reset_circuit)
        self.memory = AgentMemoryStore()

    def _http_error(self, code: int):
        from urllib.error import HTTPError

        return HTTPError("https://api.anthropic.com", code, "nope", None, None)

    def _step(self, urlopen):
        with (
            patch("llm_agent.ANTHROPIC_API_KEY", "test-key"),
            patch("urllib.request.urlopen", side_effect=urlopen),
        ):
            return llm_agent.llm_decision(self.memory, 1, [50000.0, 50100.0], 100.0)

    def test_rejected_key_pauses_and_stops_asking(self):
        first = self._step(self._http_error(401))
        self.assertIn("LLM-вызов не удался", first.reasoning)

        calls = []
        second = self._step(lambda *a, **k: calls.append(1))
        self.assertIn("LLM на паузе", second.reasoning)
        self.assertEqual(calls, [], "во время паузы спрашивать модель нельзя")
        self.assertGreater(llm_agent._paused_remaining(), 600)

    def test_transient_failure_pauses_shortly(self):
        self._step(TimeoutError("нет ответа"))
        remaining = llm_agent._paused_remaining()
        self.assertGreater(remaining, 30)
        self.assertLessEqual(remaining, llm_agent._PAUSE_TRANSIENT_S)

    def test_reset_clears_the_pause(self):
        self._step(self._http_error(403))
        llm_agent.reset_circuit()
        self.assertEqual(llm_agent._paused_remaining(), 0.0)

    def test_decision_is_the_rule_based_one_during_the_pause(self):
        self._step(self._http_error(401))
        decision = self._step(lambda *a, **k: None)
        expected = rule_based_decision(self.memory, 1, [50000.0, 50100.0], 100.0)
        self.assertEqual(decision.action, expected.action)
        self.assertEqual(decision.size_usd, expected.size_usd)


class TestBoundedNumbers(unittest.TestCase):
    """Числа из внешнего ответа не входят в денежный путь как есть."""

    def test_non_finite_size_falls_back_to_zero(self):
        for bad in (float("nan"), float("inf"), None, "abc", {}):
            with self.subTest(value=bad):
                self.assertEqual(_bounded_float(bad, 0.0, 0.0, 1_000_000), 0.0)

    def test_size_is_clamped_to_ceiling(self):
        self.assertEqual(_bounded_float(1e12, 0.0, 0.0, 1_000.0), 1_000.0)

    def test_negative_size_becomes_zero_not_negative(self):
        self.assertEqual(_bounded_float(-5, 0.0, 0.0, 1_000.0), 0.0)

    def test_confidence_stays_in_unit_interval(self):
        self.assertEqual(_bounded_float(7, 0.5, 0.0, 1.0), 1.0)
        self.assertEqual(_bounded_float(0.42, 0.5, 0.0, 1.0), 0.42)


if __name__ == "__main__":
    unittest.main()
