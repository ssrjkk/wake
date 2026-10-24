"""python -m unittest test_predict_db -v

predict_db.py на реальной PostgreSQL: валидация рынков, LMSR-сделки, позиции,
запрет оверселла и торговли по резолвленному рынку, выплаты и защита от
двойного claim — плюс ФОРМА ответа (resolve_at/created_at epoch-секундами,
claimed 0/1), на которую завязан фронт.
"""

import time
import unittest
import uuid

import testsupport
import predict_db as pdb

_run = testsupport.run


class PredictCase(unittest.TestCase):
    def setUp(self):
        testsupport.reset()
        self.now = time.time()
        _run(
            pdb.create_market(
                "m-price",
                "price",
                "BTC выше $120k к пятнице?",
                resolve_at=self.now + 86400,
                b=100,
                lighter_market_id=0,
                threshold=120_000,
                comparator=">=",
            )
        )
        _run(
            pdb.create_market(
                "m-event",
                "event",
                "Победит ли команда А?",
                resolve_at=self.now + 86400,
                b=50,
            )
        )

    def trade(self, user_id, market_id, outcome, shares):
        return _run(
            pdb.record_trade(str(uuid.uuid4()), user_id, market_id, outcome, shares)
        )

    def resolve(self, market_id="m-price", outcome="yes"):
        _run(
            pdb.resolve_market(
                market_id, outcome, resolved_by="curator", evidence_url=None
            )
        )


class TestMarkets(PredictCase):
    def test_price_market_requires_threshold_and_comparator(self):
        with self.assertRaises(ValueError):
            _run(
                pdb.create_market(
                    "m-bad", "price", "без threshold", resolve_at=self.now, b=10
                )
            )

    def test_unknown_kind_is_rejected(self):
        with self.assertRaises(ValueError):
            _run(
                pdb.create_market(
                    "m-bad", "prediction", "неизвестный kind", resolve_at=self.now, b=10
                )
            )

    def test_status_filter_and_wire_shape(self):
        open_rows = _run(pdb.list_markets("open"))
        self.assertEqual({m["id"] for m in open_rows}, {"m-price", "m-event"})
        self.assertEqual(_run(pdb.list_markets("resolved")), [])
        self.assertEqual(len(_run(pdb.list_markets("all"))), 2)
        with self.assertRaises(ValueError):
            _run(pdb.list_markets("closed"))

        m = next(r for r in open_rows if r["id"] == "m-price")
        self.assertIsInstance(m["resolve_at"], float)
        self.assertGreater(
            m["resolve_at"], 1_000_000_000, "epoch-секунды, не микросекунды"
        )
        self.assertGreater(m["created_at"], 1_000_000_000)
        self.assertEqual(
            m["lighter_market_id"], 0, "0 — валидный индекс рынка, не NULL"
        )
        self.assertEqual((m["threshold"], m["comparator"]), (120_000, ">="))

    def test_resolved_market_stays_visible_and_carries_outcome(self):
        self.resolve()
        rows = _run(pdb.list_markets("resolved"))
        self.assertEqual([m["id"] for m in rows], ["m-price"])
        self.assertEqual(rows[0]["outcome"], "yes")
        self.assertEqual(rows[0]["resolved_by"], "curator")
        self.assertEqual([m["id"] for m in _run(pdb.list_markets("open"))], ["m-event"])

    def test_double_resolution_is_rejected(self):
        self.resolve()
        with self.assertRaises(ValueError):
            _run(pdb.resolve_market("m-price", "no"))

    def test_resolving_an_unknown_market_is_rejected(self):
        with self.assertRaises(ValueError):
            _run(pdb.resolve_market("no-such-market", "yes"))


