"""
Redis-backed rate limiting — token bucket, стандартный алгоритм.

Token bucket, не fixed-window: fixed-window позволяет burst в 2x лимита на
границе окон (например, 100 запросов в последнюю секунду одного окна +
100 в первую секунду следующего = 200 за 1 секунду при лимите 100/сек).
Token bucket этого не допускает — токены восполняются непрерывно, не скачками.

Состояние bucket хранится в Redis, поэтому лимит работает одинаково
для всех воркеров процесса (uvicorn --workers N) и всех инстансов
за load balancer'ом.
"""

import time
import redis.asyncio as redis

from config import REDIS_URL


class RedisRateLimiter:
    """Redis-backed token bucket rate limiter.

    Отдельный bucket на каждый ключ (user_id, IP, что угодно) — лимит per-user,
    не глобальный на весь сервис (иначе один активный юзер блокирует всех).
    """

    def __init__(self, capacity: float, refill_rate: float, redis_url: str = REDIS_URL):
        if capacity <= 0:
            raise ValueError(f"capacity должен быть > 0, получено {capacity}")
        if refill_rate <= 0:
            raise ValueError(f"refill_rate должен быть > 0, получено {refill_rate}")
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.redis = redis.from_url(redis_url, decode_responses=True)

    async def _get_bucket(self, key: str) -> tuple[float, float]:
        """Return (tokens, last_refill) for key, initializing if needed."""
        pipe = self.redis.pipeline()
        pipe.hget(f"ratelimit:{key}", "tokens")
        pipe.hget(f"ratelimit:{key}", "last_refill")
        tokens_str, last_refill_str = await pipe.execute()

        now = time.time()
        if tokens_str is None or last_refill_str is None:
            return self.capacity, now

        tokens = float(tokens_str)
        last_refill = float(last_refill_str)

        elapsed = max(0.0, now - last_refill)
        tokens = min(self.capacity, tokens + elapsed * self.refill_rate)
        return tokens, now

    async def _update_bucket(self, key: str, tokens: float, last_refill: float) -> None:
        """Atomically update bucket state in Redis."""
        pipe = self.redis.pipeline()
        pipe.hset(
            f"ratelimit:{key}", mapping={"tokens": tokens, "last_refill": last_refill}
        )
        pipe.expire(f"ratelimit:{key}", 60)
        await pipe.execute()

    async def allow(self, key: str, cost: float = 1.0) -> bool:
        """Try to consume tokens. Returns True if allowed, False if rate limited.

        When Redis is unavailable, falls back to allowing the request
        (rate limiting is not critical for functionality).
        """
        try:
            tokens, now = await self._get_bucket(key)
            if tokens < cost:
                return False
            await self._update_bucket(key, tokens - cost, now)
            return True
        except Exception:
            return True

    async def retry_after(self, key: str, cost: float = 1.0) -> float:
        """Return seconds until cost tokens are available."""
        tokens, now = await self._get_bucket(key)
        if tokens >= cost:
            return 0.0
        missing = cost - tokens
        return missing / self.refill_rate

    async def close(self) -> None:
        """Close Redis connection (called on app shutdown)."""
        await self.redis.aclose()

    async def ping(self) -> bool:
        """Жив ли Redis (для /ready)."""
        try:
            return bool(await self.redis.ping())
        except Exception:
            return False
