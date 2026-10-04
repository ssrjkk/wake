"""Локальный запуск без Docker: Redis заменяется fakeredis в процессе.

Docker Desktop лежит, отдельного Redis на машине нет, а проверять фронтенд
нужно против живого бэкенда. FakeAsyncRedis — настоящий in-memory Redis-протокол,
поэтому token bucket и ping работают как в проде; разница только в
персистентности, которая для smoke-прогона не важна.
"""

import fakeredis
import rate_limiter

_server = fakeredis.FakeServer()
_orig_init = rate_limiter.RedisRateLimiter.__init__


def _fake_init(self, capacity, refill_rate, redis_url=None):
    _orig_init(self, capacity, refill_rate)
    self.redis = fakeredis.FakeAsyncRedis(server=_server)


rate_limiter.RedisRateLimiter.__init__ = _fake_init

import uvicorn  # noqa: E402  (импорт после патча — патч должен примениться первым)

import app  # noqa: E402  (импорт после патча — патч должен примениться первым)

uvicorn.run(app.app, host="127.0.0.1", port=8000, log_level="info")
