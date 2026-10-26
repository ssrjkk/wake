"""python3 -m unittest test_subscription -v"""

import unittest
from subscription import (
    FEATURES,
    TRIAL_DURATION_DAYS,
    Tier,
    start_trial,
    upgrade_to_pro,
)


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

        pro = upgrade_to_pro(sub)
        self.assertTrue(pro.has_feature("ai_agent", now=after_expiry))
        self.assertFalse(
            pro.is_trial_expired(now=after_expiry),
            "pro не подчиняется границе трайла — срок касается только free_trial",
        )
        # Совпадение множеств — это факт текущей модели, а не случайность: после
        # того как из pro убрали "priority_execution" (функцию не читал ни один
        # эндпоинт), трайл и pro дают ОДНАКОВЫЕ права, и отличаются только
        # длительностью. Тест заставляет сказать это вслух: следующая платная
        # фича обязана появиться здесь явно, а не «как-нибудь на фронте».
        self.assertEqual(FEATURES[Tier.PRO], FEATURES[Tier.FREE_TRIAL])

    def test_upgrade_does_not_mutate_original(self):
        sub = start_trial("u1", now=1000)
        pro = upgrade_to_pro(sub)
        self.assertEqual(
            sub.tier, Tier.FREE_TRIAL, "апгрейд не должен мутировать исходный объект"
        )
        self.assertEqual(pro.tier, Tier.PRO)

    def test_upgrade_keeps_the_subscription_clock(self):
        """started_at и trial_started_at апгрейд не трогает: подписка не
        начинается заново от того, что человек доплатил. Обнулённый started_at
        стёр бы разницу между трёхлетним клиентом и вчерашним — и по base, и по
        этой функции."""
        sub = start_trial("u1", now=1000)
        pro = upgrade_to_pro(sub)
        self.assertEqual(pro.started_at, 1000)
        self.assertEqual(pro.trial_started_at, 1000)

    def test_pro_never_expires_like_trial_does(self):
        sub = start_trial("u1", now=0)
        pro = upgrade_to_pro(sub)
        far_future = 10_000 * 86400
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
