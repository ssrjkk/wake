"""python -m unittest test_audit_log -v

audit_log.py на реальной PostgreSQL: фильтра по actor/action/неудачам и окну
времени, потолок выборки, details как JSON и форма ответа (timestamp — epoch
числом, success — 0/1), на которую завязан фронт. Отдельно — обещание из
докстринга log_action: сбой записи (и базы, и сериализации) не превращается в
500 на уже исполненную сделку.
"""

import json
import logging
import time
import unittest
from decimal import Decimal

import testsupport
import audit_log as al


_run = testsupport.run


class AuditCase(unittest.TestCase):
    def setUp(self):
        testsupport.reset()
        for entry in (
            al.AuditEntry(
                actor="user:alice", action="key_access", resource="follower_alice"
            ),
            al.AuditEntry(
                actor="user:bob",
                action="trade_executed",
                resource="market_1",
                details={"shares": 10},
            ),
            al.AuditEntry(
                actor="user:mallory",
                action="key_access",
                resource="follower_alice",
                success=False,
                details={"reason": "wrong_key"},
            ),
        ):
            _run(al.log_action(entry))

    def row(self, actor):
        return next(r for r in _run(al.recent_actions()) if r["actor"] == actor)


class TestQueries(AuditCase):
    def test_filters_by_actor_and_action(self):
        self.assertEqual(len(_run(al.recent_actions())), 3)
        self.assertEqual(len(_run(al.recent_actions(actor="user:alice"))), 1)
        self.assertEqual(len(_run(al.recent_actions(action="key_access"))), 2)
        self.assertEqual(
            len(_run(al.recent_actions(actor="user:mallory", action="key_access"))),
            1,
            "оба фильтра должны сужать выборку, а не применяться по одному",
        )

    def test_failed_only_is_a_filter_not_a_second_function(self):
        """Слияние readers: раньше «неудачи» была отдельной функцией без actor,
        без action и без limit, и оператор, который ищет перебор по одному
        аккаунту, получал сначала все отказы за всё время."""
        failed = _run(al.recent_actions(failed_only=True))
        self.assertEqual([r["actor"] for r in failed], ["user:mallory"])
        self.assertEqual(
            _run(al.recent_actions(failed_only=True, actor="user:alice")),
            [],
            "фильтр неудач не должен перекрывать фильтр по актору",
        )

    def test_since_windows_the_read(self):
        self.assertEqual(len(_run(al.recent_actions(since=0))), 3)
        self.assertEqual(
            len(_run(al.recent_actions(since=time.time() + 60))),
            0,
            "окно в будущем не должно ничего находить",
        )

    def test_limit_trims_from_the_newest(self):
        full = _run(al.recent_actions(limit=100))
        limited = _run(al.recent_actions(limit=2))
        self.assertEqual(limited, full[:2])

    def test_limit_is_a_ceiling_not_a_suggestion(self):
        """MAX_ROWS — граница объёма памяти процесса: вызывающий код передаёт
        число из запроса клиента, и без потолка limit=10**6 означал бы выгрузку
        всей таблицы."""
        self.assertEqual(al._bounded(10**6), al.MAX_ROWS)
        self.assertEqual(al._bounded(0), 1)
        self.assertEqual(al._bounded(-5), 1)
        self.assertEqual(al._bounded(7), 7)

    def test_wire_contract_shape(self):
        row = self.row("user:bob")
        self.assertEqual(row["success"], 1, "фронт читает success как число")
        self.assertIsInstance(row["timestamp"], float)
        self.assertGreater(row["timestamp"], 1_000_000_000, "epoch-секунды")
        self.assertEqual(json.loads(row["details"])["shares"], 10)

    def test_details_absent_stays_absent(self):
        self.assertIsNone(self.row("user:alice")["details"])

    def test_order_is_newest_first(self):
        rows = _run(al.recent_actions())
        self.assertEqual(
            [r["timestamp"] for r in rows],
            sorted((r["timestamp"] for r in rows), reverse=True),
        )


