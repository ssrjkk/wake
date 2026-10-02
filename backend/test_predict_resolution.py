"""python3 -m unittest test_predict_resolution -v"""

import os
import tempfile
import unittest

# config читает env при импорте, поэтому временная audit-база задаётся до
# импорта predict_resolution: иначе тест дописывает строки в dev audit.db.
_tmp_dir = tempfile.mkdtemp(prefix="wake-resolution-audit-")
os.environ.setdefault("WAKE_AUDIT_DB_PATH", os.path.join(_tmp_dir, "audit.db"))

import audit_log as al  # noqa: E402
from config import AUDIT_DB_PATH  # noqa: E402
from predict_resolution import resolve_price_market, resolve_event_market, Comparator  # noqa: E402

al.init_audit_db(AUDIT_DB_PATH)


class TestPriceResolution(unittest.TestCase):
    def test_gte_resolves_yes_when_price_above_threshold(self):
        r = resolve_price_market(observed_price=125_000, threshold=120_000, comparator=Comparator.GTE)
        self.assertEqual(r.outcome, "yes")
        self.assertEqual(r.source, "lighter_mark_price")

    def test_gte_resolves_no_when_price_below_threshold(self):
        r = resolve_price_market(observed_price=115_000, threshold=120_000, comparator=Comparator.GTE)
        self.assertEqual(r.outcome, "no")

    def test_gte_at_exact_threshold_resolves_yes(self):
        r = resolve_price_market(observed_price=120_000, threshold=120_000, comparator=Comparator.GTE)
        self.assertEqual(r.outcome, "yes")

    def test_gt_at_exact_threshold_resolves_no(self):
        r = resolve_price_market(observed_price=120_000, threshold=120_000, comparator=Comparator.GT)
        self.assertEqual(r.outcome, "no")  # строгое > не включает равенство — иначе GT и GTE были бы неотличимы

    def test_lte_resolves_correctly(self):
        r = resolve_price_market(observed_price=3_000, threshold=3_500, comparator=Comparator.LTE)
        self.assertEqual(r.outcome, "yes")

    def test_rejects_negative_price(self):
        with self.assertRaises(ValueError):
            resolve_price_market(observed_price=-1, threshold=100, comparator=Comparator.GTE)


class TestEventResolution(unittest.TestCase):
    def test_valid_resolution_recorded_with_accountability_fields(self):
        r = resolve_event_market(outcome="yes", resolved_by="admin:alice", resolved_at=1_770_000_000.0, evidence_url="https://apnews.com/example")
        self.assertEqual(r.outcome, "yes")
        self.assertEqual(r.resolved_by, "admin:alice")
        self.assertFalse(r.disputed)

    def test_rejects_missing_curator(self):
        with self.assertRaises(ValueError):
            resolve_event_market(outcome="yes", resolved_by="", resolved_at=1.0, evidence_url="https://example.com")

    def test_rejects_missing_evidence(self):
        with self.assertRaises(ValueError):
            resolve_event_market(outcome="yes", resolved_by="admin:alice", resolved_at=1.0, evidence_url="")

    def test_rejects_invalid_outcome(self):
        with self.assertRaises(ValueError):
            resolve_event_market(outcome="maybe", resolved_by="admin:alice", resolved_at=1.0, evidence_url="https://example.com")


if __name__ == "__main__":
    unittest.main(verbosity=2)
