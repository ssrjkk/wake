"""python3 -m unittest test_stripe_billing -v — не требует stripe, тестирует apply_event()"""

import unittest
from stripe_billing import apply_event
from subscription import Subscription, Tier, start_trial


class TestCheckoutCompleted(unittest.TestCase):
    def test_upgrades_existing_trial_subscription_to_pro(self):
        subs = {"alice": start_trial("alice", now=1000)}
        result = apply_event("checkout.session.completed", {"client_reference_id": "alice"}, subs)
        self.assertEqual(result["status"], "upgraded")
        self.assertEqual(subs["alice"].tier, Tier.PRO)

    def test_creates_new_pro_subscription_for_unknown_user(self):
        subs = {}
        result = apply_event("checkout.session.completed", {"client_reference_id": "bob"}, subs)
        self.assertEqual(result["status"], "upgraded")
        self.assertEqual(subs["bob"].tier, Tier.PRO)

    def test_ignores_event_without_client_reference_id(self):
        subs = {}
        result = apply_event("checkout.session.completed", {}, subs)
        self.assertEqual(result["status"], "ignored")
        self.assertEqual(len(subs), 0)


class TestSubscriptionDeleted(unittest.TestCase):
    def test_downgrades_known_user_to_free(self):
        subs = {"alice": Subscription(user_id="alice", tier=Tier.PRO, started_at=1000)}
        result = apply_event("customer.subscription.deleted", {"client_reference_id": "alice"}, subs)
        self.assertEqual(result["status"], "downgraded")
        self.assertEqual(subs["alice"].tier, Tier.FREE)

    def test_ignores_deletion_for_unknown_user(self):
        subs = {}
        result = apply_event("customer.subscription.deleted", {"client_reference_id": "ghost"}, subs)
        self.assertEqual(result["status"], "ignored")

    def test_downgrade_preserves_original_started_at_not_reset(self):
        subs = {"alice": Subscription(user_id="alice", tier=Tier.PRO, started_at=555)}
        apply_event("customer.subscription.deleted", {"client_reference_id": "alice"}, subs)
        self.assertEqual(subs["alice"].started_at, 555)


class TestUnknownEventTypes(unittest.TestCase):
    def test_unknown_event_type_ignored_without_error(self):
        subs = {}
        result = apply_event("some.other.event", {}, subs)
        self.assertEqual(result["status"], "ignored")
        self.assertEqual(result["type"], "some.other.event")


if __name__ == "__main__":
    unittest.main(verbosity=2)
