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

from llm_agent import llm_decision
from agent_memory import AgentMemoryStore
from agent_decision import rule_based_decision


class TestLLMAgent(unittest.TestCase):
    def setUp(self):
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


if __name__ == "__main__":
    unittest.main()
