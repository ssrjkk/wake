"""
Redis-backed rate limiting — token bucket, стандартный алгоритм.

Token bucket, не fixed-window: fixed-window позволяет burst в 2x лимита на
границе окон (100 запросов в последнюю секунду окна + 100 в первую секунду
следующего = 200 за секунду при лимите 100/сек). Token bucket этого не
допускает — токены восполняются непрерывно, не скачками.

Состояние bucket хранится в Redis, поэтому лимит работает одинаково для всех
воркеров процесса (uvicorn --workers N) и всех инстансов за балансировщиком.
Ключ bucket — пользователь, а не только IP: за прокси адрес соединения общий у
всего сервиса, и на одном общем bucket один активный клиент закрыл бы вход
остальным.

Что лимитер НЕ гарантирует: он не отстояет точную квоту под конкурентным гоном.
Чтение и списание — два шага, поэтому пачка запросов, пришедших в одну
миллисекунду, пропустит чуть больше лимита. Это оставлено намеренно: цель
лимитера — сбить скрипт-поллинг и защитить базу от случайного шторма. Жёсткая
квота требовала бы EVAL-скрипта, которого fakeredis (на нём живут тесты) не
поддерживает.
"""

import logging
import time

import redis.asyncio as redis

from config import REDIS_URL

logger = logging.getLogger("wake.ratelimit")


class RedisRateLimiter:
    def __init__(self, capacity: float, refill_rate: float, redis_url: str = REDIS_URL):
        if capacity <= 0:
            raise ValueError(f"capacity должен быть > 0, получено {capacity}")
        if refill_rate <= 0:
            raise ValueError(f"refill_rate должен быть > 0, получено {refill_rate}")
        self.capacity = capacity
        self.refill_rate = refill_rate
        # Таймауты обязательны: без них висящий Redis вешает каждый запрос, и
        # fail-open наступает не «лимитов нет», а «сервис лежит».
        self.redis = redis.from_url(
            redis_url,
            decode_responses=True,
            socket_timeout=1.0,
            socket_connect_timeout=1.0,
        )

    async def _read(self, key: str) -> tuple[float, float]:
        """(tokens, last_refill) с уже применённым восполнением; bucket инициализируется capacity."""
        tokens_str, last_str = await self.redis.hmget(
            f"ratelimit:{key}", "tokens", "last_refill"
        )
        now = time.time()
        if tokens_str is None or last_str is None:
            return self.capacity, now
        elapsed = max(0.0, now - float(last_str))
        return min(self.capacity, float(tokens_str) + elapsed * self.refill_rate), now

    async def _write(self, key: str, tokens: float, last_refill: float) -> None:
        pipe = self.redis.pipeline()
        pipe.hset(
            f"ratelimit:{key}", mapping={"tokens": tokens, "last_refill": last_refill}
        )
        # Простоявший bucket забывается и обнуляется: хранить его вечно смысла
        # нет, а заново созданный bucket отдаёт ровно capacity — то же самое.
        pipe.expire(f"ratelimit:{key}", int(self.capacity / self.refill_rate) + 60)
        await pipe.execute()

    async def allow(self, key: str, cost: float = 1.0) -> bool:
        """Списать cost токенов. True — пропустили.

        При недоступном Redis пропускаем (fail-open): отказ лимитера не должен
        останавливать терминал, у которого в этот момент открыты позиции.
        Мёртвый Redis при этом видно по /ready, так что состояние не прячется."""
        try:
            tokens, now = await self._read(key)
            if tokens < cost:
                return False
            await self._write(key, tokens - cost, now)
            return True
        except Exception:
            logger.warning(
                "rate limiter: Redis недоступен, пропускаю без лимита", exc_info=True
            )
            return True

    async def retry_after(self, key: str, cost: float = 1.0) -> float:
        """Секунд до момента, когда cost токенов станет доступно."""
        try:
            tokens, _ = await self._read(key)
        except Exception:
            return 0.0
        if tokens >= cost:
            return 0.0
        return (cost - tokens) / self.refill_rate

    async def close(self) -> None:
        """Закрыть соединение с Redis (вызывается на остановке приложения)."""
        await self.redis.aclose()

    async def ping(self) -> bool:
        """Жив ли Redis (для /ready)."""
        try:
            return bool(await self.redis.ping())
        except Exception:
            return False
