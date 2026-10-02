"""python3 test_audit_log.py"""

import os
import tempfile
import audit_log as al

# tempfile вместо зашитого /tmp — на Windows такой путь не создаётся.
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="wake-audit-"), "audit.db")

al.init_audit_db(TEST_DB)

with al.connect(TEST_DB) as conn:
    al.log_action(conn, al.AuditEntry(actor="user:alice", action="key_access", resource="follower_alice", success=True))
    al.log_action(conn, al.AuditEntry(actor="user:bob", action="trade_executed", resource="market_1", details={"shares": 10}, success=True))
    al.log_action(conn, al.AuditEntry(actor="user:mallory", action="key_access", resource="follower_alice", success=False, details={"reason": "wrong_key"}))

with al.connect(TEST_DB) as conn:
    assert len(al.recent_actions(conn)) == 3
    assert len(al.recent_actions(conn, actor="user:alice")) == 1
    assert len(al.recent_actions(conn, action="key_access")) == 2
    failed = al.failed_actions_since(conn, since_timestamp=0)
    assert len(failed) == 1 and failed[0]["actor"] == "user:mallory"
    import json
    mallory_row = [r for r in al.recent_actions(conn) if r["actor"] == "user:mallory"][0]
    assert json.loads(mallory_row["details"])["reason"] == "wrong_key"

os.remove(TEST_DB)
print("audit_log.py: запись, фильтры по actor/action, поиск неудач, JSON details — все подтверждены")
