"""
In-memory кэш для ответов Lighter, которые меняются реже, чем их спрашивают.

Живёт он внутри процесса: при нескольких воркерах у каждого свой кэш и своя
прогретая книга рынков. Прежняя строчка «в проде заменить на Redis или аналог»
не описывала фактическое состояние — на этом кэше прод и работает, и оставлять
её было бы обещанием, которое никто не собирается выполнить: обзор рынка стоит
нескольких десятков запросов к Lighter на обновление, он кэшируется на 60 секунд
(lighter_rest.get_market_overview), а вынос ключей в Redis добавил бы сетевой
запрос и сериализацию нескольких сотен строк на каждое попадание в кэш.

Что здесь важно: значение, равное None, не кэшируется (get отличает промах по
нему же), и TTL считается при чтении, а не фоном — протухшая строка живёт в
словаре до первого обращения к ней. Сбросить всё состояние нужно тестам и
оператору после смены сети: clear().
"""

import functools
import inspect
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


def _key_suffix(func, args, kwargs) -> str:
    """Именованные аргументы вместо позиционных: get_funding_rate(1, "mainnet")
    и get_funding_rate(market_id=1, network="mainnet") должны попадать в один
    ключ, иначе кэш зависит от стиля вызова."""
    bound = inspect.signature(func).bind_partial(*args, **kwargs)
    bound.apply_defaults()
    return ",".join(f"{k}={v}" for k, v in bound.arguments.items())


def cached(prefix: str, ttl: int = DEFAULT_TTL):
    """Ключ = префикс + фактические аргументы вызова.

    Раньше ключ был статичной строкой, и это ломало данные, а не только
    производительность: "funding_rate_{market_id}" никто не подставлял, поэтому
    get_funding_rate(2) возвращал ставку market 1, пока не истёк TTL. Точно так
    же order_books не различал сети — один тестнетовый ответ отдавался как
    mainnet-данные."""

    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            key = f"{prefix}:{_key_suffix(func, args, kwargs)}"
            cached_value = get(key)
            if cached_value is not None:
                return cached_value
            result = func(*args, **kwargs)
            set(key, result, ttl)
            return result

        return wrapper

    return decorator
