"""
REST-слой Wake backend. Тонкий файл: создаёт FastAPI, подключает middleware
(CORS, rate limiting, security headers) и собирает роутеры из api/ — каждая
продуктовая область живёт в своём модуле, а не в одном монолите:

    api/auth.py         — вход: Telegram Widget, Mini App, подпись кошелька
    api/copy_trading.py — followers/leaders/follows + /simulate-mirror
    api/predict.py      — предсказания (price/event рынки)
    api/agent.py        — AI-агент + подписка
    api/portfolio.py    — cross-asset portfolio risk
    api/funding.py      — funding rate арбитраж
    api/markets.py      — GET /markets/overview (ранжирование по 24ч-обороту)

Математика и логика каждой области протестированы отдельно (см. test_*.py);
этот слой и роутеры — только HTTP-обвязка. Обвязка тоже прогнана:
`test_api_smoke.py` поднимает это приложение и проходит каждый роут, включая
отказные пути (токен куратора, подпись Telegram, нерезолвленные рынки), так что
список выше — не обещание, а проверенное состояние.

Безопасность:
- Вход — подписанная сессия (session.py): роутеры читают пользователя из
  токена, а не из тела запроса. Там, где право на запись решает владение
  кошельком, вход идёт через challenge/response (wallet_auth.py).
- Операторские роуты — отдельный токен куратора (api/guards.py).
- Rate limiting — token bucket в Redis, на ключ пользователя или IP, с
  повышенным весом на запись.
- Security headers (X-Content-Type-Options, X-Frame-Options, CSP, ...)
- Strict CORS (no wildcards, explicit origins only)
- Единый формат ошибок: { "error": { "code": "...", "message": "..." } }

Запуск:
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000   # /docs откроет Swagger
"""

import logging
import math
from contextlib import asynccontextmanager

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import database
import net
import session
import wallet_auth
from config import settings
from rate_limiter import RedisRateLimiter

from api.auth import router as auth_router
from api.copy_trading import router as copy_trading_router
from api.predict import router as predict_router
from api.agent import router as agent_router
from api.portfolio import router as portfolio_router
from api.funding import router as funding_router
from api.markets import router as markets_router

# Initialize Sentry for error monitoring (optional — only if SENTRY_DSN is set)
if settings.sentry_dsn:
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        integrations=[StarletteIntegration(), FastApiIntegration()],
        traces_sample_rate=0.1,
        environment=settings.wake_env,
    )

logger = logging.getLogger("wake.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Starting Wake backend (network=%s, dry_run=%s)",
        settings.wake_lighter_network,
        settings.wake_dry_run,
    )
    yield
    logger.info("Shutting down Wake backend...")
    await _rate_limiter.close()
    await database.close_db()
    logger.info("Database connections closed")


app = FastAPI(title="Wake backend", lifespan=lifespan)

# CORS — strict origins, no wildcards
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # X-Curator-Token обязано быть в списке: операторские роуты требуют именно
    # этот заголовок (api/guards.py), и без него браузер не проходит preflight —
    # то есть любой веб-интерфейс оператора был бы нерабочим по конфигу CORS, а
    # не по коду.
    allow_headers=["Content-Type", "Authorization", "X-Curator-Token"],
    allow_credentials=True,
)


# Security headers — Helmet-аналог для FastAPI
@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=(), payment=()"
    )
    response.headers["Content-Security-Policy"] = "default-src 'self'"
    return response


# Redis-backed rate limiting (token bucket)
_rate_limiter = RedisRateLimiter(
    capacity=settings.wake_rate_limit_capacity,
    refill_rate=settings.wake_rate_limit_refill,
    redis_url=settings.wake_redis_url,
)

# Запись дороже чтения: она трогает базу и Lighter, поэтому mutating-методы
# списывают несколько токенов. Иначе лимит, рассчитанный на polling цен,
# одинаково свободно разрешал бы долбить эндпоинты, которые решают чужие деньги.
_WRITE_COST = 3.0


def _bucket_key(request: Request) -> str:
    """Ключ bucket'а: пользователь, если токен подписан нами, иначе — IP соединения.

    По одному IP за Railway/Cloudflare нельзя: адрес соединения это адрес
    прокси, и все клиенты делили бы один лимит. Подпись токена проверяется
    второй раз (здесь и в зависимости роута) — HMAC по короткой строке стоит
    микросекунды, а без неё отличить чужой трафик от своего нечем."""
    header = request.headers.get("authorization", "")
    if header.startswith("Bearer "):
        try:
            return f"user:{session.verify(header[7:].strip())}"
        except session.SessionError:
            pass
    return f"ip:{net.client_ip(request)}"


