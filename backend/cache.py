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

Размер словаря ограничен (MAX_ENTRIES). Ключевое пространство здесь — не
фиксированный набор: market_id, индекс аккаунта, сеть. Вычерпанный Lighter или
перебирающий индексы бот добавляли по строке на каждый ключ, и процесс рос без
потолка, потому что истёкшую запись выкидывало только чтение её же ключа.
"""

import functools
import inspect
import time
import threading
from typing import Any, Optional

_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
DEFAULT_TTL = 30  # секунд
# Потолок записей с запасом над реальным использованием: книга рынков и обзор
# живут одной строкой на сеть, ставки funding — по строке на рынок (~250),
# свечи — по строке на (рынок, интервал). Тысяча — это десятки витков опроса,
# а не то, что упрётся в рабочий набор.
MAX_ENTRIES = 1000


def _prune_locked(now: float) -> None:
    """Выбросить истёкшее, а если всё живо — самые старые.

    Порядок dict в Python — хронология вставки, поэтому «срез по началу» и есть
    вытеснение самых старых. Вызов только под блокировкой и только из set():
    чтение не должно делать работу по очистке, иначе GET превращается в запись."""
    expired = [key for key, (exp, _) in _cache.items() if exp <= now]
    for key in expired:
        del _cache[key]
    overflow = len(_cache) - MAX_ENTRIES + 1
    if overflow > 0:
        for key in list(_cache)[:overflow]:
            del _cache[key]


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
    """Сохраняет значение в кэш с указанным TTL, не давая словарю расти без потолка."""
    with _lock:
        _prune_locked(time.time())
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
