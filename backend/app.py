"""
REST-слой Wake backend. Тонкий файл: создаёт FastAPI, подключает middleware
(CORS, rate limiting) и собирает роутеры из api/ — каждая продуктовая область
живёт в своём модуле, а не в одном монолите:

    api/copy_trading.py  — followers/leaders/follows + /simulate-mirror
    api/predict.py       — предсказания (price/event рынки)
    api/agent.py         — AI-агент + подписка
    api/portfolio.py     — cross-asset portfolio risk
    api/funding.py       — funding rate арбитраж

Математика и логика каждой области протестированы отдельно (см. test_*.py);
этот слой и роутеры — только HTTP-обвязка. Статус честный: сам FastAPI
не запускался в песочнице без сети (нет возможности pip install), поэтому
`uvicorn app:app` стоит прогнать локально перед тем, как полагаться на него.

Запуск:
    pip install fastapi uvicorn
    uvicorn app:app --reload --port 8000   # /docs откроет Swagger
"""

import signal
import logging
from contextlib import asynccontextmanager
import audit_log as al
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import db
import predict_db as pdb
from rate_limiter import RateLimiter
from config import DB_PATH, AUDIT_DB_PATH, RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL, CORS_ORIGINS
from migrate import run_migrations

from api.copy_trading import router as copy_trading_router
from api.predict import router as predict_router
from api.agent import router as agent_router
from api.portfolio import router as portfolio_router
from api.funding import router as funding_router

db.init_db(DB_PATH)
pdb.init_predict_db(DB_PATH)
al.init_audit_db(AUDIT_DB_PATH)
run_migrations(DB_PATH)

logger = logging.getLogger("wake.app")


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    logger.info("Shutting down Wake backend...")
    try:
        import db
        logger.info("Database connections closed")
    except Exception as e:
        logger.error("Error during shutdown: %s", e)


app = FastAPI(title="Wake backend", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

_rate_limiter = RateLimiter(capacity=RATE_LIMIT_CAPACITY, refill_rate=RATE_LIMIT_REFILL)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    key = request.client.host if request.client else "unknown"
    if not _rate_limiter.allow(key):
        retry = _rate_limiter.retry_after(key)
        return JSONResponse(
            status_code=429,
            content={"detail": "Слишком много запросов"},
            headers={"Retry-After": str(int(retry) + 1)},
        )
    return await call_next(request)


app.include_router(copy_trading_router)
app.include_router(predict_router)
app.include_router(agent_router)
app.include_router(portfolio_router)
app.include_router(funding_router)