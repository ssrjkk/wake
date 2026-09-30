"""python3 -m unittest test_agent_decision -v"""

import unittest
from agent_memory import AgentMemoryStore
from agent_decision import rule_based_decision, MOMENTUM_THRESHOLD


class TestNoSignal(unittest.TestCase):
    def test_insufficient_price_history_holds(self):
        m = AgentMemoryStore()
        d = rule_based_decision(m, 0, recent_prices=[100_000])
        self.assertEqual(d.action, "hold")
        self.assertEqual(d.confidence, 0.0)

    def test_flat_momentum_holds_with_no_position(self):
        m = AgentMemoryStore()
        d = rule_based_decision(m, 0, recent_prices=[100_000, 100_100])  # 0.1%, ниже порога
        self.assertEqual(d.action, "hold")
        self.assertEqual(d.size_usd, 0.0)

    def test_flat_momentum_with_open_position_still_holds(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100_000, 0.1)
        d = rule_based_decision(m, 0, recent_prices=[100_000, 100_100])
        self.assertEqual(d.action, "hold")


class TestFreshSignal(unittest.TestCase):
    def test_strong_positive_momentum_no_history_goes_long_at_neutral_size(self):
        m = AgentMemoryStore()
        d = rule_based_decision(m, 0, recent_prices=[100_000, 103_000], base_size_usd=100)  # +3%
        self.assertEqual(d.action, "long")
        self.assertAlmostEqual(d.size_usd, 100.0, places=2)  # win_rate=None -> множитель 1.0
        self.assertGreater(d.confidence, 0)

    def test_strong_negative_momentum_no_history_goes_short(self):
        m = AgentMemoryStore()
        d = rule_based_decision(m, 0, recent_prices=[100_000, 97_000], base_size_usd=100)  # -3%
        self.assertEqual(d.action, "short")

    def test_good_track_record_increases_size(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100, 1)
        m.record_close("t1", 110)  # win -> winrate 1.0 на market 0
        d = rule_based_decision(m, 0, recent_prices=[100_000, 103_000], base_size_usd=100)
        self.assertAlmostEqual(d.size_usd, 150.0, places=2)  # (0.5+1.0)*100

    def test_bad_track_record_decreases_but_does_not_block(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100, 1)
        m.record_close("t1", 90)  # loss -> winrate 0.0 на market 0
        d = rule_based_decision(m, 0, recent_prices=[100_000, 103_000], base_size_usd=100)
        self.assertEqual(d.action, "long")  # не блокирует, просто меньше
        self.assertAlmostEqual(d.size_usd, 50.0, places=2)  # (0.5+0.0)*100

    def test_track_record_on_other_market_does_not_affect_this_one(self):
        m = AgentMemoryStore()
        m.record_open("t1", market_id=1, side="long", entry_price=100, size=1)
        m.record_close("t1", 200)  # огромный win, но на другом рынке
        d = rule_based_decision(m, market_id=0, recent_prices=[100_000, 103_000], base_size_usd=100)
        self.assertAlmostEqual(d.size_usd, 100.0, places=2)  # winrate на market=0 всё ещё None


class TestWithOpenPosition(unittest.TestCase):
    def test_momentum_confirms_open_long_holds_not_double_buys(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100_000, 0.1)
        d = rule_based_decision(m, 0, recent_prices=[100_000, 103_000])
        self.assertEqual(d.action, "hold")
        self.assertEqual(d.size_usd, 0.0)

    def test_momentum_reverses_against_open_long_closes(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100_000, 0.1)
        d = rule_based_decision(m, 0, recent_prices=[100_000, 97_000])  # момент теперь вниз
        self.assertEqual(d.action, "close")

    def test_momentum_reverses_against_open_short_closes(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "short", 100_000, 0.1)
        d = rule_based_decision(m, 0, recent_prices=[100_000, 103_000])  # момент теперь вверх
        self.assertEqual(d.action, "close")


if __name__ == "__main__":
    unittest.main(verbosity=2)
