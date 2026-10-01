"""
Простой in-memory кэш для частых запросов к Lighter API.

Используется для кэширования ответов, которые не меняются часто (orderBooks, funding rates).
В проде заменить на Redis или аналог.
"""

import time
import threading
from typing import Any, Optional

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
DEFAULT_TTL = 30  # секунд


def get(key: str) -> Optional[Any]:
    """Возвращает закэшированное значение, если оно не истекло."""
    with _lock:
        if key in _cache:
            expires_at, value = _cache[key]
            if time.time() < expires_at:
                return value
            else:
                del _cache[key]
    return None


def set(key: str, value: Any, ttl: int = DEFAULT_TTL):
    """Сохраняет значение в кэш с указанным TTL."""
    with _lock:
        _cache[key] = (time.time() + ttl, value)


def clear():
    """Очищает весь кэш."""
    with _lock:
        _cache.clear()


def cached(key: str, ttl: int = DEFAULT_TTL):
    """Декоратор для кэширования функций."""
    def decorator(func):
        def wrapper(*args, **kwargs):
            # Пробуем получить из кэша
            cached_value = get(key)
            if cached_value is not None:
                return cached_value
            # Вычисляем и сохраняем в кэш
            result = func(*args, **kwargs)
            set(key, result, ttl)
            return result
        return wrapper
    return decorator