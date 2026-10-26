"""
ИИ-агент и подписка: /agent/*, /subscription/*. Логика протестирована отдельно
и по слоям: agent_memory (память и win_rate), agent_decision (правило),
llm_agent (fallback-путь без ключа и на битом JSON), agent_runner (dry-run путь
исполнения), subscription (тиры и трайл), test_api_smoke (этот слой целиком).
Этот файл — HTTP-обвязка.

Состояние, которое было словарями в процессе, переехало в PostgreSQL
(agent_db.py): трайл, сбрасываемый рестартом, и дневной лимит объёма,
обнуляемый деплоем, — это не «прототип без персистентности», а дыра.

Чем защищён этот слой:
- user_id нигде не принимается из запроса: это субъект токена сессии, и
  спросить «а чьё решение агента я сейчас смотрю» нечего;
- /agent/step дополнительно требует_feature("ai_agent") на стороне сервера.
  Фронт эту проверку тоже делает, но проверка на фронте — это подсказка, а не
  ограничение: до роута можно дойти curl'ом;
- /subscription/{user_id}/upgrade — под токеном куратора. Платёжного процесса
  здесь нет, и «нажми кнопку, получи Pro» это бесплатный Pro; когда оплата
  появится, эндпоинт уже не надо будет переделывать в дыру.
"""

import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

import agent_db
import lighter_rest
from api.guards import deny, require_curator, require_user
from agent_runner import run_agent_step
from config import LIGHTER_NETWORK
from database import engine
from subscription import Subscription

router = APIRouter()

# Разрешения /candles Lighter — тот же список, что у RESOLUTION_MS в
# lighter_rest.py; кривое значение здесь означает 422, а не тихий 1m-ряд.
Resolution = Literal["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"]

# Ключ advisory-лока шага. hashtextextended считается в самом PostgreSQL (см.
# _step_lock), поэтому текст ключа — единственное, что нужно знать: две сессии,
# попросившие один ключ, разойдутся по разные стороны замка.
_LOCK_NS = "wake:agent-step:"


@asynccontextmanager
async def _step_lock(user_id: str) -> AsyncIterator[None]:
    """По одному шагу агента на пользователя, через замок PostgreSQL.

    Шаг — это «прочитать память → прочитать дневной риск → решить → записать».
    Без взаимного исключения два параллельных запроса одного человека (две
    вкладки, двойной тап, curl в цикле) читают ОДИН и тот же `risk_state_today`
    и исполняют оба: лимит дневного объёма и лимит открытой позиции по рынку
    обходятся так, как обходить их не должно. В Predict от того же защищён
    FOR UPDATE по строке рынка; здесь объекта блокировки нет — риск считается
    агрегатом по многим строкам, поэтому замок лежит на пользователе.

    Замок сессионный, а не транзакционный: шаг переживает несколько сессий БД
    (load/risk/flush берут соединения из пула по очереди), и держать одно
    соединение занятым через сетевой запрос к Lighter нельзя. Долго держаться он
    не может: шаг стоит на запросах к Lighter, у которых свой таймаут и повторы,
    а соединение, с которого замок не удалось снять, инвалидируется — с сокетом
    умирает и замок, иначе следующий владелец соединения в пуле унаследовал бы
    чужую блокировку."""
    key = f"{_LOCK_NS}{user_id}"
    async with engine.connect() as conn:
        taken = await conn.execute(
            text("SELECT pg_try_advisory_lock(hashtextextended(:k, 0))"), {"k": key}
        )
        acquired = bool(taken.scalar())
        await conn.commit()
        if not acquired:
            raise deny(
                409,
                "AGENT_STEP_IN_PROGRESS",
                "Предыдущий шаг агента ещё считается — дождись ответа, прежде чем "
                "запускать второй: лимиты проверяются по тому, что уже записано",
            )
        try:
            yield
        finally:
            try:
                await conn.execute(text("SELECT pg_advisory_unlock_all()"))
                await conn.commit()
            except Exception:
                conn.invalidate()


