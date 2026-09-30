"""
Подписка и фича-гейтинг. Обычная SaaS-логика — никакой инфраструктурной
неопределённости здесь нет (в отличие от кастодии или деплоя), поэтому это
полностью написано и протестировано, не наполовину.

Оплата сама (Stripe/крипто-платёж) — не здесь: это реальная интеграция с
реальным платёжным процессором, которую нельзя протестировать без сети и
без настоящего аккаунта, тот же принцип, что с fastapi/websockets весь
разговор. Здесь — то, что оплата ДОЛЖНА разблокировать, чистая логика.
"""

import time
from dataclasses import dataclass
from enum import Enum


class Tier(Enum):
    FREE_TRIAL = "free_trial"
    FREE = "free"
    PRO = "pro"


TRIAL_DURATION_DAYS = 14

# Что разблокирует каждый тир — единственный источник правды, не разбросано по коду.
FEATURES = {
    Tier.FREE: {"terminal_view", "discover_view"},
    Tier.FREE_TRIAL: {"terminal_view", "discover_view", "copy_trading", "ai_agent", "predict_markets"},
    Tier.PRO: {"terminal_view", "discover_view", "copy_trading", "ai_agent", "predict_markets", "priority_execution"},
}


@dataclass
class Subscription:
    user_id: str
    tier: Tier
    started_at: float
    trial_started_at: float | None = None

    def is_trial_expired(self, now: float | None = None) -> bool:
        if self.tier != Tier.FREE_TRIAL or self.trial_started_at is None:
            return False
        now = now if now is not None else time.time()
        return (now - self.trial_started_at) > TRIAL_DURATION_DAYS * 86400

    def effective_tier(self, now: float | None = None) -> Tier:
        """Тир с учётом истёкшего трайла — не то же самое, что self.tier напрямую,
        поэтому это отдельный метод, а не поле."""
        if self.is_trial_expired(now):
            return Tier.FREE
        return self.tier

    def has_feature(self, feature: str, now: float | None = None) -> bool:
        return feature in FEATURES.get(self.effective_tier(now), set())

    def days_left_in_trial(self, now: float | None = None) -> float | None:
        if self.tier != Tier.FREE_TRIAL or self.trial_started_at is None:
            return None
        now = now if now is not None else time.time()
        elapsed_days = (now - self.trial_started_at) / 86400
        return max(0.0, TRIAL_DURATION_DAYS - elapsed_days)


def start_trial(user_id: str, now: float | None = None) -> Subscription:
    now = now if now is not None else time.time()
    return Subscription(user_id=user_id, tier=Tier.FREE_TRIAL, started_at=now, trial_started_at=now)


def upgrade_to_pro(sub: Subscription, now: float | None = None) -> Subscription:
    """Апгрейд — новый объект, не мутация на месте, чтобы вызывающий код не мог
    случайно забыть сохранить изменение в базу."""
    now = now if now is not None else time.time()
    return Subscription(user_id=sub.user_id, tier=Tier.PRO, started_at=now, trial_started_at=sub.trial_started_at)
