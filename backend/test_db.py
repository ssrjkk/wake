"""python -m unittest test_db -v

Прогон db.py на реальной PostgreSQL: foreign keys, upsert'ы, pause-фильтр и
ФОРМА ответа, на которую завязан фронт (created_at — epoch числом, paused —
0/1). Форму проверяем здесь, а не в HTTP-слое, потому что она рождается именно
в этом слое.
"""

import unittest
import uuid

import testsupport
import db

_run = testsupport.run


class DbCase(unittest.TestCase):
    def setUp(self):
        testsupport.reset()
        self.leader_id = "leader-1"
        _run(db.upsert_leader(self.leader_id, 42, "@driftking", fee_bps=10))

    def add_follower(self, n: int, **kwargs) -> str:
        follower_id = f"f{n}"
        _run(
            db.upsert_follower(
                follower_id,
                l1_address=f"0xabc...{n}",
                lighter_account_index=100 + n,
                **kwargs,
            )
        )
        return follower_id

    def follow(
        self, follower_id: str, allocation_usd: float, max_leverage: float = 3
    ) -> str:
        follow_id = str(uuid.uuid4())
        _run(
            db.create_follow(
                follow_id, follower_id, self.leader_id, allocation_usd, max_leverage
            )
        )
        return follow_id


class TestFollowersAndLeaders(DbCase):
    def test_l1_lookup_roundtrip(self):
        follower_id = self.add_follower(1)
        self.assertEqual(
            _run(db.follower_by_l1("0xabc...1")),
            {"id": follower_id, "lighter_account_index": 101, "telegram_id": None},
        )
        self.assertIsNone(_run(db.follower_by_l1("0xнет-такого")))

    def test_upsert_updates_handle_and_fee_but_keeps_created_at(self):
        created_before = next(
            r for r in _run(db.all_leaders()) if r["id"] == self.leader_id
        )["created_at"]
        _run(db.upsert_leader(self.leader_id, 42, "@renamed", fee_bps=25))
        row = next(r for r in _run(db.all_leaders()) if r["id"] == self.leader_id)
        self.assertEqual((row["handle"], row["fee_bps"]), ("@renamed", 25))
        self.assertEqual(
            row["created_at"],
            created_before,
            "время регистрации лидера — часть его публичной карточки в Discover",
        )

    def test_upsert_follower_does_not_erase_existing_links(self):
        follower_id = self.add_follower(1, telegram_id=777)
        self.assertEqual(_run(db.follower_by_l1("0xabc...1"))["telegram_id"], 777)
        _run(db.upsert_follower(follower_id, "0xabc...1", lighter_account_index=101))
        row = _run(db.follower_by_l1("0xabc...1"))
        self.assertEqual(
            row["telegram_id"],
            777,
            "вход через кошелёк не должен отвязывать Telegram-аккаунт",
        )
        self.assertEqual(row["lighter_account_index"], 101)

    def test_leader_by_account_index(self):
        self.assertEqual(_run(db.leader_by_account_index(42)), {"id": self.leader_id})
        self.assertIsNone(_run(db.leader_by_account_index(4242)))
        self.assertEqual(_run(db.leader(self.leader_id))["handle"], "@driftking")
        self.assertIsNone(_run(db.leader("nope")))


