"""
REST-слой Wake backend. Тонкий файл: создаёт FastAPI, подключает middleware
(CORS, rate limiting, security headers) и собирает роутеры из api/ — каждая
продуктовая область живёт в своём модуле, а не в одном монолите:

    api/auth.py         — Telegram Login Widget + Mini App auth
    api/copy_trading.py — followers/leaders/follows + /simulate-mirror
    api/predict.py      — предсказания (price/event рынки)
    api/agent.py        — AI-агент + подписка
    api/portfolio.py    — cross-asset portfolio risk
    api/funding.py      — funding rate арбитраж
    api/markets.py      — GET /markets/overview (ранжирование по 24ч-обороту)

Математика и логика каждой области протестированы отдельно (см. test_*.py);
этот слой и роутеры — только HTTP-обвязка. Обвязка тоже прогнана:
`test_api_smoke.py` поднимает это приложение через FastAPI TestClient и проходит
каждый роут, включая отказные пути (токен куратора, подпись Telegram,
нерезолвленные рынки), так что список выше — не обещание, а проверенное состояние.

Безопасность:
- Redis-backed rate limiting (token bucket, per-IP)
- Security headers (X-Content-Type-Options, X-Frame-Options, CSP, ...)
- Strict CORS (no wildcards, explicit origins only)
- Unified error format: { "error": { "code": "...", "message": "..." } }

Запуск:
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000   # /docs откроет Swagger
"""

import logging
from contextlib import asynccontextmanager

import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import db
import predict_db as pdb
import audit_log as al
import database
from migrate import run_migrations
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

# Legacy SQLite init (until full PostgreSQL migration)
db.init_db(settings.wake_db_path)
pdb.init_predict_db(settings.wake_db_path)
al.init_audit_db(settings.wake_audit_db_path)
run_migrations(settings.wake_db_path)


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
    allow_headers=["Content-Type", "Authorization"],
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


# Redis-backed rate limiting (token bucket, per-IP)
_rate_limiter = RedisRateLimiter(
    capacity=settings.wake_rate_limit_capacity,
    refill_rate=settings.wake_rate_limit_refill,
    redis_url=settings.wake_redis_url,
)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    key = request.client.host if request.client else "unknown"
    if not await _rate_limiter.allow(key):
        retry = await _rate_limiter.retry_after(key)
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


# Unified error handler
@app.exception_handler(Exception)
async def unified_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, ValueError):
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


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Некорректное тело запроса",
                "details": exc.errors(),
            }
        },
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
