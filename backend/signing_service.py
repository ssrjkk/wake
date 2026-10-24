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

Граница риска — этот процесс, а не основной бэкенд: ключ подписи лежит здесь,
поэтому именно здесь спрашивают WAKE_DRY_RUN. Сухой ход (значение по умолчанию)
считает план и отдаёт его, ни разу не обратившись в Lighter, — ордер не покидает
процесс, как и обещает README. Живой ход на mainnet требует второго переключателя,
WAKE_MAINNET_LIVE=true; без него процесс не стартует (проверка в config.py).

Аутентификации у /place-order нет, и для вызова из браузера её не придумать:
секрет, зашитый в публичный бандл, секретом не является. Доступ ограничивается
адресом — сервис опубликован на loopback (127.0.0.1:8787 в docker-compose.yml).
Выпустить его в интернет значит отдать наружу endpoint, который двигает деньги
этого аккаунта.
"""

import logging
import os
import time
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import lighter

from config import CORS_ORIGINS, DRY_RUN, LIGHTER_BASE_URL, LIGHTER_NETWORK

logger = logging.getLogger("wake.signing")

app = FastAPI(title="Wake signing service — Phase 1, solo only")

# Идемпотентность: client_order_index -> (tx_hash, timestamp). Если ордер с таким
# client_order_index уже отправлен, возвращаем предыдущий tx_hash, не отправляя
# повторно. In-memory — для Фазы 1 (соло-трейдинг). В проде заменить на таблицу
# в базе данных с UNIQUE-ограничением на client_order_index.
_idempotency_cache: dict[int, tuple[str, float]] = {}
_IDEMPOTENCY_TTL = 3600  # 1 час — дольше ордер не живёт, нет смысла помнить
# Потолок записей — не косметика: TTL проверялся только при чтении, и ни одна
# запись из словаря никогда не удалялась. На долгоживущем процессе это рост на
# каждый отправленный ордер, то есть медленная утечка памяти в процессе, который
# держит ключ и двигает деньги.
_IDEMPOTENCY_MAX_ENTRIES = 1000


def _remember(client_order_index: int, tx_hash: str, now: float) -> None:
    """Записать отправленный ордер, попутно выбросив протухшее.

    Чистка на записи, а не по фоновому таймеру: процесс однопоточный по
    сути запросов, фоновая корутина добавила бы состояние, которое надо
    обслуживать, а эффект тот же — в словаре не копится история старше часа.
    """
    expired = [
        index
        for index, (_, ts) in _idempotency_cache.items()
        if now - ts >= _IDEMPOTENCY_TTL
    ]
    for index in expired:
        _idempotency_cache.pop(index, None)
    if len(_idempotency_cache) >= _IDEMPOTENCY_MAX_ENTRIES:
        # Если срок ещё не вышел у всех, а записей уже тысяча — выталкиваем
        # самые старые: порядок dict в Python гарантирует хронологию вставки.
        for index in list(_idempotency_cache)[
            : len(_idempotency_cache) - _IDEMPOTENCY_MAX_ENTRIES + 1
        ]:
            _idempotency_cache.pop(index, None)
    _idempotency_cache[client_order_index] = (tx_hash, now)


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
        raise RuntimeError(
            f"Не задана переменная окружения {e} — см. докстринг файла"
        ) from e

    return lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={api_key_index: private_key},
        account_index=account_index,
    )


class OrderRequest(BaseModel):
    # Граница, за которой начинается чужой счёт: отрицательный размер или цена
    # уходят в SDK как есть и превращаются в ордер, которого человек не просил.
    market_index: int = Field(ge=0)
    client_order_index: int = Field(ge=0)
    base_amount: int = Field(
        gt=0
    )  # уже отмасштабировано под decimals рынка — lib/lighter.ts
    price: int = Field(gt=0)  # уже отмасштабировано под supported_price_decimals рынка
    is_ask: bool  # True = short/sell, False = long/buy
    reduce_only: bool = False


@app.post("/place-order")
async def place_order(req: OrderRequest):
    if DRY_RUN:
        # Сухой ход считает план и останавливается здесь. Проверять переключатель
        # нужно в этом процессе: фронт зовёт /place-order напрямую, мимо бэкенда,
        # и «бэкенд сухой» ничего не гарантирует для вызова, пришедшего сюда.
        logger.info("dry-run: ордер не отправлен: %s", req.model_dump())
        return {"tx_hash": None, "dry_run": True, "order": req.model_dump()}

    now = time.time()
    cached = _idempotency_cache.get(req.client_order_index)
    if cached and (now - cached[1]) < _IDEMPOTENCY_TTL:
        return {"tx_hash": cached[0], "dry_run": False, "idempotent_replay": True}

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

    _remember(req.client_order_index, tx_hash, now)
    return {"tx_hash": tx_hash, "dry_run": False, "idempotent_replay": False}


@app.get("/health")
async def health():
    # network в ответе — не косметика: фронт показывает, к какой сети уходит
    # ордер, и расходится с сетью данных основного бэкенда только так. dry_run
    # показан по той же причине: кнопка «Отправить» обязана говорить, уйдёт ли
    # ордер в Lighter или этот процесс остановит его на себе.
    return {
        "status": "ok",
        "network": LIGHTER_NETWORK,
        "base_url": BASE_URL,
        "dry_run": DRY_RUN,
    }
