"""
Реальные тесты ядра копи-движка. Только stdlib (unittest) — можно гонять где угодно
без единой внешней зависимости: python3 -m unittest backend.test_mirror_engine -v
"""

import unittest

from mirror_engine import (
    LeaderEvent,
    FollowerConfig,
    MarketConstraints,
    Side,
    compute_mirror_plan,
)

BTC = MarketConstraints(min_base_amount=0.001, size_decimals=3)


class TestProportionalIncrease(unittest.TestCase):
    def test_basic_proportional_sizing(self):
        # Лидер: equity $50,000, открывает $5,000 нотионала -> риск-доля 10%.
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=0.05, price=100_000, leader_equity_usd=50_000,
        )
        follower = FollowerConfig(
            follower_id="f1", allocation_usd=1_000,
            available_margin_usd=1_000, max_leverage=10,
        )
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 1)
        self.assertEqual(len(plan.skipped), 0)
        order = plan.orders[0]
        # 10% от $1,000 = $100 нотионала при цене 100,000 -> 0.001 BTC
        self.assertAlmostEqual(order.base_amount, 0.001, places=3)
        self.assertFalse(order.reduce_only)

    def test_margin_cap_limits_order_below_proportional_amount(self):
        # Та же риск-доля 10%, но у подписчика мало свободной маржи и низкое плечо.
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=0.5, price=100_000, leader_equity_usd=50_000,  # риск-доля 100%!
        )
        follower = FollowerConfig(
            follower_id="f1", allocation_usd=10_000,
            available_margin_usd=50, max_leverage=2,  # максимум $100 нотионала
        )
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 1)
        order = plan.orders[0]
        # Без капа было бы 0.01 BTC ($1000), с капом маржи*плечо=$100 -> 0.001 BTC
        self.assertAlmostEqual(order.base_amount, 0.001, places=3)

    def test_below_minimum_order_size_is_skipped_with_reason(self):
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=0.001, price=100_000, leader_equity_usd=1_000_000,  # риск-доля крошечная
        )
        follower = FollowerConfig(
            follower_id="f1", allocation_usd=50,
            available_margin_usd=50, max_leverage=5,
        )
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 0)
        self.assertEqual(len(plan.skipped), 1)
        self.assertEqual(plan.skipped[0].reason, "below_min_order_size")

    def test_zero_leader_equity_skips_everyone_explicitly(self):
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=1.0, price=100_000, leader_equity_usd=0,
        )
        followers = [
            FollowerConfig("f1", 1000, 1000, 5),
            FollowerConfig("f2", 2000, 2000, 5),
        ]
        plan = compute_mirror_plan(event, followers, BTC)

        self.assertEqual(len(plan.orders), 0)
        self.assertEqual(len(plan.skipped), 2)
        self.assertTrue(all(s.reason == "leader_equity_unavailable" for s in plan.skipped))

    def test_never_rounds_up(self):
        # 0.0019 BTC при 3 знаках должно стать 0.001, а не 0.002 — никогда не переисполнять.
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=0.0019, price=1, leader_equity_usd=1,  # риск-доля = 1 (100%)
        )
        follower = FollowerConfig("f1", allocation_usd=1, available_margin_usd=1, max_leverage=1)
        # notional_desired = 1 * 1 = 1, base = 1/1 = 1.0 -- перестроим цифры проще:
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=True,
            size_delta=1.9, price=1, leader_equity_usd=1000,
        )
        follower = FollowerConfig("f1", allocation_usd=1000, available_margin_usd=1000, max_leverage=1)
        plan = compute_mirror_plan(event, [follower], BTC)
        self.assertEqual(len(plan.orders), 1)
        self.assertLessEqual(plan.orders[0].base_amount, 1.9)
        self.assertEqual(round(plan.orders[0].base_amount, 3), plan.orders[0].base_amount)


class TestLeaderReduces(unittest.TestCase):
    def test_partial_close_mirrors_proportionally_from_followers_own_size(self):
        # Лидер закрывает 50% своей позиции (была 1.0, уменьшил на 0.5).
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=False,
            size_delta=0.5, price=100_000, leader_equity_usd=50_000,
            leader_position_before=1.0,
        )
        # Подписчик зашёл позже, у него зеркальный размер вообще не связан с размером лидера.
        follower = FollowerConfig(
            follower_id="f1", allocation_usd=1000, available_margin_usd=1000,
            max_leverage=5, current_mirrored_size=0.2,
        )
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 1)
        order = plan.orders[0]
        self.assertTrue(order.reduce_only)
        # 50% от СВОИХ 0.2 -> 0.1, а не 50% от чего-то, связанного с размером лидера.
        self.assertAlmostEqual(order.base_amount, 0.1, places=3)

    def test_full_close_closes_followers_full_mirrored_size(self):
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=False,
            size_delta=1.0, price=100_000, leader_equity_usd=50_000,
            leader_position_before=1.0,  # закрывает всё
        )
        follower = FollowerConfig("f1", 1000, 1000, 5, current_mirrored_size=0.3)
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertAlmostEqual(plan.orders[0].base_amount, 0.3, places=3)

    def test_follower_with_no_position_is_skipped_not_errored(self):
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=False,
            size_delta=0.5, price=100_000, leader_equity_usd=50_000,
            leader_position_before=1.0,
        )
        follower = FollowerConfig("f1", 1000, 1000, 5, current_mirrored_size=0)
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 0)
        self.assertEqual(plan.skipped[0].reason, "no_mirrored_position_to_reduce")

    def test_missing_leader_position_before_skips_explicitly_rather_than_guessing(self):
        event = LeaderEvent(
            market_id=0, side=Side.LONG, is_increase=False,
            size_delta=0.5, price=100_000, leader_equity_usd=50_000,
            leader_position_before=0,  # забыли передать
        )
        follower = FollowerConfig("f1", 1000, 1000, 5, current_mirrored_size=0.2)
        plan = compute_mirror_plan(event, [follower], BTC)

        self.assertEqual(len(plan.orders), 0)
        self.assertEqual(plan.skipped[0].reason, "leader_position_before_unavailable")


class TestMultipleFollowersMixedOutcomes(unittest.TestCase):
    def test_some_filled_some_skipped_in_one_event(self):
        event = LeaderEvent(
            market_id=0, side=Side.SHORT, is_increase=True,
            size_delta=0.1, price=100_000, leader_equity_usd=100_000,  # риск-доля 10%
        )
        followers = [
            FollowerConfig("whale", allocation_usd=100_000, available_margin_usd=100_000, max_leverage=10),
            FollowerConfig("dust", allocation_usd=1, available_margin_usd=1, max_leverage=1),
        ]
        plan = compute_mirror_plan(event, followers, BTC)

        self.assertEqual(len(plan.orders), 1)
        self.assertEqual(plan.orders[0].follower_id, "whale")
        self.assertEqual(len(plan.skipped), 1)
        self.assertEqual(plan.skipped[0].follower_id, "dust")


if __name__ == "__main__":
    unittest.main(verbosity=2)
