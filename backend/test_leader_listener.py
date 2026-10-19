"""
Прогон hot path листенера копи-трейдинга на реальной схеме db.py: build_constraints()
и handle_leader_event() — две функции, которые раньше оставались единственной
непроверенной частью mirror-цикла (математика в test_mirror_engine.py, трекинг
позиций в test_leader_position_tracker.py).

Запуск: python -m unittest test_leader_listener -v
"""

import unittest
import uuid

import testsupport
import db
import leader_listener
from mirror_engine import MarketConstraints


def _patch_module(module, name, value):
    original = getattr(module, name)
    setattr(module, name, value)
    return lambda: setattr(module, name, original)


class ListenerDbCase(testsupport.PgCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # DRY_RUN берётся из env при импорте; тест проверяет путь без реальных
        # ордеров, поэтому фиксируем его здесь, а не надеемся на локальный .env.
        self.addCleanup(_patch_module(leader_listener, "DRY_RUN", True))
        self.leader_id = "leader-live"
        self.follow_ids = {}
        await db.upsert_leader(
            self.leader_id,
            lighter_account_index=7,
            handle="@smoke",
            fee_bps=8,
        )

    async def add_follower(
        self, allocation_usd: float, current_mirrored_size: float = 0.0
    ) -> str:
        follower_id = f"f-{uuid.uuid4().hex[:8]}"
        await db.upsert_follower(
            follower_id,
            l1_address="0x" + follower_id,
            lighter_account_index=900,
        )
        follow_id = str(uuid.uuid4())
        await db.create_follow(
            follow_id,
            follower_id,
            self.leader_id,
            allocation_usd=allocation_usd,
            max_leverage=5,
        )
        if current_mirrored_size:
            await db.update_mirrored_size(follow_id, current_mirrored_size)
        self.follow_ids[follower_id] = follow_id
        return follower_id

    async def mirror_log(self, follower_id):
        # Читается ровно тот же репозиторный метод, что отдаёт журнал фронту.
        return await db.mirror_log_for_follower(follower_id, limit=50)


def raw_event(
    market_id=8,
    side="long",
    is_increase=True,
    size_delta=0.5,
    price=2000.0,
    leader_equity_usd=50000.0,
    leader_position_before=0.0,
):
    return {
        "market_id": market_id,
        "side": side,
        "is_increase": is_increase,
        "size_delta": size_delta,
        "price": price,
        "leader_equity_usd": leader_equity_usd,
        "leader_position_before": leader_position_before,
    }


class TestBuildConstraints(unittest.TestCase):
    """Ошибкой было приложение BTC-шаблона ко всем рынкам: у каждого рынка свои
    min_base_amount и supported_size_decimals, неверный шаг — это неверный
    base_amount mirror-ордера на реальном счёте."""

    def test_per_market_values_keyed_by_market_id(self):
        books = [
            {
                "market_id": "1",
                "status": "active",
                "min_base_amount": "0.00007",
                "supported_size_decimals": "4",
            },
            {
                "market_id": "8",
                "status": "active",
                "min_base_amount": "0.01",
                "supported_size_decimals": "2",
            },
        ]
        out = leader_listener.build_constraints(books)
        self.assertEqual(sorted(out), [1, 8])
        self.assertEqual(
            out[1], MarketConstraints(min_base_amount=0.00007, size_decimals=4)
        )
        self.assertEqual(
            out[8], MarketConstraints(min_base_amount=0.01, size_decimals=2)
        )
        self.assertIsInstance(out[1].min_base_amount, float)
        self.assertIsInstance(out[8].size_decimals, int)

    def test_inactive_and_malformed_books_excluded_not_fatal(self):
        books = [
            {
                "market_id": "1",
                "status": "inactive",
                "min_base_amount": "0.1",
                "supported_size_decimals": "2",
            },
            {
                "market_id": "8",
                "status": "active",
                "min_base_amount": "0.1",
                "supported_size_decimals": "2",
            },
            {"market_id": "9", "status": "active"},  # книга без полей ограничений
        ]
        out = leader_listener.build_constraints(books)
        self.assertEqual(
            list(out),
            [8],
            "неактивный рынок поставить ордер не может, битая строка не роняет весь список",
        )


class TestHandleLeaderEvent(ListenerDbCase):
    async def run_event(self, event, constraints):
        await leader_listener.handle_leader_event(self.leader_id, event, constraints)

    async def test_dry_run_writes_one_row_per_follower(self):
        first = await self.add_follower(1000.0)
        second = await self.add_follower(500.0)
        await self.run_event(
            raw_event(), MarketConstraints(min_base_amount=0.001, size_decimals=3)
        )

        rows = [
            *(await self.mirror_log(first)),
            *(await self.mirror_log(second)),
        ]
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {r["follow_id"] for r in rows},
            {self.follow_ids[first], self.follow_ids[second]},
        )
        self.assertEqual({r["status"] for r in rows}, {"dry_run"})
        self.assertTrue(all(r["base_amount"] > 0 for r in rows))

    async def test_skip_is_logged_with_follow_id_not_follower_id(self):
        """Регрессия на IntegrityError в самом обычном пути: SkippedFollower несёт
        follower_id подписчика, а mirror_log.follow_id ссылается на follows(id) при
        включённых foreign keys. Прямая запись роняла листенер посреди стрима.

        Skip достигается аллокацией, которой не хватает на минимальный ордер, —
        это штатная ситуация для мелкого подписчика, не краевой случай."""
        follower_id = await self.add_follower(1.0)
        await self.run_event(
            raw_event(price=2000.0, size_delta=0.5, leader_equity_usd=50000.0),
            MarketConstraints(min_base_amount=10.0, size_decimals=2),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "skipped")
        self.assertEqual(rows[0]["reason"], "below_min_order_size")
        self.assertEqual(rows[0]["follow_id"], self.follow_ids[follower_id])
        self.assertNotEqual(rows[0]["follow_id"], follower_id)

    async def test_missing_constraints_skips_every_follower_without_touching_market(
        self,
    ):
        """constraints=None — рынка нет в полученной книге. Угадать шаг нельзя,
        поэтому все подписчики уходят в skip с явной причиной, а не в ордер."""
        a = await self.add_follower(1000.0)
        b = await self.add_follower(2000.0)
        await self.run_event(raw_event(market_id=777), None)

        rows = [*(await self.mirror_log(a)), *(await self.mirror_log(b))]
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["status"] for r in rows}, {"skipped"})
        self.assertEqual(
            {r["reason"] for r in rows}, {"market_constraints_unavailable:777"}
        )
        self.assertEqual(
            {r["follow_id"] for r in rows}, {self.follow_ids[a], self.follow_ids[b]}
        )
        self.assertTrue(all(r["base_amount"] == 0 for r in rows))

    async def test_reduce_event_logs_reduce_only_order(self):
        follower_id = await self.add_follower(1000.0, current_mirrored_size=0.4)
        await self.run_event(
            raw_event(
                is_increase=False,
                size_delta=0.4,
                leader_position_before=0.4,
                leader_equity_usd=50000.0,
            ),
            MarketConstraints(min_base_amount=0.001, size_decimals=3),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "dry_run")
        self.assertEqual(rows[0]["reduce_only"], 1)

    async def test_paused_follower_is_not_mirrored(self):
        follower_id = await self.add_follower(1000.0)
        await db.set_paused(self.follow_ids[follower_id], True)
        await self.run_event(
            raw_event(), MarketConstraints(min_base_amount=0.001, size_decimals=3)
        )
        self.assertEqual(await self.mirror_log(follower_id), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
