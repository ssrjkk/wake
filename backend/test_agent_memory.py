"""python3 -m unittest test_agent_memory -v"""

import unittest
from agent_memory import AgentMemoryStore


class TestOpenClose(unittest.TestCase):
    def test_open_trade_has_no_pnl_until_closed(self):
        m = AgentMemoryStore()
        t = m.record_open("t1", market_id=0, side="long", entry_price=100_000, size=0.1)
        self.assertTrue(t.is_open)
        self.assertIsNone(t.pnl_usd)

    def test_close_computes_correct_pnl_for_long(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", entry_price=100_000, size=0.1)
        t = m.record_close("t1", exit_price=105_000)
        self.assertFalse(t.is_open)
        self.assertAlmostEqual(t.pnl_usd, 500.0, places=2)  # (105000-100000)*0.1

    def test_close_computes_correct_pnl_for_short(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "short", entry_price=100_000, size=0.1)
        t = m.record_close("t1", exit_price=95_000)
        self.assertAlmostEqual(t.pnl_usd, 500.0, places=2)  # шорт выигрывает на падении

    def test_short_losing_trade_has_negative_pnl(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "short", entry_price=100_000, size=0.1)
        t = m.record_close("t1", exit_price=105_000)
        self.assertAlmostEqual(t.pnl_usd, -500.0, places=2)

    def test_cannot_close_already_closed_trade(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100_000, 0.1)
        m.record_close("t1", 105_000)
        with self.assertRaises(ValueError):
            m.record_close("t1", 110_000)

    def test_cannot_close_unknown_trade(self):
        m = AgentMemoryStore()
        with self.assertRaises(ValueError):
            m.record_close("ghost", 100.0)

    def test_rejects_invalid_side(self):
        m = AgentMemoryStore()
        with self.assertRaises(ValueError):
            m.record_open("t1", 0, "sideways", 100_000, 0.1)


class TestStats(unittest.TestCase):
    def test_win_rate_none_when_no_closed_trades(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100_000, 0.1)  # ещё открыта
        self.assertIsNone(m.win_rate())

    def test_win_rate_computed_correctly(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100, 1)
        m.record_close("t1", 110)  # win
        m.record_open("t2", 0, "long", 100, 1)
        m.record_close("t2", 90)  # loss
        m.record_open("t3", 0, "long", 100, 1)
        m.record_close("t3", 105)  # win
        self.assertAlmostEqual(m.win_rate(), 2 / 3, places=6)

    def test_win_rate_filtered_by_market(self):
        m = AgentMemoryStore()
        m.record_open("t1", market_id=0, side="long", entry_price=100, size=1)
        m.record_close("t1", 110)  # market 0, win
        m.record_open("t2", market_id=1, side="long", entry_price=100, size=1)
        m.record_close("t2", 90)  # market 1, loss
        self.assertAlmostEqual(m.win_rate(market_id=0), 1.0, places=6)
        self.assertAlmostEqual(m.win_rate(market_id=1), 0.0, places=6)

    def test_avg_pnl(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100, 1)
        m.record_close("t1", 110)  # +10
        m.record_open("t2", 0, "long", 100, 1)
        m.record_close("t2", 80)  # -20
        self.assertAlmostEqual(m.avg_pnl(), -5.0, places=6)


class TestRecentAndSummary(unittest.TestCase):
    def test_recent_trades_returns_most_recent_first(self):
        m = AgentMemoryStore()
        import time

        m.record_open("t1", 0, "long", 100, 1)
        time.sleep(0.01)
        m.record_open("t2", 0, "long", 100, 1)
        recent = m.recent_trades(n=10)
        self.assertEqual(recent[0].id, "t2")

    def test_summary_mentions_no_history_when_empty(self):
        m = AgentMemoryStore()
        summary = m.summarize_for_reasoning()
        self.assertIn("нет", summary.lower())

    def test_summary_includes_win_rate_after_closed_trades(self):
        m = AgentMemoryStore()
        m.record_open("t1", 0, "long", 100, 1, context_note="momentum breakout")
        m.record_close("t1", 110)
        summary = m.summarize_for_reasoning()
        self.assertIn("100%", summary)
        self.assertIn("momentum breakout", summary)


if __name__ == "__main__":
    unittest.main(verbosity=2)
