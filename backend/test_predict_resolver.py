"""python -m unittest test_predict_resolver -v

Тестирует закрытие price-рынков: просрочен → получил цену → закрыт → можно
забрать выигрыш. Состояние — в реальной PostgreSQL, потому что именно там
живут рынки. Сеть не нужна для основного цикла, но последний тест идёт
через настоящий lighter_rest.get_price_at с подменённым urlopen: именно
стык «резолвер вызывает оракул» раньше не проверялся никем, и именно он
ломался — заглушки принимали переставленные аргументы и были зелёными,
пока автоматическая резолюция не закрывала ни одного рынка.
"""

import time
import unittest
import uuid
from unittest.mock import patch

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
        closed = self.resolve(lambda mid, at, net: 125_000)
        self.assertEqual([c["market_id"] for c in closed], ["due-yes"])
        m = self.markets()["due-yes"]
        self.assertEqual(m["outcome"], "yes")
        self.assertEqual(m["resolved_by"], "auto:lighter_mark_price")

    def test_below_threshold_resolves_no(self):
        self.create_price("due-no", 120_000, ">=", self.now - 60)
        closed = self.resolve(lambda mid, at, net: 119_999)
        self.assertEqual(closed[0]["outcome"], "no")

    def test_market_not_yet_due_stays_open(self):
        self.create_price("future", 120_000, ">=", self.now + 3600)
        self.assertEqual(self.resolve(lambda mid, at, net: 999_999), [])
        self.assertEqual(self.markets()["future"]["status"], "open")

    def test_event_markets_are_never_touched(self):
        _run(pdb.create_market("event", "event", "Победит ли А?", self.now - 60, 50))
        self.assertEqual(self.resolve(lambda mid, at, net: 1), [])
        self.assertEqual(self.markets()["event"]["status"], "open")

    def test_price_fetch_failure_leaves_market_open_for_next_tick(self):
        self.create_price("flaky", 120_000, ">=", self.now - 60)

        def broken(market_id, resolve_at, network):
            raise RuntimeError("Lighter API недоступен")

        self.assertEqual(self.resolve(broken), [])
        self.assertEqual(
            self.markets()["flaky"]["status"],
            "open",
            "без реальной цены закрывать рынок нельзя — иначе исход угадан",
        )
        self.assertEqual(
            len(self.resolve(lambda mid, at, net: 130_000)),
            1,
            "на следующем тике тот же рынок должен закрыться",
        )

    def test_winner_claims_after_auto_resolution(self):
        """Сделка — до дедлайна, резолюция — после: рынок создан с future
        дедлайном, а резолвер запускается с `now` за ним. Так же ведёт себя
        процесс: он приходит тиком позже, а не в ту же секунду."""
        self.create_price("trade-then-close", 120_000, ">=", self.now + 3600)
        cost = _run(
            pdb.record_trade(str(uuid.uuid4()), "u1", "trade-then-close", "yes", 10)
        )
        self.assertGreater(cost, 0)

        _run(resolve_due_markets(self.now + 7200, lambda mid, at, net: 121_000))
        self.assertEqual(self.markets()["trade-then-close"]["outcome"], "yes")

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
        self.assertEqual(len(self.resolve(lambda mid, at, net: 125_000)), 1)
        self.assertEqual(
            self.resolve(lambda mid, at, net: 125_000),
            [],
            "второй проход не должен повторно закрывать рынок",
        )
        self.assertEqual(self.markets()["stale"]["outcome"], "yes")

    def test_price_fn_receives_lighter_id_deadline_and_network(self):
        """Второй аргумент — дедлайн рынка, а не «сейчас», и порядок совпадает с
        get_price_at(market_id, when_s, network). Именно он привязывает оракул к
        моменту, который рынок обещал разрешить: без него резолвер после суток
        простоя закрыл бы рынок ценой нового дня, а с переставленными аргументами
        он не закрывал ничего."""
        self.create_price("args", 1000, ">", self.now - 1, lighter_market_id=77)
        seen = []
        self.resolve(lambda mid, at, net: seen.append((mid, at, net)) or 1001)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][0], 77, "оракул спрашивают по lighter_market_id рынка")
        self.assertAlmostEqual(seen[0][1], self.now - 1, places=3)
        self.assertEqual(seen[0][2], LIGHTER_NETWORK)

    def test_real_oracle_closes_a_due_market(self):
        """Тот же цикл, но с настоящим lighter_rest.get_price_at вместо заглушки:
        стык «резолвер вызывает оракул» и есть то место, где порядок аргументов
        перестал сходиться, и тесты этого не видели.

        Свеча, начинающаяся в дедлайн, содержит цены ПОСЛЕ него и нарочно даёт
        противоположный исход: если оракул возьмёт её, рынок закроется "no"."""
        import json

        from lighter_rest import get_price_at

        deadline = self.now - 120
        deadline_ms = int(deadline * 1000)
        minute_ms = 60_000
        candles = {
            "c": [
                {
                    "t": deadline_ms - 2 * minute_ms,
                    "o": "1",
                    "h": "1",
                    "l": "1",
                    "c": "900",
                    "V": "1",
                },
                {
                    "t": deadline_ms - minute_ms,
                    "o": "1",
                    "h": "1",
                    "l": "1",
                    "c": "1200",
                    "V": "1",
                },  # закончилась ровно в дедлайн
                {
                    "t": deadline_ms,
                    "o": "1",
                    "h": "1",
                    "l": "1",
                    "c": "100",
                    "V": "1",
                },  # [дедлайн, дедлайн+1м) — будущее
            ]
        }
        urls = []

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return json.dumps(candles).encode()

        def fake_urlopen(req, timeout=None):
            urls.append(req.full_url)
            return Resp()

        self.create_price("real-oracle", 1000, ">=", deadline, lighter_market_id=7)
        with patch("urllib.request.urlopen", fake_urlopen):
            closed = _run(resolve_due_markets(self.now, get_price_at))

        self.assertEqual([c["market_id"] for c in closed], ["real-oracle"])
        self.assertEqual(closed[0]["observed_price"], 1200.0)
        self.assertEqual(self.markets()["real-oracle"]["outcome"], "yes")
        query = dict(
            p.split("=", 1) for p in urls[0].split("?", 1)[1].split("&") if "=" in p
        )
        self.assertEqual(query["market_id"], "7")
        self.assertEqual(query["resolution"], "1m")
        self.assertEqual(
            int(query["end_timestamp"]),
            deadline_ms + minute_ms,
            "окно заканчивается дедлайном, а не моментом тика",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
