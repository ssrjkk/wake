"""
[!]  Не тестировалось — нет сети на pip install stripe, нет Stripe-аккаунта здесь.
Стандартный, документированный паттерн Stripe Checkout + webhook, не выдуман.

pip install stripe
Реальные STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PRICE_ID_PRO —
с dashboard.stripe.com, тестовый режим сначала (sk_test_...), не sk_live_...
пока весь путь не проверен вручную.
"""

import os

try:
    import stripe
except ImportError:
    stripe = None

from subscription import upgrade_to_pro, Subscription, Tier

STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET")
STRIPE_PRICE_ID_PRO = os.environ.get("STRIPE_PRICE_ID_PRO")

if stripe and STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY


def create_checkout_session(user_id: str, success_url: str, cancel_url: str) -> str:
    if stripe is None:
        raise RuntimeError("stripe не установлен — pip install stripe")
    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": STRIPE_PRICE_ID_PRO, "quantity": 1}],
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=user_id,  # так находим, кого апгрейдить, в вебхуке ниже
    )
    return session.url


def apply_event(event_type: str, event_object: dict, subscriptions: dict) -> dict:
    """Чистая часть: что делать с уже распарсенным событием. Отделена от
    construct_event() специально, чтобы это можно было тестировать без stripe
    вообще — см. test_stripe_billing.py."""
    if event_type == "checkout.session.completed":
        user_id = event_object.get("client_reference_id")
        if not user_id:
            return {"status": "ignored", "reason": "no client_reference_id"}
        if user_id in subscriptions:
            subscriptions[user_id] = upgrade_to_pro(subscriptions[user_id])
        else:
            subscriptions[user_id] = Subscription(user_id=user_id, tier=Tier.PRO, started_at=0)
        return {"status": "upgraded", "user_id": user_id}

    if event_type == "customer.subscription.deleted":
        user_id = event_object.get("client_reference_id")
        if not user_id or user_id not in subscriptions:
            return {"status": "ignored", "reason": "unknown user_id"}
        sub = subscriptions[user_id]
        subscriptions[user_id] = Subscription(user_id=user_id, tier=Tier.FREE, started_at=sub.started_at)
        return {"status": "downgraded", "user_id": user_id}

    return {"status": "ignored", "type": event_type}


def handle_webhook(payload: bytes, sig_header: str, subscriptions: dict) -> dict:
    """Проверка подписи (нужен stripe) + вызов apply_event() (не нужен)."""
    if stripe is None:
        raise RuntimeError("stripe не установлен — pip install stripe")
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as e:
        return {"status": "invalid_signature", "error": str(e)}
    return apply_event(event["type"], event["data"]["object"], subscriptions)
