"""
Tests for RedisRateLimiter.
Uses fakeredis so no real Redis instance is needed.

Run: python -m unittest test_rate_limiter -v
"""

import asyncio
import logging
import unittest

import fakeredis
import fakeredis.aioredis
from redis.exceptions import ConnectionError

from rate_limiter import RedisRateLimiter


def make_limiter(capacity=5, refill_rate=1) -> RedisRateLimiter:
    """Build a limiter with fakeredis injected — no real Redis needed."""
    fake_redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    limiter = RedisRateLimiter(capacity=capacity, refill_rate=refill_rate)
    limiter.redis = fake_redis
    return limiter


def _capture(name: str):
    class Collect(logging.Handler):
        def __init__(self):
            super().__init__()
            self.records = []

        def emit(self, record):
            self.records.append(record)

    logger = logging.getLogger(name)
    old_level, old_handlers = logger.level, logger.handlers
    logger.setLevel(logging.DEBUG)
    collector = Collect()
    logger.addHandler(collector)

    def stop():
        logger.removeHandler(collector)
        logger.setLevel(old_level)
        logger.handlers = old_handlers

    collector.stop = stop  # type: ignore[attr-defined]
    return collector


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


class TestCorruptBucketIsNotRedisOutage(unittest.TestCase):
    """Битые данные ведра и недоступный Redis — два разных события, и прежний
    широкий `except Exception` сваливал их в одну строку «Redis недоступен,
    пропускаю без лимита». Цена: ведро с tokens="abc" молча оставалось
    неограниченным (исключение случалось до записи, то есть поле никто не
    починил), а оператор по логу искал проблему в Redis, которого не было."""

    def test_garbage_tokens_field_is_repaired_not_endlessly_open(self):
        rl = make_limiter(capacity=2, refill_rate=1)

        async def run():
            await rl.redis.hset(
                "ratelimit:u", mapping={"tokens": "abc", "last_refill": "1"}
            )
            records = _capture("wake.ratelimit")
            try:
                first = await rl.allow("u")
            finally:
                records.stop()
            self.assertTrue(first, "первый запрос после сброса обязан пройти")
            stored = await rl.redis.hget("ratelimit:u", "tokens")
            self.assertEqual(
                float(stored),
                1.0,
                "ведро починено и списание записалось, а не уехало в исключение",
            )
            self.assertTrue(await rl.allow("u"), "второй влезает в остаток capacity=2")
            self.assertFalse(
                await rl.allow("u"),
                "третий обязан быть отвергнут, а не пропущен «потому что Redis»",
            )
            text = "\n".join(r.getMessage() for r in records.records)
            self.assertIn("битые данные", text)
            self.assertNotIn(
                "Redis недоступен", text, "неверный диагноз дороже любого ремонта"
            )

        asyncio.run(run())

    def test_non_finite_and_negative_values_are_corruption_too(self):
        """float("nan") не бросается, а min(capacity, nan) в Python возвращает
        capacity — ведро выглядело полным на каждом запросе и никогда не
        кончалось. Отрицательный остаток OUR код не записывает никогда."""
        for raw in ("nan", "inf", "-inf", "-1"):
            rl = make_limiter(capacity=1, refill_rate=1)

            async def run(raw=raw):
                await rl.redis.hset(
                    "ratelimit:x", mapping={"tokens": raw, "last_refill": "1"}
                )
                self.assertTrue(await rl.allow("x"))
                self.assertFalse(
                    await rl.allow("x"),
                    f"tokens={raw!r}: ведро должно быть почищено, а не признано полным",
                )

            asyncio.run(run())

    def test_transport_failure_fails_open_and_says_redis(self):
        rl = make_limiter()
        rl.redis = _FailingRedis(ConnectionError("нет коннекта"))
        records = _capture("wake.ratelimit")
        try:
            # fail-open: терминал не должен вставать из-за лимитера
            self.assertTrue(asyncio.run(rl.allow("k")))
        finally:
            records.stop()
        text = "\n".join(r.getMessage() for r in records.records)
        self.assertIn("Redis недоступен", text)
        self.assertEqual(
            asyncio.run(rl.retry_after("k")),
            0.0,
            "мёртвый Redis не имеет права вешать ответ: 429 уже в руках клиента",
        )

    def test_our_own_bug_is_not_reported_as_redis(self):
        """Атрибут, которого нет, — это сломанный код лимитера, а не отказ
        внешнего сервиса. Проглотить его означало бы «лимитов нет» с одной
        строчкой в логе и зелёным /ready."""
        rl = make_limiter()
        rl.redis = _FailingRedis(AttributeError("в ведре нет такого поля"))
        with self.assertRaises(AttributeError):
            asyncio.run(rl.allow("k"))


class _FailingRedis:
    """Замена клиента Redis, которая всегда бросает переданный исключение."""

    def __init__(self, error: Exception):
        self._error = error

    async def hmget(self, *args, **kwargs):
        raise self._error


if __name__ == "__main__":
    unittest.main(verbosity=2)