class AgentStepRequest(BaseModel):
    """market_id, разрешение и глубина ряда — и больше ничего про данные.

    Раньше recent_prices, size_decimals и price_decimals приезжали в теле
    запроса. Это не «данные клиента», а вход денежного пути: по присланному
    ряду считались momentum, цена исполнения и размер, а лимиты дневного
    объёма и открытой позиции — тоже по нему. Прислав свой «ряд» и свои
    decimals, клиент получал агента, который исполняет то, что он написал, а
    не то, что видно на рынке; проверка на входе (конечность, > 0) от этого не
    спасает — она проверяет форму, а не правду.

    Цены и ограничения рынка теперь берутся из Lighter здесь же, где и
    считается решение. Наружу уходит, каким рядом считать приходилось —
    иначе ответ нельзя сверить с тем, что человек видит на графике."""

    market_id: int
    resolution: Resolution = "1h"
    candles: int = Field(default=60, ge=2, le=200)
    base_size_usd: float = Field(default=100, gt=0, le=1_000_000, allow_inf_nan=False)


def _market_constraints(market_id: int) -> dict:
    """market_id -> шаг и минимум рынка из живой книги (кэш 30 с, cache.py).

    Активный рынок без любого из двух decimals — это 502, а не 500: поля
    приходят из ответа Lighter, и `int()` от отсутствующего или кривого значения
    бросило бы KeyError/ValueError наружу из обработчика. В leader_listener.py
    build_constraints() такие строки просто отсеивает, здесь рынок один и
    отсеивать нечего — остаётся честно сказать, что данных нет."""
    for book in lighter_rest.get_order_books(LIGHTER_NETWORK):
        try:
            if int(book["market_id"]) != market_id:
                continue
        except (KeyError, TypeError, ValueError):
            continue
        if book.get("status") != "active":
            raise deny(
                409,
                "MARKET_NOT_ACTIVE",
                f"рынок {market_id} не активен — ордер в него поставить нельзя",
            )
        try:
            return {
                "size_decimals": int(book["supported_size_decimals"]),
                "price_decimals": int(book["supported_price_decimals"]),
                "symbol": str(book.get("symbol", "")),
            }
        except (KeyError, TypeError, ValueError):
            raise deny(
                502,
                "MARKET_DATA_UNUSABLE",
                f"у активного рынка {market_id} в книге Lighter нет supported_size_"
                "decimals / supported_price_decimals — масштаб ордера неизвестен",
            ) from None
    raise deny(404, "MARKET_NOT_FOUND", f"рынка {market_id} нет в книге Lighter")


def _candle_closes(market_id: int, resolution: str, count: int) -> list[float]:
    candles = lighter_rest.get_candles(market_id, resolution, count, LIGHTER_NETWORK)
    closes = []
    for c in candles:
        try:
            closes.append(float(c["c"]))
        except (KeyError, TypeError, ValueError):
            continue
    if len(closes) < 2 or not all(math.isfinite(x) and x > 0 for x in closes):
        raise deny(
            502,
            "MARKET_DATA_UNUSABLE",
            f"Lighter не отдал годный ряд свечей по рынку {market_id} "
            f"({resolution}) — агент не решает по пустому или битому ряду",
        )
    return closes


async def _subscription(user_id: str) -> Subscription | None:
    return await agent_db.get_subscription(user_id)


async def _require_feature(user_id: str, feature: str) -> Subscription:
    """Тир определяется по строке подписки в базе, а не по словам клиента.

    Без подписки человек существует ровно как «free»: терминал и Discover
    открыты, агент — нет. Трайл заводится сам, без оплаты и без куратора."""
    sub = await _subscription(user_id)
    if sub is None or not sub.has_feature(feature):
        raise deny(
            403,
            "FEATURE_NOT_AVAILABLE",
            f"Функция «{feature}» недоступна: нужен trial или Pro",
        )
    return sub


