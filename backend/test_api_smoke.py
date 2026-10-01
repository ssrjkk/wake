"""
Smoke-тест всего HTTP-слоя через FastAPI TestClient — реально поднимает
приложение и гоняет каждый роут. Закрывает главный известный пробел проекта
(«FastAPI-эндпоинты написаны, но не прогнаны»): теперь они прогнаны.

Запуск: python -m unittest test_api_smoke -v
"""

import os
import tempfile
import unittest

# Изолированная БД, чтобы не трогать dev-данные
_tmp = tempfile.mkdtemp()
os.environ["WAKE_DB_PATH"] = os.path.join(_tmp, "wake.db")
os.environ["WAKE_AUDIT_DB_PATH"] = os.path.join(_tmp, "audit.db")
os.environ["WAKE_CURATOR_TOKEN"] = "smoke-test-token"

from fastapi.testclient import TestClient
import app  # noqa: E402
import audit_log as al  # noqa: E402

# Инициализируем audit_log в временной БД
al.init_audit_db(os.environ["WAKE_AUDIT_DB_PATH"])

client = TestClient(app.app)


class TestApiSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # демо-лидеры, как в seed_demo_leaders.py
        import db
        with db.connect(os.environ["WAKE_DB_PATH"]) as conn:
            for id_, idx, handle, fee in [("t1", 101, "@northstar", 8), ("t2", 102, "@vega.eth", 6)]:
                db.upsert_leader(conn, id_, idx, handle, fee)

    def test_health_routes(self):
        self.assertEqual(client.get("/docs").status_code, 200)
        self.assertEqual(client.get("/openapi.json").status_code, 200)

    def test_copy_trading_cycle(self):
        r = client.post("/followers", json={"l1_address": "0xabc"})
        self.assertEqual(r.status_code, 200)
        follower_id = r.json()["follower_id"]

        r = client.post("/leaders", json={"lighter_account_index": 999, "handle": "@smoke", "fee_bps": 8})
        self.assertEqual(r.status_code, 200)
        leader_id = r.json()["leader_id"]

        r = client.post("/follows", json={"follower_id": follower_id, "leader_id": leader_id, "allocation_usd": 500})
        self.assertEqual(r.status_code, 200)

        r = client.get(f"/follows/by-follower/{follower_id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()), 1)

        r = client.get(f"/follows/by-leader/{leader_id}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["follower_count"], 1)
        follow_id = r.json()["follows"][0]["id"]

        r = client.post(f"/follows/{follow_id}/pause")
        self.assertEqual(r.status_code, 200)
        r = client.post(f"/follows/{follow_id}/resume")
        self.assertEqual(r.status_code, 200)

        r = client.post("/simulate-mirror", json={
            "leader_id": leader_id, "market_id": 1, "side": "long", "is_increase": True,
            "size_delta": 0.5, "price": 100000, "leader_equity_usd": 50000,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.json()["orders"]), 1)

    def test_predict_cycle(self):
        r = client.post("/predict/markets/price", json={
            "question": "BTC above 100k?", "lighter_market_id": 1,
            "threshold": 100000, "comparator": ">=", "resolve_at": 1999999999, "b": 100,
        })
        self.assertEqual(r.status_code, 200)
        market_id = r.json()["market_id"]

        r = client.post("/predict/markets/event", json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100})
        self.assertEqual(r.status_code, 403, "event-market без токена куратора должен быть запрещён")

        r = client.post("/predict/markets/event", json={"question": "Will X win?", "resolve_at": 1999999999, "b": 100},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)
        event_id = r.json()["market_id"]

        r = client.get("/predict/markets")
        self.assertEqual(r.status_code, 200)
        self.assertGreaterEqual(len(r.json()), 2)

        r = client.get(f"/predict/markets/{market_id}/preview?outcome=yes&shares=5")
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["cost_usd"], 0)

        r = client.post(f"/predict/markets/{market_id}/trade", json={"user_id": "u1", "outcome": "yes", "shares": 10})
        self.assertEqual(r.status_code, 200)
        self.assertGreater(r.json()["cost_usd"], 0)

        r = client.post(f"/predict/markets/{market_id}/resolve-event",
                        json={"outcome": "yes", "resolved_by": "curator", "evidence_url": "https://example.com"})
        self.assertEqual(r.status_code, 403, "resolve-event без токена куратора должен быть запрещён")

        r = client.post(f"/predict/markets/{market_id}/resolve-event",
                        json={"outcome": "yes", "resolved_by": "curator", "evidence_url": "https://example.com"},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)

        r = client.post(f"/predict/markets/{market_id}/claim?user_id=u1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["payout_usd"], 10.0)

        # event-рынок резолвится тем же путём
        r = client.post(f"/predict/markets/{event_id}/resolve-event",
                        json={"outcome": "no", "resolved_by": "curator", "evidence_url": "https://example.com"},
                        headers={"X-Curator-Token": "smoke-test-token"})
        self.assertEqual(r.status_code, 200)

    def test_funding_arb(self):
        r = client.post("/funding-arb/check", json={"market_id": 1, "symbol": "BTC", "hourly_rate": 0.0001, "direction": "long"})
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["opportunity"])
        self.assertGreater(r.json()["opportunity"]["annualized_yield"], 0.8)

        r = client.post("/funding-arb/size", json={
            "capital_usd": 1000, "price": 100000, "perp_size_decimals": 3,
            "spot_size_decimals": 3, "perp_min_base_amount": 0.001, "spot_min_base_amount": 0.001,
        })
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["position"])

    def test_portfolio_risk(self):
        r = client.post("/portfolio/risk", json={
            "positions": [
                {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1000},
                {"market_id": 2, "symbol": "ETH", "signed_notional_usd": -500},
            ],
            "returns_by_market": {"1": [0.01, -0.02, 0.015], "2": [0.005, -0.01, 0.02]},
        })
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertLessEqual(body["portfolio_dollar_volatility"], body["naive_dollar_volatility"])

        r = client.post("/portfolio/hedge", json={
            "target": {"market_id": 1, "symbol": "BTC", "signed_notional_usd": 1000},
            "candidates": [[2, "ETH"]],
            "returns_by_market": {"1": [0.01, -0.02, 0.015], "2": [0.005, -0.01, 0.02]},
        })
        self.assertEqual(r.status_code, 200)

    def test_subscription_and_agent(self):
        r = client.post("/subscription/u1/start-trial")
        self.assertEqual(r.status_code, 200)
        r = client.get("/subscription/u1")
        self.assertEqual(r.json()["tier"], "free_trial")
        self.assertTrue(r.json()["has_ai_agent"])

        r = client.post("/agent/step", json={
            "user_id": "u1", "market_id": 1, "recent_prices": [99000, 99500, 100000, 100500, 101000],
            "size_decimals": 4, "price_decimals": 0, "base_size_usd": 100,
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["execution"]["status"], "dry_run")

        r = client.get("/agent/memory/u1")
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)