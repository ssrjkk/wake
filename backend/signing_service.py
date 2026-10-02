"""
Тонкий сервис подписи для Фазы 1 (соло-трейдинг СВОИМИ деньгами). Это НЕ
мультитенантное хранилище чужих ключей — та задача гораздо серьёзнее и живёт
в Фазе 2. Здесь — обёртка вокруг одного, твоего
собственного ключа, чтобы браузер мог реально разместить ордер.

Почему сервис, а не подпись прямо в браузере: официального браузерного/WASM
signer'а у Lighter нет, а ставить непроверенную стороннюю сборку там, где
подписывают реальные деньги, — решение не на бегу. Официальный, уже
использованный путь — Python SDK на сервере (тот же паттерн, что в
place_order_example.py).

Запуск:
    pip install fastapi uvicorn lighter-sdk
    export LIGHTER_ACCOUNT_INDEX=...          # см. src/lib/lighter.ts getAccountByL1Address
    export LIGHTER_API_KEY_PRIVATE_KEY=...    # ключ с app.lighter.xyz, НЕ приватный ключ кошелька
    uvicorn signing_service:app --reload --port 8787

Фронтенд берёт адрес из VITE_SIGNING_SERVICE_URL (src/lib/config.ts, по умолчанию
localhost:8787): если сервис не запущен, кнопка честно показывает ошибку, а не
притворяется, что сработало.
"""

import os
import time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import lighter

from config import CORS_ORIGINS, LIGHTER_BASE_URL, LIGHTER_NETWORK

app = FastAPI(title="Wake signing service — Phase 1, solo only")

# Идемпотентность: client_order_index -> (tx_hash, timestamp). Если ордер с таким
# client_order_index уже отправлен, возвращаем предыдущий tx_hash, не отправляя
# повторно. In-memory — для Фазы 1 (соло-трейдинг). В проде заменить на таблицу
# в базе данных с UNIQUE-ограничением на client_order_index.
_idempotency_cache: dict[int, tuple[str, float]] = {}
_IDEMPOTENCY_TTL = 3600  # 1 час — дольше ордер не живёт, нет смысла помнить

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["*"],
)

# Одна сеть на весь бэкенд: ключ лидера, данные дашборда и подписанный ордер
# должны относиться к одному Lighter, а не к двум разным.
BASE_URL = LIGHTER_BASE_URL


def _get_client() -> "lighter.SignerClient":
    try:
        account_index = int(os.environ["LIGHTER_ACCOUNT_INDEX"])
        api_key_index = int(os.environ.get("LIGHTER_API_KEY_INDEX", "0"))
        private_key = os.environ["LIGHTER_API_KEY_PRIVATE_KEY"]
    except KeyError as e:
        raise RuntimeError(f"Не задана переменная окружения {e} — см. докстринг файла") from e

    return lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={api_key_index: private_key},
        account_index=account_index,
    )


class OrderRequest(BaseModel):
    market_index: int
    client_order_index: int
    base_amount: int   # уже отмасштабировано под supported_size_decimals рынка — см. lib/lighter.ts
    price: int          # уже отмасштабировано под supported_price_decimals рынка
    is_ask: bool         # True = short/sell, False = long/buy
    reduce_only: bool = False


@app.post("/place-order")
async def place_order(req: OrderRequest):
    now = time.time()
    cached = _idempotency_cache.get(req.client_order_index)
    if cached and (now - cached[1]) < _IDEMPOTENCY_TTL:
        return {"tx_hash": cached[0], "idempotent_replay": True}

    try:
        client = _get_client()
    except (RuntimeError, KeyError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Настройка сервиса неполная: {e}")

    try:
        tx, tx_hash, err = await client.create_order(
            market_index=req.market_index,
            client_order_index=req.client_order_index,
            base_amount=req.base_amount,
            price=req.price,
            is_ask=req.is_ask,
            order_type=client.ORDER_TYPE_MARKET,
            time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=req.reduce_only,
            order_expiry=client.DEFAULT_IOC_EXPIRY,
        )
    finally:
        await client.close()

    if err:
        raise HTTPException(status_code=400, detail=f"Lighter отклонил ордер: {err}")

    _idempotency_cache[req.client_order_index] = (tx_hash, now)
    return {"tx_hash": tx_hash, "idempotent_replay": False}


@app.get("/health")
async def health():
    # network в ответе — не косметика: фронт показывает, к какой сети уходит
    # ордер, и расходится с сетью данных основного бэкенда только так.
    return {"status": "ok", "network": LIGHTER_NETWORK, "base_url": BASE_URL}
