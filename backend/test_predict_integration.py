"""python -m unittest test_predict_integration -v

Полный жизненный цикл price-рынка через все три модуля разом: создание →
торговля двух юзеров → резолюция реальной ценой → честная выплата. Всё на
реальной PostgreSQL, потому что именно так цикл выглядит в проде.
"""

import time
import unittest
import uuid

import testsupport
import predict_db as pdb
from predict_amm import LMSRMarket
from predict_resolution import Comparator, resolve_price_market

_run = testsupport.run


class TestPredictLifecycle(unittest.TestCase):
    def setUp(self):
        testsupport.reset()
        _run(
            pdb.create_market(
                "m1",
                "price",
                "ETH выше $4000 к дедлайну?",
                resolve_at=time.time() + 3600,
                b=200,
                lighter_market_id=1,
                threshold=4000,
                comparator=">=",
            )
        )

    def trade(self, user_id, outcome, shares):
        return _run(pdb.record_trade(str(uuid.uuid4()), user_id, "m1", outcome, shares))

    def test_full_lifecycle_from_creation_to_payout(self):
        # Трое торгуют до дедлайна — цена рынка (не Lighter, а вероятность YES)
        # должна сдвигаться в сторону мнения большинства покупок.
        self.trade("alice", "yes", 50)
        self.trade("bob", "yes", 30)
        self.trade("carol", "no", 10)

        m = _run(pdb.get_market("m1"))
        p_yes = LMSRMarket(b=m["b"], q_yes=m["q_yes"], q_no=m["q_no"]).price_yes()
        self.assertGreater(
            p_yes,
            0.5,
            "при таком перекосе покупок YES implied-вероятность должна быть > 50%",
        )

        # Дедлайн наступил, реальная (в проде — с getCandles) цена ETH: $4150.
        resolution = resolve_price_market(
            4150.0, threshold=4000, comparator=Comparator.GTE
        )
        self.assertEqual(resolution.outcome, "yes")
        _run(
            pdb.resolve_market(
                "m1",
                resolution.outcome,
                resolved_by="auto:lighter_mark_price",
                evidence_url=None,
            )
        )

        # alice и bob были на yes (победили), carol на no (проиграла).
        self.assertEqual(_run(pdb.claim_winnings("alice", "m1")), 50.0)
        self.assertEqual(_run(pdb.claim_winnings("bob", "m1")), 30.0)
        self.assertEqual(_run(pdb.claim_winnings("carol", "m1")), 0.0)

    def test_closed_market_takes_no_new_money(self):
        self.trade("alice", "yes", 50)
        _run(pdb.resolve_market("m1", "yes", "auto:lighter_mark_price", None))
        with self.assertRaises(ValueError):
            self.trade("dave", "yes", 100)
        self.assertEqual(
            _run(pdb.get_position("dave", "m1", "yes")),
            None,
            "отклонённая сделка не должна оставлять позицию",
        )

    def test_stats_and_positions_survive_resolution(self):
        self.trade("alice", "yes", 50)
        self.trade("carol", "no", 10)
        _run(pdb.resolve_market("m1", "yes", "auto:lighter_mark_price", None))

        positions = _run(pdb.list_user_positions("alice"))
        self.assertEqual(len(positions), 1)
        self.assertEqual(positions[0]["status"], "resolved")
        self.assertEqual(positions[0]["market_outcome"], "yes")
        self.assertEqual(positions[0]["claimed"], 0, "выплату ещё не брали")

        stats = _run(pdb.market_stats())["m1"]
        self.assertEqual(stats["trade_count"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
