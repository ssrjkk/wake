"""
ИИ-агент и подписка: /agent/*, /subscription/*. Логика уже протестирована
отдельно (agent_memory 14, agent_decision 11, llm_agent fallback-путь,
agent_runner dry-run путь, subscription 10). Этот слой — HTTP-обвязка.

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
from functools import partial

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator
from starlette.concurrency import run_in_threadpool

import agent_db
from api.guards import deny, require_curator, require_user
from agent_runner import run_agent_step
from subscription import Subscription, Tier

router = APIRouter()

# Цена шага ограничена не жадностью: recent_prices читается целиком, а решение
# строится по последним значениям. Тысяча элементов в массиве — это лишний CPU
# на каждом запросе, который к тому же приходит от того же клиента, что и цены.
_MAX_PRICES = 500


class AgentStepRequest(BaseModel):
    market_id: int
    recent_prices: list[float]
    size_decimals: int = 4
    price_decimals: int = 0
    base_size_usd: float = 100

    @field_validator("recent_prices")
    @classmethod
    def prices_are_usable(cls, v: list[float]) -> list[float]:
        if not v or len(v) > _MAX_PRICES:
            raise ValueError(f"recent_prices — от 1 до {_MAX_PRICES} значений")
        if not all(math.isfinite(p) and p > 0 for p in v):
            raise ValueError("цены должны быть положительными и конечными")
        return v

    @field_validator("base_size_usd")
    @classmethod
    def size_is_usable(cls, v: float) -> float:
        if not math.isfinite(v) or v <= 0:
            raise ValueError("base_size_usd — положительное конечное число")
        return v


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
    memory = await agent_db.load_memory(user_id)
    risk_state = await agent_db.risk_state_today(user_id)

    # В threadpool, а не в event loop: при выключенном WAKE_DRY_RUN шаг делает
    # блокирующий urllib-запрос к signing_service, и в ожидании ордера встал бы
    # весь процесс, а не только этот запрос.
    step = partial(
        run_agent_step,
        memory,
        req.market_id,
        req.recent_prices,
        req.size_decimals,
        req.price_decimals,
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
    if sub is None:
        return {
            "tier": "none",
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
    sub = await agent_db.set_tier(user_id, Tier.PRO)
    if sub is None:
        raise deny(
            404,
            "SUBSCRIPTION_NOT_FOUND",
            "У пользователя нет подписки — Pro выдаётся только поверх трайла",
        )
    return _subscription_body(sub)
