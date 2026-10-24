"""python3 -m unittest test_leader_position_tracker -v"""

import unittest
from leader_position_tracker import LeaderPositionTracker


def position_msg(market_id: int, size: str, sign: int, avg_entry_price: str) -> dict:
    """Форма ответа по официальной схеме account_all_positions (update/account_all_positions)."""
    return {
        "channel": "account_all_positions:1",
        "positions": {
            str(market_id): {
                "market_id": market_id,
                "symbol": "ETH-USD",
                "initial_margin_fraction": "0.1",
                "open_order_count": 0,
                "pending_order_count": 0,
                "position_tied_order_count": 0,
                "sign": sign,
                "position": size,
                "avg_entry_price": avg_entry_price,
                "position_value": "0",
                "unrealized_pnl": "0",
                "realized_pnl": "0",
                "liquidation_price": "0",
                "margin_mode": 1,
                "allocated_margin": "0",
            }
        },
        "shares": [],
        "type": "update/account_all_positions",
    }


def snapshot(rows: dict, msg_type: str = "update/account_all_positions") -> dict:
    """Несколько позиций одним сообщением — та же схема, что у position_msg.

    Нужна именно множественная форма: половина находок в этом файле про то, как
    трекер ведёт себя, когда одних рынков в снапшоте больше, а других меньше.
    """
    return {
        "channel": "account_all_positions:1",
        "positions": {
            str(market_id): {
                "market_id": market_id,
                "symbol": "ETH-USD",
                "initial_margin_fraction": "0.1",
                "open_order_count": 0,
                "pending_order_count": 0,
                "position_tied_order_count": 0,
                **row,
            }
            for market_id, row in rows.items()
        },
        "shares": [],
        "type": msg_type,
    }


def user_stats_msg(portfolio_value: str) -> dict:
    """Форма ответа по официальной схеме user_stats (update/user_stats)."""
    return {
        "channel": "user_stats:1",
        "stats": {
            "collateral": "5000",
            "portfolio_value": portfolio_value,
            "leverage": "3.0",
            "available_balance": "2000",
            "margin_usage": "0.5",
            "buying_power": "4000",
            "account_trading_mode": 1,
        },
        "timestamp": 1773158679717,
        "type": "update/user_stats",
    }


class TestNoEquityYet(unittest.TestCase):
    def test_increase_without_known_equity_is_withheld(self):
        t = LeaderPositionTracker()
        events = t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        self.assertEqual(
            events, [], "без известного equity приращение не должно эмиттиться"
        )
        # но состояние всё равно обновилось внутри
        self.assertEqual(t.positions[0]["size"], 0.5)


