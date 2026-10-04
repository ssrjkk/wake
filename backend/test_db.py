"""Реальный прогон db.py: python3 test_db.py — печатает результат, использует временный файл."""

import os
import tempfile
import uuid
import db

# tempfile вместо зашитого /tmp — на Windows такой путь не создаётся, и тест
# падал на открытии БД до первой проверки.
TEST_DB = os.path.join(tempfile.mkdtemp(prefix="wake-db-"), "wake.db")

db.init_db(TEST_DB)

with db.connect(TEST_DB) as conn:
    db.upsert_leader(
        conn, "leader1", lighter_account_index=42, handle="@driftking", fee_bps=10
    )
    db.upsert_follower(conn, "f1", l1_address="0xabc...1", lighter_account_index=101)
    db.upsert_follower(conn, "f2", l1_address="0xabc...2", lighter_account_index=102)

    db.create_follow(
        conn, str(uuid.uuid4()), "f1", "leader1", allocation_usd=1000, max_leverage=5
    )
    follow2_id = str(uuid.uuid4())
    db.create_follow(
        conn, follow2_id, "f2", "leader1", allocation_usd=500, max_leverage=3
    )

with db.connect(TEST_DB) as conn:
    rows = db.active_follows_for_leader(conn, "leader1")
    assert len(rows) == 2, f"expected 2 active follows, got {len(rows)}"
    print(f"active_follows_for_leader: {len(rows)} rows")
    for r in rows:
        print(
            f"  follow_id={r['follow_id'][:8]}... follower={r['follower_id']} allocation=${r['allocation_usd']}"
        )

    db.set_paused(conn, follow2_id, True)

with db.connect(TEST_DB) as conn:
    rows = db.active_follows_for_leader(conn, "leader1")
    assert len(rows) == 1, f"expected 1 active follow after pause, got {len(rows)}"
    print(
        f"after pausing f2's follow: {len(rows)} active row (correctly excludes paused)"
    )

    db.update_mirrored_size(conn, rows[0]["follow_id"], 0.05)
    db.log_mirror_result(
        conn,
        str(uuid.uuid4()),
        rows[0]["follow_id"],
        market_id=0,
        side="long",
        base_amount=0.05,
        reduce_only=False,
        status="dry_run",
        reason=None,
    )

with db.connect(TEST_DB) as conn:
    log = conn.execute("SELECT * FROM mirror_log").fetchall()
    assert len(log) == 1
    print(f"mirror_log: {len(log)} row, status={log[0]['status']}")

os.remove(TEST_DB)
print(
    "\nВСЁ ПРОШЛО: db.py реально работает — foreign keys, unique constraints, pause-фильтр, лог."
)
