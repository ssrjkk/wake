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
import lighter_rest
from leader_position_tracker import LeaderPositionTracker
from mirror_engine import (
    MarketConstraints,
    MirrorOrder,
    Side,
    is_buy_order,
    marketable_limit_price,
)


def _patch_module(module, name, value):
    original = getattr(module, name)
    setattr(module, name, value)
    return lambda: setattr(module, name, original)


def _snapshot(rows: dict, msg_type: str = "update/account_all_positions") -> dict:
    """Снапшот positions в форме Lighter — ровно та, которую разбирает трекер."""
    return {
        "channel": "account_all_positions:1",
        "positions": {
            str(market_id): {
                "sign": row["sign"],
                "position": row["position"],
                "avg_entry_price": row["avg_entry_price"],
            }
            for market_id, row in rows.items()
        },
        "type": msg_type,
    }


def _user_stats(portfolio_value: str) -> dict:
    return {
        "channel": "user_stats:1",
        "stats": {"portfolio_value": portfolio_value},
        "type": "update/user_stats",
    }


class ListenerDbCase(testsupport.PgCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        # DRY_RUN берётся из env при импорте; тест проверяет путь без реальных
        # ордеров, поэтому фиксируем его здесь, а не надеемся на локальный .env.
        self.addCleanup(_patch_module(leader_listener, "DRY_RUN", True))
        self.leader_id = "leader-live"
        self.follow_ids = {}
        # Маржа подписчика в живом пути читается с Lighter (get_account_equity);
        # в песочнице вместо неё таблица по индексам, которую тесты меняют сами.
        self.margin_by_index: dict[int, float | None] = {900: 100_000.0}
        self.addCleanup(
            _patch_module(
                lighter_rest,
                "get_account_equity",
                lambda index, network=None: self.margin_by_index.get(index),
            )
        )
        await db.upsert_leader(
            self.leader_id,
            lighter_account_index=7,
            handle="@smoke",
            fee_bps=8,
        )

    async def add_follower(
        self, allocation_usd: float, mirrored: dict[int, float] | None = None
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
        for market_id, size in (mirrored or {}).items():
            await db.add_mirrored_size(follow_id, market_id, size)
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
    min_base_amount, supported_size_decimals и supported_price_decimals; неверный
    шаг — это неверный base_amount mirror-ордера на реальном счёте, неверная
    decimals — цена ордера не на тот порядок величины.

    Форма полей взята из живого orderBooks mainnet (замер 2026-10-23): размеры
    приходят СТРОКАМИ ("min_base_amount": "0.70"), decimals — числами, и оба
    decimals есть у 246 из 246 строк книги."""

    def test_per_market_values_keyed_by_market_id(self):
        books = [
            {
                "market_id": "1",
                "status": "active",
                "min_base_amount": "0.00007",
                "supported_size_decimals": 4,
                "supported_price_decimals": 2,
            },
            {
                "market_id": "8",
                "status": "active",
                "min_base_amount": "0.01",
                "supported_size_decimals": 2,
                "supported_price_decimals": 4,
            },
        ]
        out = leader_listener.build_constraints(books)
        self.assertEqual(sorted(out), [1, 8])
        self.assertEqual(
            out[1],
            MarketConstraints(
                min_base_amount=0.00007, size_decimals=4, price_decimals=2
            ),
        )
        self.assertEqual(
            out[8],
            MarketConstraints(min_base_amount=0.01, size_decimals=2, price_decimals=4),
        )
        self.assertIsInstance(out[1].min_base_amount, float)
        self.assertIsInstance(out[8].size_decimals, int)

    def test_inactive_and_malformed_books_excluded_not_fatal(self):
        books = [
            {
                "market_id": "1",
                "status": "inactive",
                "min_base_amount": "0.1",
                "supported_size_decimals": 2,
                "supported_price_decimals": 2,
            },
            {
                "market_id": "8",
                "status": "active",
                "min_base_amount": "0.1",
                "supported_size_decimals": 2,
                "supported_price_decimals": 2,
            },
            {"market_id": "9", "status": "active"},  # книга без полей ограничений
            {
                "market_id": "10",
                "status": "active",
                "min_base_amount": "0.1",
                "supported_size_decimals": 2,
                # нет supported_price_decimals
            },
        ]
        out = leader_listener.build_constraints(books)
        self.assertEqual(
            list(out),
            [8],
            "неактивный рынок поставить ордер не может; битая строка не роняет "
            "весь список; рынок без price_decimals исключён, а не получил дефолт 0 "
            "— с дефолтом ордер ушёл бы с ценой в сто раз меньше рынка",
        )


class TestBuildOrderArgs(unittest.TestCase):
    """Аргументы create_order считаются здесь, а не внутри сетевого кода —
    иначе единственная проверка «ордер собрался верно» требовала бы живого
    Lighter и приватного ключа.

    Каждый из четырёх case ниже — это баг, который уже был в этой функции:
    цена без масштаба рынка, сторона закрытия не в обратную сторону и
    float-усечённый base_amount."""

    def setUp(self):
        self.constraints = MarketConstraints(
            min_base_amount=0.001, size_decimals=4, price_decimals=2
        )
        self.uid = str(uuid.uuid4())

    def args(self, side, reduce_only, base_amount=0.29, price=2000.0):
        order = MirrorOrder(
            follower_id="f1",
            market_id=8,
            side=side,
            base_amount=base_amount,
            reduce_only=reduce_only,
        )
        return leader_listener.build_order_args(
            order, price, self.constraints, 900, self.uid
        )

    def test_price_is_scaled_to_market_ticks(self):
        # Было: int(2000.0) = 2000, то есть лимитка в $20 на рынке за $2000.
        self.assertEqual(self.args(Side.LONG, False)["price"], 200_000)

    def test_sub_dollar_price_is_not_truncated_to_zero(self):
        # DOGE-класс: int(0.1634) = 0 — ордер с нулевой ценой.
        c = MarketConstraints(min_base_amount=0.001, size_decimals=1, price_decimals=4)
        order = MirrorOrder("f1", 61, Side.LONG, 1.0, False)
        self.assertEqual(
            leader_listener.build_order_args(order, 0.1634, c, 900, self.uid)["price"],
            1634,
        )

    def test_base_amount_keeps_the_whole_tick(self):
        # Было: int(0.29 * 10**4) = 2899 вместо 2900.
        self.assertEqual(self.args(Side.LONG, False)["base_amount"], 2900)

    def test_open_long_buys_open_short_sells(self):
        self.assertFalse(self.args(Side.LONG, False)["is_ask"])
        self.assertTrue(self.args(Side.SHORT, False)["is_ask"])

    def test_close_flips_the_side_of_the_position(self):
        """side в плане — СТОРОНА ПОЗЫЦИИ, а не направление сделки. Без XOR
        закрытие лонга уходило как buy+reduce_only, то есть подписчик не мог
        закрыться никогда."""
        close_long = self.args(Side.LONG, True)
        close_short = self.args(Side.SHORT, True)
        self.assertTrue(close_long["is_ask"], "закрытие лонга — это продажа")
        self.assertFalse(close_short["is_ask"], "закрытие шорта — это покупка")
        self.assertTrue(close_long["reduce_only"])

    def test_client_order_index_is_stable_per_intent_and_within_int32(self):
        first = self.args(Side.LONG, False)["client_order_index"]
        self.assertEqual(first, self.args(Side.LONG, False)["client_order_index"])
        self.assertGreaterEqual(first, 0)
        self.assertLess(first, 2**31)
        other_uid = str(uuid.uuid4())
        order = MirrorOrder("f1", 8, Side.LONG, 0.29, False)
        second = leader_listener.build_order_args(
            order, 2000.0, self.constraints, 900, other_uid
        )["client_order_index"]
        self.assertNotEqual(first, second)


class TestHandleLeaderEvent(ListenerDbCase):
    async def run_event(self, event, constraints):
        await leader_listener.handle_leader_event(self.leader_id, event, constraints)

    async def test_dry_run_writes_one_row_per_follower(self):
        first = await self.add_follower(1000.0)
        second = await self.add_follower(500.0)
        await self.run_event(
            raw_event(),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
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
            MarketConstraints(min_base_amount=10.0, size_decimals=2, price_decimals=2),
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
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.4})
        await self.run_event(
            raw_event(
                is_increase=False,
                size_delta=0.4,
                leader_position_before=0.4,
                leader_equity_usd=50000.0,
            ),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "dry_run")
        self.assertEqual(rows[0]["reduce_only"], 1)

    async def test_reduce_uses_the_event_market_not_the_portfolio_sum(self):
        """Закрытие считается от размера В ЭТОМ рынке.

        До исправления follows.current_mirrored_size была одна на все рынки, и
        движок читал её как «сколько у подписчика в BTC»: при позициях
        0.5 BTC + 0.5 ETH закрытие всей BTC-позиции планировало reduce на 1.0
        BTC — вдвое больше, чем у него есть, — а учёт после него уходил в ноль и
        терял ETH. Тест падал ровно этим числом: 1.0 вместо 0.5.
        """
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.5, 9: 0.5})
        await self.run_event(
            raw_event(
                market_id=8,
                is_increase=False,
                size_delta=0.5,
                leader_position_before=0.5,
                leader_equity_usd=50000.0,
            ),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reduce_only"], 1)
        self.assertAlmostEqual(
            rows[0]["base_amount"],
            0.5,
            msg="reduce ограничен позицией в рынке 8, а не суммой BTC+ETH",
        )

    async def test_paused_follower_is_not_mirrored(self):
        follower_id = await self.add_follower(1000.0)
        await db.set_paused(self.follow_ids[follower_id], True)
        await self.run_event(
            raw_event(),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
        )
        self.assertEqual(await self.mirror_log(follower_id), [])

    async def test_margin_cap_uses_the_venue_number(self):
        """Заявка подписчика — не обеспеченная маржа. Без числа от Lighter кап
        `маржа × max_leverage` стоит на том, что человек вписал себе сам, и
        план на $50-аккаунт выходился бы на $20 000: биржа такой ордер отклонит,
        а подпись к нему уже стоит реальных денег и реального проскальзывания.

        Арифметика ряда: доля риска лидера 0.5×2000/50000 = 2%, desired = 2% от
        заявленной $1 000 000 = $20 000, кап от марки Lighter = 200×5 = $1 000,
        base_amount = 1000/2000 = 0.5 (без капа было бы 10.0)."""
        follower_id = await self.add_follower(1_000_000.0)
        self.margin_by_index[900] = 200.0
        await self.run_event(
            raw_event(),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual([r["status"] for r in rows], ["dry_run"])
        self.assertAlmostEqual(rows[0]["base_amount"], 0.5)

    async def test_follower_without_verified_margin_is_skipped_by_name(self):
        """Ни аккаунта, ни средств — подписчик не зеркалится, и в журнале это
        называется отдельно от «не хватило на минимальный ордер»: у отказов разные
        последствия для человека, и «no_key» тут было бы неправдой."""
        follower_id = await self.add_follower(1000.0)
        self.margin_by_index[900] = None
        await self.run_event(
            raw_event(),
            MarketConstraints(min_base_amount=0.001, size_decimals=3, price_decimals=2),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "skipped")
        self.assertEqual(rows[0]["reason"], "margin_unverified")
        self.assertEqual(rows[0]["base_amount"], 0)


class TestOrderLimitPrice(unittest.IsolatedAsyncioTestCase):
    """IOC-лимит строится от mark-цены, а не от цены входа лидера.

    Цена события — это avg_entry_price лидера. Для закрытия убыточной позиции
    она стоит по другую сторону книги: лонг, вошедший по 2000 при рынке 1500,
    уходил sell-лимитом 2000 — такой ордер не исполнится никогда, и подписчик
    остаётся в позиции, из которой лидер уже вышел. Тот же дефект на
    наращивании: buy-лимит ниже рынка. Тест держит обе стороны и запас.

    Чтение mark-цены — async через threadpool: синхронный urllib в обработчике
    события останавливал бы event loop (и вебсокет) на таймаут каждого запроса.
    """

    def setUp(self):
        self.addCleanup(
            _patch_module(
                lighter_rest, "get_mark_price", lambda market_id, network=None: 1900.0
            )
        )

    def order(self, side, reduce_only):
        return MirrorOrder("f1", 8, side, 0.5, reduce_only)

    async def limit(self, side, reduce_only):
        mark = await leader_listener._event_mark_price(8)
        return marketable_limit_price(mark, is_buy_order(self.order(side, reduce_only)))

    async def test_losing_long_exit_is_priced_below_market(self):
        price = await self.limit(Side.LONG, True)
        self.assertLess(price, 1900.0, "sell-лимит обязан быть не выше рынка")
        self.assertAlmostEqual(price, 1881.0)

    async def test_closing_a_short_is_priced_above_market(self):
        price = await self.limit(Side.SHORT, True)
        self.assertGreater(price, 1900.0, "buy-лимит обязан быть не ниже рынка")
        self.assertAlmostEqual(price, 1919.0)

    async def test_opening_uses_the_same_market_reference(self):
        self.assertAlmostEqual(await self.limit(Side.LONG, False), 1919.0)
        self.assertAlmostEqual(await self.limit(Side.SHORT, False), 1881.0)

    async def test_missing_mark_falls_back_to_event_price(self):
        def boom(market_id, network=None):
            raise RuntimeError("нет свечей")

        self.addCleanup(_patch_module(lighter_rest, "get_mark_price", boom))
        self.assertIsNone(
            await leader_listener._event_mark_price(8),
            "без mark вызывающий обязан взять цену события как есть",
        )

    async def test_non_finite_mark_is_not_used(self):
        for bad in (float("nan"), float("inf"), 0.0, -1.0):
            self.addCleanup(
                _patch_module(
                    lighter_rest,
                    "get_mark_price",
                    lambda market_id, network=None, v=bad: v,
                )
            )
            self.assertIsNone(
                await leader_listener._event_mark_price(8), f"mark={bad!r}"
            )


class TestStreamMessage(ListenerDbCase):
    """Разбор сообщений стрима без живого соединения.

    Главный сценарий — рестарт: состояние трекера лежит в leader_tracker_state,
    и первый снапшот после перезапуска сравнивается с ним, а не с пустотой.
    """

    def constraints(self):
        return MarketConstraints(
            min_base_amount=0.001, size_decimals=3, price_decimals=2
        )

    async def test_restart_does_not_replay_existing_positions(self):
        follower_id = await self.add_follower(1000.0)
        await db.save_tracker_state(
            self.leader_id, 50000.0, {"8": {"size": 0.5, "sign": 1, "price": 2000.0}}
        )
        tracker = LeaderPositionTracker()
        tracker.restore(await db.load_tracker_state(self.leader_id))

        await leader_listener.handle_stream_message(
            _snapshot({"8": {"sign": 1, "position": "0.5", "avg_entry_price": "2000"}}),
            tracker,
            self.leader_id,
            {8: self.constraints()},
        )

        self.assertEqual(
            await self.mirror_log(follower_id),
            [],
            "позиция уже была у подписчика — рестарт не открывает её заново",
        )

    async def test_close_during_downtime_is_mirrored_after_restart(self):
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.5})
        await db.save_tracker_state(
            self.leader_id, 50000.0, {"8": {"size": 0.5, "sign": 1, "price": 2000.0}}
        )
        tracker = LeaderPositionTracker()
        tracker.restore(await db.load_tracker_state(self.leader_id))

        await leader_listener.handle_stream_message(
            _snapshot({}), tracker, self.leader_id, {8: self.constraints()}
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(len(rows), 1, "закрытие, сделанное за время простоя")
        self.assertEqual(rows[0]["reduce_only"], 1)
        self.assertAlmostEqual(rows[0]["base_amount"], 0.5)

    async def test_state_is_persisted_after_a_position_snapshot(self):
        tracker = LeaderPositionTracker()
        tracker.equity = 50000.0
        await leader_listener.handle_stream_message(
            _snapshot(
                {"8": {"sign": -1, "position": "2.0", "avg_entry_price": "3500"}}
            ),
            tracker,
            self.leader_id,
            {},
        )

        state = await db.load_tracker_state(self.leader_id)
        self.assertEqual(state["equity"], 50000.0)
        self.assertEqual(state["positions"]["8"]["size"], 2.0)
        self.assertEqual(state["positions"]["8"]["sign"], -1)

    async def test_malformed_user_stats_does_not_break_the_stream(self):
        tracker = LeaderPositionTracker()
        await leader_listener.handle_stream_message(
            {"type": "update/user_stats", "stats": {}}, tracker, self.leader_id, {}
        )
        self.assertIsNone(
            tracker.equity, "битое сообщение пропущено, а не уронило цикл"
        )

        await leader_listener.handle_stream_message(
            _user_stats("50000"), tracker, self.leader_id, {}
        )
        self.assertEqual(tracker.equity, 50000.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
