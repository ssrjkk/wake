"""python -m unittest test_audit_log -v

audit_log.py на реальной PostgreSQL: фильтра по actor/action, поиск неудач,
details как JSON и форма ответа (timestamp — epoch числом, success — 0/1), на
которую завязан фронт.
"""

import json
import time
import unittest

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

    def test_failed_actions_since(self):
        failed = _run(al.failed_actions_since(since_timestamp=0))
        self.assertEqual([r["actor"] for r in failed], ["user:mallory"])
        self.assertEqual(
            len(_run(al.failed_actions_since(since_timestamp=time.time() + 60))),
            0,
            "окно в будущем не должно ничего находить",
        )

    def test_limit_trims_from_the_newest(self):
        full = _run(al.recent_actions(limit=100))
        limited = _run(al.recent_actions(limit=2))
        self.assertEqual(limited, full[:2])

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
