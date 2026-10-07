"""
Tests for RedisRateLimiter.
Uses fakeredis so no real Redis instance is needed.

Run: python -m unittest test_rate_limiter -v
"""

import asyncio
import unittest

import fakeredis
import fakeredis.aioredis

from rate_limiter import RedisRateLimiter


def make_limiter(capacity=5, refill_rate=1) -> RedisRateLimiter:
    """Build a limiter with fakeredis injected — no real Redis needed."""
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    limiter = RedisRateLimiter(capacity=capacity, refill_rate=refill_rate)
    limiter.redis = fake_redis
    return limiter


class TestRedisRateLimiter(unittest.TestCase):
    def test_allows_burst_up_to_capacity(self):
        rl = make_limiter(capacity=5, refill_rate=1)

        async def run():
            for _ in range(5):
                self.assertTrue(await rl.allow("user_a"))
            self.assertFalse(
                await rl.allow("user_a"),
                "6-й запрос без прошедшего времени должен быть отклонён",
            )

        asyncio.run(run())

    def test_refills_over_time(self):
        rl = make_limiter(capacity=5, refill_rate=1)

        async def run():
            for _ in range(5):
                await rl.allow("user_a")
            self.assertFalse(await rl.allow("user_a"))

        asyncio.run(run())

    def test_different_keys_have_independent_limits(self):
        rl = make_limiter(capacity=3, refill_rate=1)

        async def run():
            for _ in range(3):
                self.assertTrue(await rl.allow("user_a"))
            self.assertFalse(await rl.allow("user_a"))
            self.assertTrue(
                await rl.allow("user_b"), "user_b не должен зависеть от лимита user_a"
            )

        asyncio.run(run())

    def test_retry_after_positive_when_exhausted(self):
        rl = make_limiter(capacity=1, refill_rate=1)

        async def run():
            await rl.allow("u1")
            wait = await rl.retry_after("u1")
            self.assertGreater(wait, 0)

        asyncio.run(run())

    def test_nonpositive_refill_rejected_at_construction(self):
        """refill_rate=0 ловился только на втором запросе подряд: time_until_available
        делил на него и ронял middleware уже внутри обработчика. Невалидная
        конфигурация должна быть видна на старте процесса, а не в 500 у юзера."""
        with self.assertRaises(ValueError):
            RedisRateLimiter(capacity=40, refill_rate=0)
        with self.assertRaises(ValueError):
            RedisRateLimiter(capacity=0, refill_rate=20)

    def test_no_boundary_burst_exploit(self):
        rl = make_limiter(capacity=10, refill_rate=10)

        async def run():
            # Drain the bucket
            for _ in range(10):
                await rl.allow("test")
            # Try to consume more
            extra = 0
            for _ in range(20):
                if await rl.allow("test"):
                    extra += 1
            self.assertLessEqual(
                extra, 2, "burst не должен превысить разумный диапазон"
            )

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main(verbosity=2)