class TestFollows(DbCase):
    def test_active_follows_excludes_paused(self):
        f1, f2 = self.add_follower(1), self.add_follower(2)
        self.follow(f1, 1000, max_leverage=5)
        follow2 = self.follow(f2, 500)

        rows = _run(db.active_follows_for_leader(self.leader_id))
        self.assertEqual(len(rows), 2)
        by_follower = {r["follower_id"]: r for r in rows}
        self.assertEqual(set(by_follower), {f1, f2}, "оба подписчика должны быть видны")
        self.assertEqual(by_follower[f1]["follower_account_index"], 101)

        _run(db.set_paused(follow2, True))
        rows = _run(db.active_follows_for_leader(self.leader_id))
        self.assertEqual([r["follower_id"] for r in rows], [f1])

        _run(db.set_paused(follow2, False))
        self.assertEqual(len(_run(db.active_follows_for_leader(self.leader_id))), 2)

    def test_response_shape_is_the_wire_contract(self):
        follow_id = self.follow(self.add_follower(1), 1000)
        row = next(
            r
            for r in _run(db.follows_for_leader(self.leader_id))
            if r["id"] == follow_id
        )
        self.assertIn(row["paused"], (0, 1), "фронт читает paused как число")
        self.assertIsInstance(row["created_at"], float)
        self.assertGreater(
            row["created_at"], 1_000_000_000, "epoch-секунды, не микросекунды"
        )

    def test_mirrored_size_is_persisted(self):
        follow_id = self.follow(self.add_follower(1), 1000)
        _run(db.update_mirrored_size(follow_id, 0.05))
        row = _run(db.owned_follow(follow_id, "f1"))
        self.assertAlmostEqual(row["current_mirrored_size"], 0.05)

    def test_duplicate_follow_of_the_same_leader_is_rejected(self):
        f1 = self.add_follower(1)
        self.follow(f1, 1000)
        from sqlalchemy.exc import IntegrityError

        with self.assertRaises(IntegrityError):
            _run(db.create_follow(str(uuid.uuid4()), f1, self.leader_id, 500))

    def test_follow_to_unknown_leader_is_rejected_by_foreign_key(self):
        from sqlalchemy.exc import IntegrityError

        with self.assertRaises(IntegrityError):
            _run(db.create_follow(str(uuid.uuid4()), "f1", "нет-такого-лидера", 100))

    def test_ownership_and_delete(self):
        f1, f2 = self.add_follower(1), self.add_follower(2)
        follow_id = self.follow(f1, 1000)
        self.assertIsNotNone(_run(db.owned_follow(follow_id, f1)))
        self.assertIsNone(
            _run(db.owned_follow(follow_id, f2)), "чужая подписка не должна читаться"
        )
        self.assertFalse(
            _run(db.delete_follow(follow_id, f2)),
            "удаление чужой подписки — False, не исключение и не 200 вслепую",
        )
        self.assertTrue(_run(db.delete_follow(follow_id, f1)))
        self.assertFalse(
            _run(db.delete_follow(follow_id, f1)), "второе удаление — уже нет"
        )

    def test_follows_for_follower_carries_leader_handle(self):
        f1 = self.add_follower(1)
        self.follow(f1, 1000)
        rows = _run(db.follows_for_follower(f1))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["leader_handle"], "@driftking")


class TestMirrorLog(DbCase):
    def test_log_rows_are_scoped_to_the_follower(self):
        f1, f2 = self.add_follower(1), self.add_follower(2)
        follow1, follow2 = self.follow(f1, 1000), self.follow(f2, 1000)

        _run(
            db.log_mirror_result(
                str(uuid.uuid4()), follow1, 0, "long", 0.05, False, "dry_run"
            )
        )
        _run(
            db.log_mirror_result(
                str(uuid.uuid4()),
                follow2,
                8,
                "short",
                0.0,
                True,
                "skipped",
                reason="allocation_too_small",
            )
        )

        rows = _run(db.mirror_log_for_follower(f1, limit=50))
        self.assertEqual(
            len(rows), 1, "журнал чужой подписки виден только её владельцу"
        )
        self.assertEqual(rows[0]["status"], "dry_run")
        self.assertEqual(rows[0]["leader_handle"], "@driftking")
        self.assertIn(rows[0]["reduce_only"], (0, 1))

        other = _run(db.mirror_log_for_follower(f2, limit=50))
        self.assertEqual([r["reason"] for r in other], ["allocation_too_small"])

    def test_limit_is_applied_from_the_newest(self):
        follow_id = self.follow(self.add_follower(1), 1000)
        for i in range(3):
            _run(
                db.log_mirror_result(
                    str(uuid.uuid4()), follow_id, i, "long", 0.1, False, "dry_run"
                )
            )
        # Сравниваем с полным чтением, а не с порядком вставки: разрешение часов
        # на Windows — ~15 мс, три записи подряд легко получают один created_at,
        # и «самая новая» среди равных — вопрос устойчивости сортировки, а не
        # времени. Проверка ниже фиксирует именно это.
        full = _run(db.mirror_log_for_follower("f1", limit=50))
        limited = _run(db.mirror_log_for_follower("f1", limit=2))
        self.assertEqual(len(limited), 2)
        self.assertEqual(limited, full[:2], "лимит режет хвост, а не начало")
        self.assertEqual(
            limited[0]["created_at"],
            max(r["created_at"] for r in full),
            "первой идёт самая свежая запись",
        )
        self.assertEqual(
            _run(db.mirror_log_for_follower("f1", limit=2)),
            limited,
            "равные метки времени не должны менять порядок между двумя чтениями",
        )

    def test_log_requires_existing_follow(self):
        from sqlalchemy.exc import IntegrityError

        with self.assertRaises(IntegrityError):
            _run(
                db.log_mirror_result(
                    str(uuid.uuid4()),
                    "нет-такой-подписки",
                    0,
                    "long",
                    0.1,
                    False,
                    "sent",
                )
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