# Проверки живости и готовности — не трафик пользователя. Оркестратор (Railway)
# долбит /health и /ready секунда в секунду; за прокси все эти запросы приходят
# с одного IP и попадают в одно ведро. Ведро на 40 токенов исчерпается самим
# health-чекером, /ready начнёт отвечать 429, оркестратор решит, что приложение
# не готово, и перезапустит его — классический self-inflicted restart loop.
# Preflight (OPTIONS) — то же: это не запрос данных, а технический шаг браузера.
_UNLIMITED_PATHS = ("/health", "/ready", "/docs", "/openapi.json", "/redoc")


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    if request.method == "OPTIONS" or request.url.path in _UNLIMITED_PATHS:
        return await call_next(request)
    key = _bucket_key(request)
    cost = _WRITE_COST if request.method in ("POST", "PUT", "PATCH", "DELETE") else 1.0
    if not await _rate_limiter.allow(key, cost):
        retry = await _rate_limiter.retry_after(key, cost)
        return JSONResponse(
            status_code=429,
            content={
                "error": {
                    "code": "RATE_LIMITED",
                    "message": "Слишком много запросов",
                }
            },
            headers={"Retry-After": str(int(retry) + 1)},
        )
    return await call_next(request)


# Единый формат ошибок
@app.exception_handler(Exception)
async def unified_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, ValueError):
        # ValueError — это и валидация границ (predict_amm, portfolio_risk,
        # wallet_auth), и баг в коде (_int("abc")). Статус 400 остаётся, но
        # молча превращать настоящую ошибку сервера в «плохой запрос» нельзя:
        # без этой строки Sentry и логики разбора видели бы только 400 от
        # клиента там, где падал наш собственный код.
        logger.warning(
            "ValueError на %s %s: %s",
            request.method,
            request.url.path,
            exc,
            exc_info=True,
        )
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": str(exc),
                }
            },
        )
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "Внутренняя ошибка сервера",
            }
        },
    )


# HTTPException (404 маршрутов, 401 auth, 400 ручных проверок) и ошибки
# валидации FastAPI приходят в том же едином формате, что и всё остальное —
# иначе у клиента два контракта ошибок вместо одного. dict-детали вида
# {"error": {...}} из auth.py пробрасываются как есть.
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        payload = exc.detail
    else:
        from http import HTTPStatus

        payload = {
            "error": {
                "code": HTTPStatus(exc.status_code).phrase.upper().replace(" ", "_"),
                "message": str(exc.detail),
            }
        }
    return JSONResponse(status_code=exc.status_code, content=payload)


def _json_safe(value):
    """Значение, которое json.dumps точно возьмёт.

    Pydantic кладёт в `input` ровно то, что прислал клиент, — и NaN или Infinity
    проходят в словарь ошибок как настоящие float. Starlette сериализует ответ с
    allow_nan=False, поэтому такой 422 падал сам по себе: клиент получал 500 и не
    видел ни кода ошибки, ни поля, из-за которого его отвергли. То же касается
    `ctx` с ValueError из field_validator и любых вложенных списков."""
    if isinstance(value, float) and not math.isfinite(value):
        return repr(value)  # "nan" / "inf" / "-inf" — читаемо и сериализуемо
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, bool, int, float)) or value is None:
        return value
    return str(value)


def _validation_details(exc: RequestValidationError) -> list[dict]:
    """Сообщения валидации, пригодные для JSON: каждое поле пройдёт через
    _json_safe, чтобы отказ не превращался во внутреннюю ошибку."""
    return [_json_safe(error) for error in exc.errors()]


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Некорректное тело запроса",
                "details": _validation_details(exc),
            }
        },
    )


# Отказ по сессии и по подписи кошелька приходит из зависимостей (api/guards.py)
# и из wallet_auth как типизированное исключение со своим кодом и статусом.
# Форматировать его здесь, а не в каждом роутере: иначе один и тот же «токен
# протух» собирался бы в JSON по-разному в разных модулях.
@app.exception_handler(session.SessionError)
async def session_error_handler(request: Request, exc: session.SessionError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(wallet_auth.WalletAuthError)
async def wallet_auth_error_handler(request: Request, exc: wallet_auth.WalletAuthError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.get("/ready")
async def ready():
    """
    Готовность к трафику для оркестратора: отличима от живости (liveness).
    /health отвечает всегда (живость), /ready проверяет фактические
    зависимости — PostgreSQL (SELECT 1) и Redis (ping). Провал любой из
    них = не готов (503).
    """
    from sqlalchemy import text

    checks = {}
    ready_ok = True

    try:
        async with database.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "fail"
        ready_ok = False

    checks["redis"] = "ok" if await _rate_limiter.ping() else "fail"
    if checks["redis"] != "ok":
        ready_ok = False

    return JSONResponse(
        status_code=200 if ready_ok else 503,
        content={"status": "ready" if ready_ok else "not_ready", "checks": checks},
    )


@app.get("/health")
def health():
    """
    Разведка для фронтенда и для деплоя: жив ли бэкенд и в каком он режиме.
    Pages отдаёт на любой неизвестный путь index.html со статусом 200, поэтому
    проверяется именно наличие JSON здесь, а не код ответа. dry_run показан
    намеренно: это единственный параметр, по которому видно, что инстанс не
    отправит ордера.
    """
    return {
        "status": "ok",
        "network": settings.wake_lighter_network,
        "dry_run": settings.wake_dry_run,
    }


app.include_router(auth_router)
app.include_router(copy_trading_router)
app.include_router(predict_router)
app.include_router(agent_router)
app.include_router(portfolio_router)
app.include_router(funding_router)
app.include_router(markets_router)