class TestTrading(PredictCase):
    def test_buy_moves_the_pool_and_costs_positive(self):
        cost = self.trade("user-alice", "m-price", "yes", 10)
        self.assertGreater(cost, 0, "покупка должна стоить денег")
        self.assertAlmostEqual(_run(pdb.get_market("m-price"))["q_yes"], 10.0)

    def test_repeat_buy_adds_to_the_position_instead_of_duplicating_it(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-alice", "m-price", "yes", 5)
        self.assertEqual(
            _run(pdb.get_position("user-alice", "m-price", "yes"))["shares"], 15.0
        )

    def test_sell_returns_money_and_shrinks_the_position(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-alice", "m-price", "yes", 5)
        self.assertLess(self.trade("user-alice", "m-price", "yes", -5), 0)
        self.assertEqual(
            _run(pdb.get_position("user-alice", "m-price", "yes"))["shares"], 10.0
        )

    def test_overselling_is_rejected(self):
        self.trade("user-alice", "m-price", "yes", 10)
        with self.assertRaises(ValueError):
            self.trade("user-alice", "m-price", "yes", -1000)
        self.assertEqual(
            _run(pdb.get_position("user-alice", "m-price", "yes"))["shares"], 10.0
        )

    def test_selling_without_a_position_is_rejected(self):
        with self.assertRaises(ValueError):
            self.trade("user-bob", "m-price", "no", -1)

    def test_failed_trade_leaves_the_pool_untouched(self):
        before = _run(pdb.get_market("m-price"))
        with self.assertRaises(ValueError):
            self.trade("user-bob", "m-price", "no", -1)
        after = _run(pdb.get_market("m-price"))
        self.assertEqual(
            (after["q_yes"], after["q_no"]), (before["q_yes"], before["q_no"])
        )
        self.assertEqual(
            _run(pdb.market_stats()), {}, "отменённая сделка не должна попасть в объём"
        )

    def test_users_are_independent(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-bob", "m-price", "no", 20)
        self.assertEqual(
            _run(pdb.get_position("user-alice", "m-price", "yes"))["shares"], 10.0
        )
        self.assertEqual(
            _run(pdb.get_position("user-bob", "m-price", "no"))["shares"], 20.0
        )

    def test_trading_a_resolved_market_is_rejected(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.resolve()
        with self.assertRaises(ValueError):
            self.trade("user-carol", "m-price", "yes", 1)

    def test_trading_after_the_deadline_is_refused(self):
        """Между resolve_at и статусом "resolved" лежит как минимум тик резолвера:
        рынок ещё открыт, а исход price-рынка уже определён ценой на дедлайн.
        Купить его в этом окне — значит заплатить меньше доллара за доллар, и
        платить будет пул (до своей субсидии b·ln2). Слой данных обязан отказать
        сам, а не полагаться на то, что фронт спрятал кнопку."""
        _run(
            pdb.create_market(
                "m-late",
                "price",
                "BTC выше 100k вчера?",
                resolve_at=self.now - 60,
                b=100,
                lighter_market_id=0,
                threshold=100_000,
                comparator=">=",
            )
        )
        with self.assertRaises(ValueError) as ctx:
            _run(pdb.record_trade(str(uuid.uuid4()), "user-alice", "m-late", "yes", 10))
        self.assertIn("дедлайн", str(ctx.exception))
        market = _run(pdb.get_market("m-late"))
        self.assertEqual((market["q_yes"], market["q_no"]), (0.0, 0.0), "пул не тронут")
        self.assertEqual(_run(pdb.list_user_positions("user-alice")), [])

    def test_event_market_closes_for_trading_at_its_deadline_too(self):
        """У event-рынка исход ещё не вынесен, но правила те же: после дедлайна
        информация продолжает приходить, и торговать после него — значит продавать
        пулу более информированную сделку."""
        _run(
            pdb.create_market(
                "m-late-event",
                "event",
                "Откроется ли мост?",
                resolve_at=self.now - 1,
                b=100,
            )
        )
        with self.assertRaises(ValueError):
            _run(
                pdb.record_trade(
                    str(uuid.uuid4()), "user-alice", "m-late-event", "yes", 5
                )
            )

    def test_unknown_market_is_rejected(self):
        with self.assertRaises(ValueError):
            self.trade("user-alice", "m-нет", "yes", 1)

    def test_market_stats_counts_buy_and_sell_volume(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-alice", "m-price", "yes", -4)
        stats = _run(pdb.market_stats())
        self.assertEqual(stats["m-price"]["trade_count"], 2)
        self.assertGreater(stats["m-price"]["volume_usd"], 0)
        self.assertNotIn("m-event", stats, "у рынка без сделок нет строки в статистике")


class TestPositionsAndClaims(PredictCase):
    def test_position_list_shape(self):
        self.trade("user-alice", "m-price", "yes", 10)
        rows = _run(pdb.list_user_positions("user-alice"))
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["question"], "BTC выше $120k к пятнице?")
        self.assertEqual(row["market_outcome"], None, "рынок ещё не резолвлен")
        self.assertIn(row["claimed"], (0, 1), "фронт читает claimed как число")
        self.assertGreater(row["net_cost"], 0, "net_cost — сколько реально уплачено")
        self.assertIsInstance(row["resolve_at"], float)

    def test_sold_out_position_disappears_from_the_list(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-alice", "m-price", "yes", -10)
        self.assertEqual(_run(pdb.list_user_positions("user-alice")), [])

    def test_winner_is_paid_one_dollar_per_share(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.trade("user-bob", "m-price", "no", 20)
        self.resolve("m-price", "yes")
        self.assertEqual(_run(pdb.claim_winnings("user-alice", "m-price")), 10.0)
        self.assertEqual(_run(pdb.claim_winnings("user-bob", "m-price")), 0.0)

    def test_second_claim_pays_nothing(self):
        self.trade("user-alice", "m-price", "yes", 10)
        self.resolve()
        _run(pdb.claim_winnings("user-alice", "m-price"))
        self.assertEqual(_run(pdb.claim_winnings("user-alice", "m-price")), 0.0)
        self.assertEqual(
            _run(pdb.get_position("user-alice", "m-price", "yes"))["claimed"], 1
        )

    def test_claim_on_open_market_is_rejected(self):
        self.trade("user-alice", "m-event", "yes", 10)
        with self.assertRaises(ValueError):
            _run(pdb.claim_winnings("user-alice", "m-event"))

    def test_claim_without_a_position_pays_nothing(self):
        self.resolve()
        self.assertEqual(_run(pdb.claim_winnings("user-nikto", "m-price")), 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
