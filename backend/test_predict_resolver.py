"""python -m unittest test_predict_resolver -v

Тестирует закрытие price-рынков БЕЗ сети: mark-цена подаётся фиксированной
функцией, как это делает resolve_price_market() в остальных тестах. Реальный
Lighter-запрос — одна строка в lighter_rest.get_mark_price, он здесь не нужен,
чтобы проверить весь остальной путь: просрочен → получил цену → закрыт → можно
забрать выигрыш. Состояние — в реальной PostgreSQL, потому что именно там
живут рынки.
"""

import time
import unittest
import uuid

import testsupport
import predict_db as pdb
from config import LIGHTER_NETWORK
from predict_resolver import resolve_due_markets

_run = testsupport.run


class TestPredictResolver(unittest.TestCase):
    def setUp(self):
        testsupport.reset()
        self.now = time.time()

    def create_price(
        self, market_id, threshold, comparator, resolve_at, lighter_market_id=1
    ):
        _run(
            pdb.create_market(
                market_id,
                "price",
                f"выше {threshold}?",
                resolve_at,
                100,
                lighter_market_id=lighter_market_id,
                threshold=threshold,
                comparator=comparator,
            )
        )

    def markets(self):
        return {r["id"]: r for r in _run(pdb.list_markets("all"))}

    def resolve(self, price_fn):
        return _run(resolve_due_markets(self.now, price_fn))

    def test_due_market_closes_on_threshold(self):
        self.create_price("due-yes", 120_000, ">=", self.now - 60)
        closed = self.resolve(lambda mid, net, at: 125_000)
        self.assertEqual([c["market_id"] for c in closed], ["due-yes"])
        m = self.markets()["due-yes"]
        self.assertEqual(m["outcome"], "yes")
        self.assertEqual(m["resolved_by"], "auto:lighter_mark_price")

    def test_below_threshold_resolves_no(self):
        self.create_price("due-no", 120_000, ">=", self.now - 60)
        closed = self.resolve(lambda mid, net, at: 119_999)
        self.assertEqual(closed[0]["outcome"], "no")

    def test_market_not_yet_due_stays_open(self):
        self.create_price("future", 120_000, ">=", self.now + 3600)
        self.assertEqual(self.resolve(lambda mid, net, at: 999_999), [])
        self.assertEqual(self.markets()["future"]["status"], "open")

    def test_event_markets_are_never_touched(self):
        _run(pdb.create_market("event", "event", "Победит ли А?", self.now - 60, 50))
        self.assertEqual(self.resolve(lambda mid, net, at: 1), [])
        self.assertEqual(self.markets()["event"]["status"], "open")

    def test_price_fetch_failure_leaves_market_open_for_next_tick(self):
        self.create_price("flaky", 120_000, ">=", self.now - 60)

        def broken(market_id, network, resolve_at):
            raise RuntimeError("Lighter API недоступен")

        self.assertEqual(self.resolve(broken), [])
        self.assertEqual(
            self.markets()["flaky"]["status"],
            "open",
            "без реальной цены закрывать рынок нельзя — иначе исход угадан",
        )
        self.assertEqual(
            len(self.resolve(lambda mid, net, at: 130_000)),
            1,
            "на следующем тике тот же рынок должен закрыться",
        )

    def test_winner_claims_after_auto_resolution(self):
        self.create_price("trade-then-close", 120_000, ">=", self.now - 60)
        cost = _run(
            pdb.record_trade(str(uuid.uuid4()), "u1", "trade-then-close", "yes", 10)
        )
        self.assertGreater(cost, 0)

        self.resolve(lambda mid, net, at: 121_000)

        with self.assertRaises(ValueError):
            _run(
                pdb.record_trade(str(uuid.uuid4()), "u2", "trade-then-close", "yes", 1)
            )
        self.assertEqual(
            _run(pdb.claim_winnings("u1", "trade-then-close")),
            10.0,
            "автоматическая резолюция должна открывать выплату на том же основании, "
            "что и кураторская",
        )

    def test_resolver_skips_a_market_closed_between_ticks(self):
        self.create_price("stale", 120_000, ">=", self.now - 60)
        self.assertEqual(len(self.resolve(lambda mid, net, at: 125_000)), 1)
        self.assertEqual(
            self.resolve(lambda mid, net, at: 125_000),
            [],
            "второй проход не должен повторно закрывать рынок",
        )
        self.assertEqual(self.markets()["stale"]["outcome"], "yes")

    def test_price_fn_receives_lighter_id_network_and_deadline(self):
        """Третьй аргумент — дедлайн рынка, а не «сейчас». Именно он привязывает
        оракул к моменту, который рынок и обещал разрешить: без него резолвер после
        суток простоя закрыл бы рынок ценой нового дня."""
        self.create_price("args", 1000, ">", self.now - 1, lighter_market_id=77)
        seen = []
        self.resolve(lambda mid, net, at: seen.append((mid, net, at)) or 1001)
        self.assertEqual(seen, [(77, LIGHTER_NETWORK, seen[0][2])])
        self.assertAlmostEqual(seen[0][2], self.now - 1, places=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
