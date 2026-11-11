"""
Прогон hot path листенера копи-трейдинга на реальной схеме db.py: build_constraints()
и handle_leader_event() — две функции, которые раньше оставались единственной
непроверенной частью mirror-цикла (математика в test_mirror_engine.py, трекинг
позиций в test_leader_position_tracker.py).

Запуск: python -m unittest test_leader_listener -v
"""

import json
import sys
import types
import unittest
import uuid
from unittest import mock

import testsupport
import audit_log as al
import db
import leader_listener
import lighter_rest
from leader_position_tracker import LeaderPositionTracker
from quant import scale_to_int
from mirror_engine import (
    MAX_SLIPPAGE_BPS,
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
    decimals есть у всех строк книги, сколько бы их ни вернула площадка."""

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


def _fake_lighter(result=None, raises=None):
    """Модуль-замена `lighter`.

    Листенер импортирует его локально — в момент исполнения, а не на импорте
    файла, — и берёт ровно `SignerClient` с тремя константами. Возврат —
    (модуль, список созданных клиентов): список и есть доказательство того, до
    сети ли дошло, закрыт ли клиент и что именно ушло в `create_order`.
    Настоящий SDK здесь не нужен ни на одном из проверяемых путей."""
    clients: list = []

    class SignerClient:
        ORDER_TYPE_MARKET = 1
        ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL = 2
        DEFAULT_IOC_EXPIRY = 3

        def __init__(self, **kwargs):
            self.init = kwargs
            self.calls: list[dict] = []
            self.closed = False
            clients.append(self)

        async def create_order(self, **kwargs):
            self.calls.append(kwargs)
            if raises is not None:
                raise raises
            return result if result is not None else ({"tx": 1}, "0xtx-ok", None)

        async def close(self):
            self.closed = True

    return types.SimpleNamespace(SignerClient=SignerClient), clients


class _KeyStore:
    """Замена EncryptedKeyStore: листенеру нужен только `get_key`."""

    def __init__(self, keys: dict[str, dict] | None = None):
        self.keys = keys or {}

    def get_key(self, follower_id):
        return self.keys.get(follower_id)


KEY = {"api_key_index": 3, "private_key": "0xpriv"}


class TestKeyStoreAccess(unittest.TestCase):
    """`_key_store()` — место, где конфигурация процесса встречается с живым
    стримом. Её зовёт цикл вебсокета, и исключение здесь равносильно обрыву
    стрима: из-за одной опечатки в env зеркалирования лишились бы ВСЕ подписчики
    лидера. Контракт — `None`, а не `raise`.

    В `TestLiveExecution` `_key_store` подменён целиком, поэтому замена
    `return None` на `raise` проходила весь гейт зелёным: проверять надо саму
    функцию, а не её вызывающий код."""

    def test_store_that_cannot_open_gives_none(self):
        class _NoMasterKey:
            def __init__(self, *args, **kwargs):
                raise RuntimeError("WAKE_MASTER_KEY не задан")

        self.addCleanup(
            _patch_module(leader_listener, "EncryptedKeyStore", _NoMasterKey)
        )
        self.assertIsNone(leader_listener._key_store())

    def test_store_that_opens_is_passed_through(self):
        store = _KeyStore()
        self.addCleanup(
            _patch_module(leader_listener, "EncryptedKeyStore", lambda *a, **k: store)
        )
        self.assertIs(leader_listener._key_store(), store)


class TestLiveExecution(ListenerDbCase):
    """Живое исполнение: DRY_RUN выключен, и все пять исходов одного ордера.

    Выше листенер проверен на dry_run и на skip — то есть на путях, где до
    денег не доходит. Между тем `handle_leader_event` проводит ещё пять, и каждый
    из них был написан под конкретную аварию: недоступное хранилище ключей
    (отказ по всем подписчикам, но НЕ исключение — исключение рвёт вебсокет и
    снимает зеркалирование со всего лидера), ключа нет на конкретного подписчика
    (плюс строка в audit_log: отказ читать чужой key store должен быть виден),
    сеть упала до ответа Lighter (один ордер не роняет цикл, клиент обязан
    закрыться в `finally`), площадка отклонила ордер (размер позиции подписчика
    НЕ двигается: записав закрытие, которого не было, листенер навсегда
    разъедется с реальностью на аккаунте), и успех (`sent`, tx_hash и сдвиг
    mirror_positions на base_amount со знаком reduce).

    Ни один из этих путей нельзя проверить подменой ответа Lighter выше по
    стеку: решение «двигать учёт или нет» принимается в самом цикле, и
    проверяется оно поэтому здесь, на вызовах `db`."""

    # Mark-цена намеренно ОТЛИЧАЕТСЯ от цены события: иначе тест не отличает
    # «взять рынок» от «взять средну входа лидера», а это ровно тот дефект, из-за
    # которого IOC-лимит не исполнялся. Различимость сторожит не этот комментарий,
    # а проверка в `live` — она же не даст fixture схлопнуться обратно.
    MARK = 1900.0

    def market(self):
        return MarketConstraints(
            min_base_amount=0.001, size_decimals=3, price_decimals=2
        )

    async def live(self, event, *, store, result=None, raises=None, mark=MARK):
        """Событие при выключенном dry_run: подставные `lighter`, хранилище
        ключей и mark-цена вместо сети, всё остальное — настоящий код.

        `mark=None` — рынок без ответа (свечей нет), отдельная ветка в
        `handle_leader_event`.

        Различимость цен проверяется здесь, а не в отдельном тесте: ожидание
        цены выводилось из `MARK`, и подмена `MARK` на цену события оставляла
        всю группу зелёной, хотя ровно эта пара «рынок против события» и есть
        проверяемый дефект. Хелпер не даёт fixture тихо стать неразличимой."""
        if mark is not None and abs(mark - event["price"]) <= (
            event["price"] * MAX_SLIPPAGE_BPS / 10_000
        ):
            raise AssertionError(
                f"mark={mark} и цена события {event['price']} различаются не "
                "сильнее запаса проскальзывания — тест не отличит цену рынка от "
                "цены лидера; разведи их (MARK = 1900.0 при цене 2000.0)"
            )
        module, clients = _fake_lighter(result=result, raises=raises)
        self.addCleanup(_patch_module(leader_listener, "DRY_RUN", False))
        self.addCleanup(_patch_module(leader_listener, "_key_store", lambda: store))

        def get_mark_price(market_id, network=None):
            if mark is None:
                raise RuntimeError("нет свечей")
            return mark

        self.addCleanup(_patch_module(lighter_rest, "get_mark_price", get_mark_price))
        with mock.patch.dict(sys.modules, {"lighter": module}):
            await leader_listener.handle_leader_event(
                self.leader_id, event, self.market()
            )
        return clients

    async def mirrored(self, follow_id: str, market_id: int = 8):
        sizes = await db.mirrored_sizes_for_leader(self.leader_id)
        return sizes.get(follow_id, {}).get(market_id, 0.0)

    async def test_keystore_unavailable_is_a_row_not_an_exception(self):
        follower_id = await self.add_follower(1000.0)
        clients = await self.live(raw_event(), store=None)

        rows = await self.mirror_log(follower_id)
        self.assertEqual(
            [(r["status"], r["reason"]) for r in rows],
            [("failed", "keystore_unavailable")],
        )
        self.assertEqual(clients, [], "до Lighter не должно дойти ни запроса")

    async def test_missing_key_fails_the_order_and_is_audited(self):
        follower_id = await self.add_follower(1000.0)
        clients = await self.live(raw_event(), store=_KeyStore())

        rows = await self.mirror_log(follower_id)
        self.assertEqual(
            [(r["status"], r["reason"]) for r in rows], [("failed", "no_key")]
        )
        self.assertEqual(clients, [])
        audit = await al.recent_actions(
            actor=f"follower:{follower_id}", action="key_access_denied"
        )
        self.assertEqual(len(audit), 1)
        self.assertEqual(audit[0]["success"], 0, "отказ обязан быть записан отказом")
        self.assertEqual(audit[0]["resource"], f"follower:{follower_id}")
        self.assertEqual(json.loads(audit[0]["details"])["market_id"], 8)

    async def test_network_failure_is_logged_and_the_client_closed(self):
        follower_id = await self.add_follower(1000.0)
        clients = await self.live(
            raw_event(),
            store=_KeyStore({follower_id: KEY}),
            raises=ConnectionError("stream down"),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["reason"], "execute_error: stream down")
        self.assertEqual(len(clients), 1)
        self.assertTrue(clients[0].closed, "клиент закрывается и на отказе сети")
        self.assertEqual(await self.mirrored(self.follow_ids[follower_id]), 0.0)

    async def test_rejected_order_does_not_move_the_recorded_position(self):
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.9})
        err = {"message": "insufficient margin"}
        clients = await self.live(
            raw_event(),
            store=_KeyStore({follower_id: KEY}),
            result=({"tx": 0}, "0xtx-no", err),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["reason"], str(err))
        self.assertEqual(rows[0]["tx_hash"], "0xtx-no")
        self.assertEqual(
            await self.mirrored(self.follow_ids[follower_id]),
            0.9,
            "ордера нет — учёт подписчика не меняется",
        )
        self.assertTrue(clients[0].closed)

    def limit(self, is_buy: bool) -> int:
        """Ожидаемая цена IOC-лимита: рынок с запасом на проскальзывание, в тиках
        рынка. Выведена из `MAX_SLIPPAGE_BPS`, а не вызовом
        `marketable_limit_price`, — иначе правка самой функции стала бы правкой
        ожидания и проверка перестала бы что-либо значить."""
        slip = MAX_SLIPPAGE_BPS / 10_000
        return scale_to_int(self.MARK * (1 + slip if is_buy else 1 - slip), 2)

    async def test_success_records_the_hash_and_moves_the_size(self):
        follower_id = await self.add_follower(1000.0)
        clients = await self.live(raw_event(), store=_KeyStore({follower_id: KEY}))

        rows = await self.mirror_log(follower_id)
        self.assertEqual(rows[0]["status"], "sent")
        self.assertEqual(rows[0]["tx_hash"], "0xtx-ok")
        self.assertIsNone(rows[0]["reason"])
        self.assertAlmostEqual(
            await self.mirrored(self.follow_ids[follower_id]), rows[0]["base_amount"]
        )
        client = clients[0]
        self.assertEqual(client.init["api_private_keys"], {3: "0xpriv"})
        self.assertEqual(client.init["account_index"], 900)
        call = client.calls[0]
        # Ожидание выведено из той же строки журнала, что и план: 10 здесь было бы
        # числом из головы, а сверка с base_amount держит масштаб одним фактом.
        self.assertEqual(call["base_amount"], scale_to_int(rows[0]["base_amount"], 3))
        self.assertEqual(call["market_index"], 8)
        self.assertFalse(call["is_ask"], "открытие лонга — это buy")
        self.assertFalse(call["reduce_only"])
        self.assertEqual(call["order_type"], client.ORDER_TYPE_MARKET)
        self.assertEqual(
            call["time_in_force"], client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL
        )
        self.assertEqual(
            call["price"],
            self.limit(True),
            "цена = mark + запас MAX_SLIPPAGE_BPS, а не цена события и не сам "
            "mark без запаса; различимость этих двух держит проверка в `live`",
        )
        self.assertNotIn(
            "account_index", call, "index уходит в конструктор, а не в create_order"
        )
        self.assertTrue(client.closed)

    async def test_close_is_priced_below_market_in_the_sent_order(self):
        """Закрытие лонга уходит sell-лимитом НИЖЕ рынка — ровно тем ордером,
        который раньше не исполнялся никогда: от цены входа лидера sell стоял
        выше книги, подписчик оставался в позиции, из которой лидер вышел."""
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.5})
        clients = await self.live(
            raw_event(is_increase=False, size_delta=0.4, leader_position_before=0.5),
            store=_KeyStore({follower_id: KEY}),
        )

        call = clients[0].calls[0]
        self.assertTrue(call["is_ask"])
        self.assertEqual(call["price"], self.limit(False))

    async def test_order_without_a_market_price_falls_back_to_event_price(self):
        """Ветки `mark is None` без теста не существует: листенер обязан остаться
        исполнимым, а не бросить исключение в цикл вебсокета, и цена тогда
        берётся из события как есть, без запаса."""
        follower_id = await self.add_follower(1000.0)
        event = raw_event()
        clients = await self.live(event, store=_KeyStore({follower_id: KEY}), mark=None)

        rows = await self.mirror_log(follower_id)
        self.assertEqual(rows[0]["status"], "sent", "нет рынка — ордер всё равно идёт")
        self.assertEqual(
            clients[0].calls[0]["price"],
            scale_to_int(event["price"], 2),
            "без рынка запас брать не от чего — цена события как есть",
        )

    async def test_two_live_orders_never_share_a_client_order_index(self):
        """client_order_index — по нему ордер ищется в Lighter. `time-ms % 1e6`
        из прошлой реализации сталкивался на горизонте часа, и два разных
        замысла становились неразличимы: ни сверка, ни отмена по индексу не
        знают, который из них какой. Здесь два подписчика на
        одно событие: индексы разные, клиенты закрыты, и каждый индекс остаётся
        под границей 2**31, которую задал `build_order_args`."""
        first = await self.add_follower(1000.0)
        second = await self.add_follower(2000.0)
        clients = await self.live(
            raw_event(), store=_KeyStore({first: KEY, second: KEY})
        )

        indexes = [
            call["client_order_index"] for client in clients for call in client.calls
        ]
        self.assertEqual(len(indexes), 2, "по ордеру на каждого подписчика")
        self.assertEqual(len(set(indexes)), 2, f"индексы совпали: {indexes}")
        self.assertTrue(
            all(client.closed for client in clients),
            "SignerClient создаётся на ордер — и на ордер обязан закрываться",
        )
        for index in indexes:
            self.assertTrue(0 <= index < 2**31, f"{index} вышел за 31 бит")

    async def test_reduce_decreases_the_recorded_position(self):
        follower_id = await self.add_follower(1000.0, mirrored={8: 0.9})
        clients = await self.live(
            raw_event(is_increase=False, size_delta=0.4, leader_position_before=0.5),
            store=_KeyStore({follower_id: KEY}),
        )

        rows = await self.mirror_log(follower_id)
        self.assertEqual(rows[0]["status"], "sent")
        self.assertEqual(rows[0]["reduce_only"], 1)
        self.assertAlmostEqual(
            await self.mirrored(self.follow_ids[follower_id]),
            0.9 - rows[0]["base_amount"],
            "закрытие вычитает размер, а не прибавляет",
        )
        call = clients[0].calls[0]
        self.assertTrue(call["reduce_only"])
        self.assertTrue(call["is_ask"], "закрытие лонга — это sell")


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
