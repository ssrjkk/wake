"""
Rate limiting — token bucket, стандартный алгоритм, не изобретён. Закрывает
named gap: «Rate limiting и базовая DoS-защита
на app.py — сейчас их нет». Теперь есть, и протестировано.

Token bucket, не fixed-window: fixed-window позволяет burst в 2x лимита на
границе окон (например, 100 запросов в последнюю секунду одного окна +
100 в первую секунду следующего = 200 за 1 секунду при лимите 100/сек).
Token bucket этого не допускает — токены восполняются непрерывно, не скачками.
"""

import time
from dataclasses import dataclass, field


@dataclass
class TokenBucket:
    capacity: float          # максимум токенов в ведре — это и есть допустимый burst
    refill_rate: float        # токенов в секунду
    tokens: float = field(default=None)  # если None — стартует полным
    last_refill: float = field(default_factory=time.time)

    def __post_init__(self):
        if self.tokens is None:
            self.tokens = self.capacity

    def _refill(self, now: float):
        elapsed = max(0.0, now - self.last_refill)
        self.tokens = min(self.capacity, self.tokens + elapsed * self.refill_rate)
        self.last_refill = now

    def try_consume(self, cost: float = 1.0, now: float | None = None) -> bool:
        now = now if now is not None else time.time()
        self._refill(now)
        if self.tokens >= cost:
            self.tokens -= cost
            return True
        return False

    def time_until_available(self, cost: float = 1.0, now: float | None = None) -> float:
        now = now if now is not None else time.time()
        self._refill(now)
        if self.tokens >= cost:
            return 0.0
        missing = cost - self.tokens
        return missing / self.refill_rate


class RateLimiter:
    """Отдельный bucket на каждый ключ (user_id, IP, что угодно) — лимит per-user,
    не глобальный на весь сервис (иначе один активный юзер блокирует всех)."""

    def __init__(self, capacity: float, refill_rate: float):
        self.capacity = capacity
        self.refill_rate = refill_rate
        self._buckets: dict = {}

    def _get_bucket(self, key: str) -> TokenBucket:
        if key not in self._buckets:
            self._buckets[key] = TokenBucket(capacity=self.capacity, refill_rate=self.refill_rate)
        return self._buckets[key]

    def allow(self, key: str, cost: float = 1.0, now: float | None = None) -> bool:
        return self._get_bucket(key).try_consume(cost, now)

    def retry_after(self, key: str, cost: float = 1.0, now: float | None = None) -> float:
        return self._get_bucket(key).time_until_available(cost, now)