@router.post("/agent/step")
async def agent_step(req: AgentStepRequest, user_id: str = Depends(require_user)):
    await _require_feature(user_id, "ai_agent")
    async with _step_lock(user_id):
        memory = await agent_db.load_memory(user_id)
        risk_state = await agent_db.risk_state_today(user_id)

        # Данные для решения и для расчёта риска берутся здесь, а не из тела запроса.
        # В threadpool, потому что _get у lighter_rest блокирующий urllib: в event
        # loop он остановил бы весь процесс на время запроса к Lighter.
        constraints = await run_in_threadpool(_market_constraints, req.market_id)
        closes = await run_in_threadpool(
            _candle_closes, req.market_id, req.resolution, req.candles
        )

        step = partial(
            run_agent_step,
            memory,
            req.market_id,
            closes,
            constraints["size_decimals"],
            constraints["price_decimals"],
            req.base_size_usd,
            risk_state=risk_state,
        )
        decision, execution = await run_in_threadpool(step)

        # Пустой pending — шаг ничего не исполнил (hold, skip, block); записывать нечего.
        if memory.pending:
            await agent_db.flush_memory(memory, execution["status"])

    return {
        "action": decision.action,
        "confidence": decision.confidence,
        "size_usd": decision.size_usd,
        "reasoning": decision.reasoning,
        "execution": execution,
        "volume_today_usd": risk_state.volume_today_usd,
        "data": {
            "symbol": constraints["symbol"],
            "resolution": req.resolution,
            "candles_used": len(closes),
            "last_price": closes[-1],
            "network": LIGHTER_NETWORK,
        },
    }


@router.get("/agent/memory")
async def agent_memory_view(user_id: str = Depends(require_user)):
    memory = await agent_db.load_memory(user_id)
    risk_state = await agent_db.risk_state_today(user_id)
    return {
        "summary": memory.summarize_for_reasoning(),
        "open_trades": [t.__dict__ for t in memory.open_trades()],
        "closed_trades": [t.__dict__ for t in memory.closed_trades()],
        "win_rate": memory.win_rate(),
        "volume_today_usd": risk_state.volume_today_usd,
    }


def _subscription_body(sub: Subscription | None) -> dict:
    """Один и тот же набор ключей при подписке и без неё: фронт читает
    `days_left_in_trial` без проверки на месте, и отсутствие ключа в одном из
    двух ответов — это undefined в интерфейсе вместо «считать нечего»."""
    if sub is None:
        return {
            "tier": "none",
            "days_left_in_trial": None,
            "has_ai_agent": False,
            "has_copy_trading": False,
            "has_predict_markets": False,
        }
    return {
        "tier": sub.effective_tier().value,
        "days_left_in_trial": sub.days_left_in_trial(),
        "has_ai_agent": sub.has_feature("ai_agent"),
        "has_copy_trading": sub.has_feature("copy_trading"),
        "has_predict_markets": sub.has_feature("predict_markets"),
    }


@router.get("/subscription")
async def subscription_status(user_id: str = Depends(require_user)):
    return _subscription_body(await _subscription(user_id))


@router.post("/subscription/trial")
async def subscription_start_trial(user_id: str = Depends(require_user)):
    """14 дней бесплатно, один раз на пользователя.

    Повторный вызов не обнуляет trial_started_at (см. agent_db.ensure_trial),
    поэтому трайл больше не возобновляется ни рестартом процесса, ни своим же
    запросом."""
    sub = await agent_db.ensure_trial(user_id)
    return _subscription_body(sub)


@router.post("/subscription/{user_id}/upgrade", dependencies=[Depends(require_curator)])
async def subscription_upgrade(user_id: str):
    """Выдать Pro конкретному человеку. Цель берётся из пути, а не из токена: это
    действует оператор, а пользователь Pro себе не назначает — поэтому эндпоинт
    под токеном куратора, и своего входа для него мало.

    404, а не «создали бы подписку на ходу»: апгрейд — про длинное использование,
    а трайл остаётся единственной точкой входа в подписку."""
    sub = await agent_db.upgrade(user_id)
    if sub is None:
        raise deny(
            404,
            "SUBSCRIPTION_NOT_FOUND",
            "У пользователя нет подписки — Pro выдаётся только поверх трайла",
        )
    return _subscription_body(sub)
