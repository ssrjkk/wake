"""
Тонкий сервис подписи для Фазы 1 (соло-трейдинг СВОИМИ деньгами). Это НЕ
мультитенантное хранилище чужих ключей — та задача гораздо серьёзнее и живёт
в Фазе 2. Здесь — обёртка вокруг одного, твоего собственного ключа, чтобы браузер
мог реально разместить ордер.

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
адресом — сервис опубликован на loopback (127.0.0.1:8787 в docker-compose.yml),
и это не метафора, а проверка: каждый запрос сверяется с заголовком Host, а
хосты вне WAKE_SIGNING_ALLOWED_HOSTS получают 403 до всякой работы с ключом.

CORS к этому не имеет отношения: он решает, прочитает ли чужая страница ответ, а
не дойдёт ли её запрос. curl и любой не-браузерный клиент через preflight не
проходят принципиально, поэтому единственная граница эндпоинта, который двигает
деньги, — адрес, под которым он опубликован.
"""

import asyncio
import logging
import os
import time
from urllib.parse import urlsplit

import lighter
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import (
    CORS_ORIGINS,
    DRY_RUN,
    LIGHTER_BASE_URL,
    LIGHTER_NETWORK,
    SIGNING_ALLOWED_HOSTS,
)

logger = logging.getLogger("wake.signing")

app = FastAPI(title="Wake signing service — Phase 1, solo only")

# Разрешённые значения заголовка Host. Порт в списке не участвует: у петли это
# «:8787», у публикующего прокси — свой, и сверка с портом заставила бы
# настраивающего человека угадывать значение, которого он часто не касается.
_ALLOWED_HOSTS = frozenset(h.strip().lower() for h in SIGNING_ALLOWED_HOSTS)


def _host_of(header: str | None) -> str:
    """Имя хоста из Host, без схемы, порта и скобок вокруг IPv6.

    Разбирается по форме URL, а не `split(":")[0]`: у [::1]:8787 первое
    двоеточие стоит внутри адреса, и split оставил бы «[» — то есть петля не
    прошла бы собственный гейт. urlsplit отдаёт hostname уже без скобок."""
    if not header:
        return ""
    netloc = header.split("/", 1)[0]
    return (urlsplit(f"http://{netloc}").hostname or "").lower()


def _error(status: int, code: str, message: str) -> JSONResponse:
    """Единый формат ошибок — тот же, что у основного бэкенда (app.py).

    FastAPI по умолчанию отдаёт {"detail": ...}, а фронтенд разбирает
    {"error": {"code", "message"}}: под старый формат Терминал печатал в тосте
    голый JSON вместо объяснения отказа."""
    return JSONResponse(
        status_code=status, content={"error": {"code": code, "message": message}}
    )


@app.middleware("http")
async def host_gate(request: Request, call_next):
    """Публикация этого процесса наружу — отказ, а не строчка в логе.

    Гейт закрывает и /health: спрашивать у опубликованного сервиса, опубликован
    ли он, — схема, в которой проверкой руководит проверяемый."""
    host = _host_of(request.headers.get("host"))
    if host not in _ALLOWED_HOSTS:
        logger.warning("signing: запрос на не разрешённый хост %r — отклонён", host)
        return _error(
            403,
            "SIGNING_HOST_NOT_ALLOWED",
            "Сервис подписи принимает запросы только на хосты "
            f"{sorted(_ALLOWED_HOSTS)}, а запрос пришёл на Host="
            f"{host or 'пусто'!r}. Разрешены петля и имя сервиса во внутренней "
            "сети; всё остальное означает, что эндпоинт опубликован, а он двигает "
            "деньги по ключу владельца.",
        )
    return await call_next(request)


# CORS добавлен после гейта, то есть стоит внешним слоем: preflight от чужого
# источника должен разбираться им, а не доходить до маршрутов.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["POST"],
    allow_headers=["*"],
)

# Одна сеть на весь бэкенд: ключ лидера, данные дашборда и подписанный ордер
# должны относиться к одному Lighter, а не к двум разным.
BASE_URL = LIGHTER_BASE_URL

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

# «Проверить кэш» и «записать отправленное» — один шаг. Без блокировки два
# одновременных запроса с одним client_order_index оба видели пустой кэш (между
# чтением и записью стоит await на create_order) и оба уходили в Lighter: кэш,
# чья единственная задача — не отправить второй раз, в гонке не участвовал.
# Серилизация выбрана сознательно: процесс обслуживает клики одного человека, а
# очередь в несколько сотен миллисекунд дешевле второго боевого ордера.
_submit_lock = asyncio.Lock()


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


# Потолок масштаба — 2**53-1, а не «сколько влезет в int»: оба числа приходят из
# браузера, где они посчитаны в float64. Значение выше порога уже округлено самим
# вычислением, то есть это не «очень большой ордер», а испорченный — обычно
# неверные decimals рынка, разрыв в 10**k.
_FLOAT64_EXACT_INT = 2**53 - 1


class OrderRequest(BaseModel):
    # Граница, за которой начинается чужой счёт: отрицательный размер или цена
    # уходят в SDK как есть и превращаются в ордер, которого человек не просил.
    market_index: int = Field(ge=0)
    # int32 — та же граница, что у обоих генераторов индекса: в браузере
    # (src/lib/lighter.ts randomClientOrderIndex) и в агенте
    # (agent_runner._client_order_index) значение берётся по модулю 2**31.
    client_order_index: int = Field(ge=0, le=2**31 - 1)
    base_amount: int = Field(
        gt=0, le=_FLOAT64_EXACT_INT
    )  # уже отмасштабировано под decimals рынка — lib/lighter.ts
    price: int = Field(
        gt=0, le=_FLOAT64_EXACT_INT
    )  # уже отмасштабировано под supported_price_decimals рынка
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

    async with _submit_lock:
        now = time.time()
        cached = _idempotency_cache.get(req.client_order_index)
        if cached and (now - cached[1]) < _IDEMPOTENCY_TTL:
            return {"tx_hash": cached[0], "dry_run": False, "idempotent_replay": True}

        try:
            client = _get_client()
        except (RuntimeError, KeyError, ValueError) as e:
            raise HTTPException(
                status_code=400, detail=f"Настройка сервиса неполная: {e}"
            )

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
            raise HTTPException(
                status_code=400, detail=f"Lighter отклонил ордер: {err}"
            )

        _remember(req.client_order_index, tx_hash, now)
        return {"tx_hash": tx_hash, "dry_run": False, "idempotent_replay": False}


@app.exception_handler(HTTPException)
async def unified_http_error(request: Request, exc: HTTPException):
    """Ответ читает фронтенд, и формат у него один — см. _error()."""
    return _error(exc.status_code, "SIGNING_ERROR", str(exc.detail))


@app.exception_handler(Exception)
async def unified_unexpected_error(request: Request, exc: Exception):
    """Неожиданное — тоже единый формат, иначе вместо него клиент получает
    текстовое «Internal Server Error» и человек читает его как ответ биржи."""
    logger.exception("signing: необработанная ошибка запроса")
    return _error(500, "SIGNING_INTERNAL", "Сервис подписи не справился с запросом")


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
