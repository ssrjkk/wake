"""python3 -m unittest test_predict_resolver -v

Тестирует закрытие price-рынков БЕЗ сети: mark-цена подаётся фиксированной
функцией, как это делает resolve_price_market() в остальных тестах. Реальный
Lighter-запрос — одна строка в lighter_rest.get_mark_price, он здесь не нужен,
чтобы проверить весь остальной путь: просрочен → получил цену → закрыт → можно
забрать выигрыш.
"""

import os
import tempfile
import time
import unittest
import uuid

import predict_db as pdb
from predict_resolver import resolve_due_markets


class TestPredictResolver(unittest.TestCase):
    def setUp(self):
        self.db_path = os.path.join(
            tempfile.mkdtemp(prefix="wake-resolver-"), "predict.db"
        )
        pdb.init_predict_db(self.db_path)
        self.now = time.time()

    def _create_price(
        self, market_id, threshold, comparator, resolve_at, lighter_market_id=1
    ):
        with pdb.connect(self.db_path) as conn:
            pdb.create_market(
                conn,
                market_id,
                "price",
                f"выше {threshold}?",
                resolve_at,
                100,
                lighter_market_id=lighter_market_id,
                threshold=threshold,
                comparator=comparator,
            )

    def _markets(self):
        with pdb.connect(self.db_path) as conn:
            return {r["id"]: dict(r) for r in pdb.list_markets(conn, "all")}

    def test_due_market_closes_on_threshold(self):
        self._create_price("due-yes", 120_000, ">=", self.now - 60)
        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, lambda mid, net: 125_000)
        self.assertEqual([c["market_id"] for c in closed], ["due-yes"])
        self.assertEqual(self._markets()["due-yes"]["outcome"], "yes")
        self.assertEqual(
            self._markets()["due-yes"]["resolved_by"], "auto:lighter_mark_price"
        )

    def test_below_threshold_resolves_no(self):
        self._create_price("due-no", 120_000, ">=", self.now - 60)
        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, lambda mid, net: 119_999)
        self.assertEqual(closed[0]["outcome"], "no")

    def test_market_not_yet_due_stays_open(self):
        self._create_price("future", 120_000, ">=", self.now + 3600)
        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, lambda mid, net: 999_999)
        self.assertEqual(closed, [])
        self.assertEqual(self._markets()["future"]["status"], "open")

    def test_event_markets_are_never_touched(self):
        with pdb.connect(self.db_path) as conn:
            pdb.create_market(
                conn, "event", "event", "Победит ли А?", self.now - 60, 50
            )
        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, lambda mid, net: 1)
        self.assertEqual(closed, [])
        self.assertEqual(self._markets()["event"]["status"], "open")

    def test_price_fetch_failure_leaves_market_open_for_next_tick(self):
        self._create_price("flaky", 120_000, ">=", self.now - 60)

        def broken(market_id, network):
            raise RuntimeError("Lighter API недоступен")

        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, broken)
        self.assertEqual(closed, [])
        self.assertEqual(
            self._markets()["flaky"]["status"],
            "open",
            "без реальной цены закрывать рынок нельзя — иначе исход угадан",
        )

        with pdb.connect(self.db_path) as conn:
            closed = resolve_due_markets(conn, self.now, lambda mid, net: 130_000)
        self.assertEqual(
            len(closed), 1, "на следующем тике тот же рынок должен закрыться"
        )

    def test_winner_claims_after_auto_resolution(self):
        self._create_price("trade-then-close", 120_000, ">=", self.now - 60)
        with pdb.connect(self.db_path) as conn:
            cost = pdb.record_trade(
                conn, str(uuid.uuid4()), "u1", "trade-then-close", "yes", 10
            )
        self.assertGreater(cost, 0)

        with pdb.connect(self.db_path) as conn:
            resolve_due_markets(conn, self.now, lambda mid, net: 121_000)

        with pdb.connect(self.db_path) as conn:
            with self.assertRaises(ValueError):
                pdb.record_trade(
                    conn, str(uuid.uuid4()), "u2", "trade-then-close", "yes", 1
                )
            payout = pdb.claim_winnings(conn, "u1", "trade-then-close")
        self.assertEqual(payout, 10.0)

    def test_second_resolution_of_the_same_market_is_rejected(self):
        self._create_price("twice", 120_000, ">=", self.now - 60)
        with pdb.connect(self.db_path) as conn:
            pdb.resolve_market(conn, "twice", "yes", "auto:lighter_mark_price", None)
        with pdb.connect(self.db_path) as conn:
            with self.assertRaises(ValueError):
                pdb.resolve_market(conn, "twice", "no", "curator:mallory", None)
        self.assertEqual(
            self._markets()["twice"]["outcome"],
            "yes",
            "повторная резолюция не должна переписывать исход — с ним переписываются выплаты",
        )

    def test_resolver_skips_a_market_closed_between_ticks(self):
        self._create_price("stale", 120_000, ">=", self.now - 60)
        with pdb.connect(self.db_path) as conn:
            self.assertEqual(
                len(resolve_due_markets(conn, self.now, lambda mid, net: 125_000)), 1
            )
        with pdb.connect(self.db_path) as conn:
            self.assertEqual(
                resolve_due_markets(conn, self.now, lambda mid, net: 125_000), []
            )

    def test_resolve_unknown_market_raises(self):
        with pdb.connect(self.db_path) as conn:
            with self.assertRaises(ValueError):
                pdb.resolve_market(conn, "no-such-market", "yes", "curator", None)

    def test_price_fn_receives_the_markets_lighter_id_and_network(self):
        self._create_price("args", 1000, ">", self.now - 1, lighter_market_id=77)
        seen = []
        with pdb.connect(self.db_path) as conn:
            resolve_due_markets(
                conn, self.now, lambda mid, net: seen.append((mid, net)) or 1001
            )
        self.assertEqual(seen, [(77, "mainnet")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
