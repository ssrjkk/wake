"""
AI-агент и подписка: /agent/*, /subscription/*. Логика уже протестирована
отдельно (agent_memory 14, agent_decision 11, llm_agent fallback-путь,
agent_runner dry-run путь, subscription 10). Этот слой — HTTP-обвязка +
in-memory состояние (не БД — сознательно: память агента и подписки не
критичны для персистентности в этом прототипе так, как критична финансовая
база копи-трейдинга и предсказаний).

Перенесено из app.py при рефакторинге — см. api/copy_trading.py.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from agent_memory import AgentMemoryStore
from agent_runner import run_agent_step
from risk_limits import UserRiskState
from subscription import start_trial, upgrade_to_pro

router = APIRouter()

_agent_memories: dict = {}      # user_id -> AgentMemoryStore
_subscriptions: dict = {}       # user_id -> Subscription
# Состояние лимитов риска живёт столько же, сколько процесс: без него run_agent_step
# каждый раз получает пустой UserRiskState, и дневной объём не накапливался бы вовсе.
_risk_states: dict = {}         # user_id -> UserRiskState


def _get_memory(user_id: str) -> AgentMemoryStore:
    if user_id not in _agent_memories:
        _agent_memories[user_id] = AgentMemoryStore()
    return _agent_memories[user_id]


def _get_risk_state(user_id: str) -> UserRiskState:
    if user_id not in _risk_states:
        _risk_states[user_id] = UserRiskState(user_id=user_id)
    return _risk_states[user_id]


class AgentStepRequest(BaseModel):
    user_id: str
    market_id: int
    recent_prices: list
    size_decimals: int = 4
    price_decimals: int = 0
    base_size_usd: float = 100


@router.post("/agent/step")
def agent_step(req: AgentStepRequest):
    memory = _get_memory(req.user_id)
    risk_state = _get_risk_state(req.user_id)
    decision, execution = run_agent_step(
        memory, req.market_id, req.recent_prices, req.size_decimals, req.price_decimals,
        req.base_size_usd, risk_state=risk_state,
    )
    return {
        "action": decision.action, "confidence": decision.confidence,
        "size_usd": decision.size_usd, "reasoning": decision.reasoning,
        "execution": execution,
        "volume_today_usd": risk_state.volume_today_usd,
    }


@router.get("/agent/memory/{user_id}")
def agent_memory_view(user_id: str):
    memory = _get_memory(user_id)
    return {
        "summary": memory.summarize_for_reasoning(),
        "open_trades": [t.__dict__ for t in memory.open_trades()],
        "closed_trades": [t.__dict__ for t in memory.closed_trades()],
        "win_rate": memory.win_rate(),
        "volume_today_usd": _get_risk_state(user_id).volume_today_usd,
    }


@router.post("/subscription/{user_id}/start-trial")
def subscription_start_trial(user_id: str):
    if user_id in _subscriptions:
        raise HTTPException(status_code=400, detail="подписка уже существует для этого пользователя")
    sub = start_trial(user_id)
    _subscriptions[user_id] = sub
    return {"tier": sub.tier.value, "trial_started_at": sub.trial_started_at}


@router.post("/subscription/{user_id}/upgrade")
def subscription_upgrade(user_id: str):
    sub = _subscriptions.get(user_id)
    if sub is None:
        raise HTTPException(status_code=404, detail="нет подписки — сначала /start-trial")
    upgraded = upgrade_to_pro(sub)
    _subscriptions[user_id] = upgraded
    return {"tier": upgraded.tier.value}


@router.get("/subscription/{user_id}")
def subscription_status(user_id: str):
    sub = _subscriptions.get(user_id)
    if sub is None:
        return {"tier": "none", "has_ai_agent": False, "has_copy_trading": False, "has_predict_markets": False}
    return {
        "tier": sub.effective_tier().value,
        "days_left_in_trial": sub.days_left_in_trial(),
        "has_ai_agent": sub.has_feature("ai_agent"),
        "has_copy_trading": sub.has_feature("copy_trading"),
        "has_predict_markets": sub.has_feature("predict_markets"),
    }