class TestAuditFailureDoesNotBreakRequest(unittest.TestCase):
    """Аудит пишется ПОСЛЕ изменения денег. Моргнувшая база не имеет права
    превращать успешную сделку в 500 — клиент повторил бы запрос и получил бы
    вторую сделку вместо одной.

    Ломаться может и сам слой записи (async_session_factory), и подготовка
    строки к ней (сериализация details): обе ветки обязаны кончиться ERROR в лог,
    а не исключением у вызывающего кода."""

    def test_write_failure_is_logged_and_swallowed(self):
        original = al.async_session_factory
        al.async_session_factory = lambda: _broken_session()
        self.addCleanup(setattr, al, "async_session_factory", original)
        records = _capture("wake.audit")
        try:
            _run(
                al.log_action(
                    al.AuditEntry(
                        actor="user:carol",
                        action="trade_executed",
                        resource="market_9",
                        details={"shares": 3},
                    )
                )
            )
        finally:
            records.stop()

        self.assertEqual(len(records.records), 1, "одно падение — одна запись в лог")
        line = records.records[0].getMessage()
        self.assertIn("trade_executed", line)
        self.assertIn("user:carol", line)
        self.assertIn("market_9", line, "событие должно восстанавливаться из лога")

    def test_unserialisable_details_are_stored_not_dropped(self):
        """Decimal — обычный тип для денег в моделях SQLAlchemy, и положить его в
        details проще простого. Раньше json.dumps без default стоял ДО try, и
        такой вызов ронял TypeError'ом тот самый запрос, который уже отдал деньги.

        default=str — условие того, что событие доживает до таблицы: лог процесса
        ротируется, а разбор «кому сколько выплатили» не может на него опираться.
        Число становится строкой — это цена за то, что строка вообще есть."""
        testsupport.reset()
        records = _capture("wake.audit")
        try:
            _run(
                al.log_action(
                    al.AuditEntry(
                        actor="user:dave",
                        action="predict_claim",
                        resource="market_3",
                        details={"payout_usd": Decimal("12.50")},
                    )
                )
            )
        finally:
            records.stop()

        self.assertEqual(records.records, [], "запись прошла — в логе делать нечего")
        rows = _run(al.recent_actions(actor="user:dave"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            json.loads(rows[0]["details"])["payout_usd"],
            "12.50",
            "сумма читается, а не съедена сериализатором",
        )

    def test_failure_after_serialisation_is_logged_and_swallowed(self):
        """То, что не смог сериализатор (циклическая ссылка — ValueError внутри
        json.dumps), обязано кончиться так же, как моргнувшая база: ERROR в лог и
        ничего не долетает до вызывающего кода. Прежний try этого не видел вовсе."""
        testsupport.reset()
        circular: dict = {}
        circular["self"] = circular
        records = _capture("wake.audit")
        try:
            _run(
                al.log_action(
                    al.AuditEntry(
                        actor="user:eve",
                        action="market_resolution",
                        resource="market_4",
                        details=circular,
                    )
                )
            )
        finally:
            records.stop()

        self.assertEqual(len(records.records), 1)
        self.assertEqual(records.records[0].levelno, logging.ERROR)
        self.assertIn(
            "market_resolution",
            records.records[0].getMessage(),
            "событие восстанавливается из лога",
        )
        self.assertEqual(
            _run(al.recent_actions(actor="user:eve")),
            [],
            "в таблицу разорванное событие не попало",
        )


def _broken_session():
    class _Boom:
        async def __aenter__(self):
            raise RuntimeError("база легла")

        async def __aexit__(self, *exc):
            return False

        def add(self, row):
            pass

        async def commit(self):
            pass

    return _Boom()


def _capture(name: str):
    class Collect(logging.Handler):
        def __init__(self):
            super().__init__()
            self.records = []

        def emit(self, record):
            self.records.append(record)

    logger = logging.getLogger(name)
    old_level, old_handlers = logger.level, logger.handlers
    logger.setLevel(logging.DEBUG)
    collector = Collect()
    logger.addHandler(collector)

    def stop():
        logger.removeHandler(collector)
        logger.setLevel(old_level)
        logger.handlers = old_handlers
        return collector

    collector.stop = stop  # type: ignore[attr-defined]
    return collector


if __name__ == "__main__":
    unittest.main(verbosity=2)