class TestBasicFlow(unittest.TestCase):
    def test_first_position_after_equity_known_emits_increase(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        events = t.apply_position_update(position_msg(0, "0.5", 1, "100000"))

        self.assertEqual(len(events), 1)
        e = events[0]
        self.assertEqual(e["side"], "long")
        self.assertTrue(e["is_increase"])
        self.assertAlmostEqual(e["size_delta"], 0.5)
        self.assertEqual(e["leader_equity_usd"], 50000.0)

    def test_further_increase_computes_correct_delta(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        events = t.apply_position_update(position_msg(0, "0.8", 1, "100500"))

        self.assertEqual(len(events), 1)
        self.assertAlmostEqual(events[0]["size_delta"], 0.3, places=6)
        self.assertTrue(events[0]["is_increase"])

    def test_partial_decrease_emits_reduce_with_correct_position_before(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        events = t.apply_position_update(position_msg(0, "0.2", 1, "100000"))

        self.assertEqual(len(events), 1)
        e = events[0]
        self.assertFalse(e["is_increase"])
        self.assertAlmostEqual(e["size_delta"], 0.3, places=6)
        self.assertAlmostEqual(e["leader_position_before"], 0.5, places=6)
        self.assertEqual(
            e["side"], "long"
        )  # закрываем ДОЛЮ лонга, событие всё ещё "long"

    def test_full_close_to_zero(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        events = t.apply_position_update(position_msg(0, "0", 1, "100000"))

        self.assertEqual(len(events), 1)
        self.assertAlmostEqual(events[0]["size_delta"], 0.5, places=6)
        self.assertAlmostEqual(events[0]["leader_position_before"], 0.5, places=6)

    def test_no_change_emits_nothing(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        events = t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        self.assertEqual(events, [])


class TestReversal(unittest.TestCase):
    def test_long_flips_to_short_emits_close_then_open(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))  # long 0.5

        events = t.apply_position_update(
            position_msg(0, "0.3", -1, "99000")
        )  # flips to short 0.3

        self.assertEqual(
            len(events), 2, "разворот должен дать два события: закрытие и открытие"
        )

        close_e, open_e = events
        self.assertEqual(close_e["side"], "long")
        self.assertFalse(close_e["is_increase"])
        self.assertAlmostEqual(close_e["size_delta"], 0.5, places=6)
        self.assertAlmostEqual(close_e["leader_position_before"], 0.5, places=6)

        self.assertEqual(open_e["side"], "short")
        self.assertTrue(open_e["is_increase"])
        self.assertAlmostEqual(open_e["size_delta"], 0.3, places=6)

    def test_state_after_reversal_is_consistent_for_next_update(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(position_msg(0, "0.5", 1, "100000"))
        t.apply_position_update(position_msg(0, "0.3", -1, "99000"))

        # следующее сообщение: короткая позиция выросла с 0.3 до 0.4
        events = t.apply_position_update(position_msg(0, "0.4", -1, "98800"))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["side"], "short")
        self.assertTrue(events[0]["is_increase"])
        self.assertAlmostEqual(events[0]["size_delta"], 0.1, places=6)


class TestMultipleMarketsIndependent(unittest.TestCase):
    def test_two_markets_tracked_independently(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        msg = {
            "positions": {
                "0": {"sign": 1, "position": "0.5", "avg_entry_price": "100000"},
                "1": {"sign": -1, "position": "2.0", "avg_entry_price": "3500"},
            },
            "type": "update/account_all_positions",
        }
        events = t.apply_position_update(msg)
        self.assertEqual(len(events), 2)
        markets = {e["market_id"] for e in events}
        self.assertEqual(markets, {0, 1})


class TestMarketDisappearsFromSnapshot(unittest.TestCase):
    """Рынок, пропавший из снапшота, — закрытие, а не «ничего не изменилось».

    Прежняя реализация сравнивала только те рынки, что в сообщении есть. Если
    Lighter убирает схлопнутую позицию из `positions` (а не шлёт её с нулём),
    листенер не эмитил НИЧЕГО и держал мёртвую запись вечно: подписчик оставался
    в рынке, из которого лидер вышел, и закрыть этот зерканированный объём было
    уже нечем. Проверено на фикстуре с пустым `positions`: событий 0, состояние
    — «лонг 0.5».
    """

    def _open(self, t):
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(
            snapshot({"8": {"sign": 1, "position": "0.5", "avg_entry_price": "2000"}})
        )

    def test_absent_market_emits_full_close(self):
        t = LeaderPositionTracker()
        self._open(t)
        events = t.apply_position_update(snapshot({}))
        self.assertEqual(len(events), 1, "пропажа позы = одно событие закрытия")
        e = events[0]
        self.assertEqual(e["market_id"], 8)
        self.assertFalse(e["is_increase"])
        self.assertEqual(e["size_delta"], 0.5)
        self.assertEqual(e["leader_position_before"], 0.5)
        self.assertEqual(
            e["price"],
            2000.0,
            "цена берётся последняя известная — другой у трекера нет",
        )

    def test_state_is_dropped_so_the_next_appearance_is_an_open(self):
        """Если бы запись осталась, следующее появление рынка посчиталось бы
        «уменьшением от 0.5», то есть ещё одним закрытием вместо входа."""
        t = LeaderPositionTracker()
        self._open(t)
        t.apply_position_update(snapshot({}))
        self.assertEqual(t.positions, {})
        events = t.apply_position_update(
            snapshot({"8": {"sign": 1, "position": "0.2", "avg_entry_price": "2100"}})
        )
        self.assertEqual(len(events), 1)
        self.assertTrue(
            events[0]["is_increase"], "новое появление — открытие, не закрытие"
        )
        self.assertEqual(events[0]["size_delta"], 0.2)

    def test_zero_size_row_closes_once_and_is_not_re_emitted(self):
        """Вариант, где Lighter всё-таки шлёт строку с нулём: закрытие должно
        произойти ровно один раз, а не на каждом последующем снапшоте."""
        t = LeaderPositionTracker()
        self._open(t)
        zero = {"8": {"sign": 1, "position": "0", "avg_entry_price": "2000"}}
        self.assertEqual(len(t.apply_position_update(snapshot(zero))), 1)
        self.assertEqual(t.apply_position_update(snapshot(zero)), [])
        self.assertEqual(t.apply_position_update(snapshot({})), [])

    def test_partial_snapshot_only_closes_the_markets_that_vanished(self):
        t = LeaderPositionTracker()
        t.apply_user_stats(user_stats_msg("50000"))
        t.apply_position_update(
            snapshot(
                {
                    "0": {"sign": 1, "position": "0.5", "avg_entry_price": "100000"},
                    "1": {"sign": -1, "position": "2.0", "avg_entry_price": "3500"},
                }
            )
        )
        events = t.apply_position_update(
            snapshot({"1": {"sign": -1, "position": "2.0", "avg_entry_price": "3500"}})
        )
        self.assertEqual([e["market_id"] for e in events], [0])
        self.assertEqual(sorted(t.positions), [1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
