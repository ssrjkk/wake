"""python3 -m unittest test_subscription -v"""

import unittest
from subscription import start_trial, upgrade_to_pro, Tier, TRIAL_DURATION_DAYS


class TestTrial(unittest.TestCase):
    def test_trial_unlocks_full_features_immediately(self):
        sub = start_trial("u1", now=1000)
        self.assertTrue(sub.has_feature("ai_agent", now=1000))
        self.assertTrue(sub.has_feature("copy_trading", now=1000))
        self.assertTrue(sub.has_feature("predict_markets", now=1000))

    def test_trial_not_expired_mid_period(self):
        sub = start_trial("u1", now=1000)
        halfway = 1000 + (TRIAL_DURATION_DAYS * 86400) / 2
        self.assertFalse(sub.is_trial_expired(now=halfway))
        self.assertTrue(sub.has_feature("ai_agent", now=halfway))

    def test_trial_expires_after_duration(self):
        sub = start_trial("u1", now=1000)
        after = 1000 + (TRIAL_DURATION_DAYS + 1) * 86400
        self.assertTrue(sub.is_trial_expired(now=after))

    def test_expired_trial_loses_pro_features_but_keeps_free_ones(self):
        sub = start_trial("u1", now=1000)
        after = 1000 + (TRIAL_DURATION_DAYS + 1) * 86400
        self.assertFalse(sub.has_feature("ai_agent", now=after))
        self.assertFalse(sub.has_feature("copy_trading", now=after))
        self.assertTrue(
            sub.has_feature("terminal_view", now=after),
            "бесплатный терминал должен остаться доступен",
        )

    def test_days_left_counts_down_correctly(self):
        sub = start_trial("u1", now=0)
        left = sub.days_left_in_trial(now=5 * 86400)
        self.assertAlmostEqual(left, TRIAL_DURATION_DAYS - 5, places=6)

    def test_days_left_never_negative(self):
        sub = start_trial("u1", now=0)
        left = sub.days_left_in_trial(now=(TRIAL_DURATION_DAYS + 100) * 86400)
        self.assertEqual(left, 0.0)


class TestUpgrade(unittest.TestCase):
    def test_upgrade_grants_pro_features_after_trial_expired(self):
        sub = start_trial("u1", now=1000)
        after_expiry = 1000 + (TRIAL_DURATION_DAYS + 1) * 86400
        self.assertFalse(sub.has_feature("ai_agent", now=after_expiry))

        pro = upgrade_to_pro(sub, now=after_expiry)
        self.assertTrue(pro.has_feature("ai_agent", now=after_expiry))
        self.assertTrue(
            pro.has_feature("priority_execution", now=after_expiry),
            "priority_execution только у pro, не у trial",
        )

    def test_upgrade_does_not_mutate_original(self):
        sub = start_trial("u1", now=1000)
        pro = upgrade_to_pro(sub, now=2000)
        self.assertEqual(
            sub.tier, Tier.FREE_TRIAL, "апгрейд не должен мутировать исходный объект"
        )
        self.assertEqual(pro.tier, Tier.PRO)

    def test_pro_never_expires_like_trial_does(self):
        sub = start_trial("u1", now=0)
        pro = upgrade_to_pro(sub, now=100)
        far_future = 100 + 10_000 * 86400
        self.assertTrue(pro.has_feature("ai_agent", now=far_future))


class TestFreeTier(unittest.TestCase):
    def test_free_tier_only_has_basic_features(self):
        from subscription import Subscription

        sub = Subscription(user_id="u1", tier=Tier.FREE, started_at=0)
        self.assertTrue(sub.has_feature("terminal_view"))
        self.assertFalse(sub.has_feature("ai_agent"))
        self.assertFalse(sub.has_feature("predict_markets"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
