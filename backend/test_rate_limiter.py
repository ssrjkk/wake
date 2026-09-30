"""python3 -m unittest test_rate_limiter -v"""

import unittest
from rate_limiter import TokenBucket, RateLimiter


class TestTokenBucket(unittest.TestCase):
    def test_starts_full_and_allows_burst_up_to_capacity(self):
        b = TokenBucket(capacity=5, refill_rate=1)
        for _ in range(5):
            self.assertTrue(b.try_consume(1.0, now=0))
        self.assertFalse(b.try_consume(1.0, now=0), "6-й запрос без прошедшего времени должен быть отклонён")

    def test_refills_over_time(self):
        b = TokenBucket(capacity=5, refill_rate=1)
        for _ in range(5):
            b.try_consume(1.0, now=0)
        self.assertFalse(b.try_consume(1.0, now=0.5))
        self.assertTrue(b.try_consume(1.0, now=1.0), "через 1 секунду при refill_rate=1 должен появиться токен")

    def test_never_exceeds_capacity_even_after_long_idle(self):
        b = TokenBucket(capacity=5, refill_rate=1)
        b.try_consume(5.0, now=0)
        b.try_consume(0.0, now=10_000_000)
        self.assertLessEqual(b.tokens, 5.0, "токены не должны накапливаться сверх capacity")

    def test_time_until_available_is_zero_when_tokens_present(self):
        b = TokenBucket(capacity=5, refill_rate=1)
        self.assertEqual(b.time_until_available(1.0, now=0), 0.0)

    def test_time_until_available_matches_refill_rate(self):
        b = TokenBucket(capacity=5, refill_rate=2)
        b.try_consume(5.0, now=0)
        wait = b.time_until_available(1.0, now=0)
        self.assertAlmostEqual(wait, 0.5, places=6)

    def test_no_boundary_burst_exploit(self):
        b = TokenBucket(capacity=10, refill_rate=10)
        b.try_consume(10.0, now=0)  # опустошили — теперь в устойчивом состоянии, не с холодного полного старта
        allowed_window1 = sum(1 for i in range(20) if b.try_consume(1.0, now=i * 0.05))
        allowed_window2 = sum(1 for i in range(20) if b.try_consume(1.0, now=1.0 + i * 0.05))
        self.assertLessEqual(allowed_window1, 11)
        self.assertLessEqual(allowed_window2, 11, "вторая секунда подряд не должна получить полный лимит заново")


class TestRateLimiterPerKey(unittest.TestCase):
    def test_different_keys_have_independent_limits(self):
        rl = RateLimiter(capacity=3, refill_rate=1)
        for _ in range(3):
            self.assertTrue(rl.allow("user_a", now=0))
        self.assertFalse(rl.allow("user_a", now=0))
        self.assertTrue(rl.allow("user_b", now=0), "user_b не должен зависеть от лимита user_a")

    def test_retry_after_zero_when_allowed(self):
        rl = RateLimiter(capacity=3, refill_rate=1)
        self.assertEqual(rl.retry_after("u1", now=0), 0.0)

    def test_retry_after_positive_when_exhausted(self):
        rl = RateLimiter(capacity=1, refill_rate=1)
        rl.allow("u1", now=0)
        wait = rl.retry_after("u1", now=0)
        self.assertGreater(wait, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
