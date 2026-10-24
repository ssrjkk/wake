"""
Ядро копи-движка: чистая логика вычисления зеркальных ордеров.

Никакого исполнения, никаких приватных ключей, никакой сети — только математика.
Именно поэтому план копи-движка тестируется без Lighter, без ключей и без сети:
тестам достаточно событий лидера и конфига подписчика.

Как это стыкуется с остальным:

    leader_listener.py (событие лидера по WS)
      --> [этот файл] --> MirrorOrder[]
      --> EncryptedKeyStore.get_key(follower_id)   # API-ключ именно этого подписчика
      --> lighter.SignerClient.create_order --> Lighter

Исполнение живёт НЕ здесь: ключ и сетевой вызов остаются снаружи чистой логики.
place_order_example.py и signing_service.py — те же вызовы create_order, но
вручную, для одной сделки, без копи-движка.

Этот файл явно отвечает на две развилки, которые иначе решились бы молча:

  - "что если у подписчика не хватило маржи?"
    -> здесь: явный skip с причиной в MirrorPlan.skipped, не тихий сбой и не
       произвольное урезание без объяснения.

  - "лидер закрывает — как ведут себя подписчики?"
    -> здесь: пропорциональное закрытие от ТЕКУЩЕГО зеркального размера
       подписчика (сколько у НЕГО открыто), а не пересчёт от позиции лидера —
       подписчик мог зайти позже лидера, с другим размером и по другой цене,
       и должен закрываться от своей позиции, а не от чужой.

Модель сайзинга — proportional risk, не 1:1 копирование размера. Лидер с
$50,000 на счету и подписчик с $200 аллокации НЕ должны выставлять одинаковый
базовый размер ордера — подписчик получает ту же ДОЛЮ риска от СВОЕЙ аллокации,
какую лидер берёт от своего equity. Это осознанный выбор модели, а не то, что
осталось недоработанным: 1:1 по базовому размеру здесь было бы багом.
"""

from dataclasses import dataclass, field
from enum import Enum

from quant import is_finite, round_down


class Side(Enum):
    LONG = "long"
    SHORT = "short"


@dataclass(frozen=True)
class LeaderEvent:
    market_id: int
    side: Side
    is_increase: bool  # True = открытие/наращивание, False = уменьшение/закрытие
    size_delta: float  # изменение размера позиции лидера, base-units, всегда > 0
    price: float  # цена исполнения (для маркет-ордеров — примерная)
    leader_equity_usd: (
        float  # equity лидера на момент сделки — обязателен при is_increase
    )
    leader_position_before: float = 0.0  # размер позиции лидера ДО этого изменения —
    # обязателен при not is_increase, для доли закрытия


@dataclass(frozen=True)
class MarketConstraints:
    min_base_amount: float
    size_decimals: int
    price_decimals: int
    """price_decimals — не для расчёта размера, а для исполнения: Lighter ждёт
    цену целым числом в тиках рынка (price * 10**supported_price_decimals), и
    шаг цены у рынков разный (SMIC — 4, ETH — у книги свой). Без него листенер
    отправлял int(0.16) = 0 для DOGE и 110000 вместо 11000000 для BTC."""


@dataclass(frozen=True)
class FollowerConfig:
    follower_id: str
    allocation_usd: float
    available_margin_usd: float
    max_leverage: float
    current_mirrored_size: float = 0.0  # текущий размер зеркальной позиции подписчика


@dataclass(frozen=True)
class MirrorOrder:
    follower_id: str
    market_id: int
    side: Side
    base_amount: float
    reduce_only: bool


@dataclass(frozen=True)
class SkippedFollower:
    follower_id: str
    reason: str  # "event_data_unavailable" | "leader_equity_unavailable" |
    # "price_unavailable" | "follower_data_unavailable" | "below_min_order_size" |
    # "mirror_size_uncomputable" | "no_mirrored_position_to_reduce" |
    # "leader_position_before_unavailable" | "mirrored_size_unavailable" |
    # "reduce_amount_below_min"


@dataclass(frozen=True)
class MirrorPlan:
    orders: list = field(default_factory=list)  # list[MirrorOrder]
    skipped: list = field(default_factory=list)  # list[SkippedFollower]


def _size_on_grid(value: float, decimals: int) -> float | None:
    """Размер ордера, приведённый к шагу рынка, или None.

    None — это не «размер нулевой», а «этого размера не существует»: значение
    неконечное (inf от переполнения произведения) либо конечное, но шире
    точности Decimal (число из 29 разрядов при 28 в контексте). quant.round_down
    на такое бросает ValueError, и если его не поймать здесь, исключение уйдёт
    наружу из compute_mirror_plan — а её вызывает цикл вебсокета
    (leader_listener.py), где один неподъёмный размер стоил бы зеркалирования
    всем остальным подписчикам по этому событию. План обязан отвечать причиной на
    каждого подписчика, а не исключением."""
    try:
        return round_down(value, decimals)
    except ValueError:
        return None


def compute_mirror_plan(
    event: LeaderEvent,
    followers: list,  # list[FollowerConfig]
    constraints: MarketConstraints,
) -> MirrorPlan:
    plan = MirrorPlan()

    if event.is_increase:
        # Цена и доля риска приходят из вебсокета Lighter и из diff-а трекера,
        # то есть из-за границы, где никто их не валидировал. Проверка одна и до
        # ветвления: `NaN <= 0` — это False, и без неё NaN доходил до ордера.
        if not all(
            is_finite(v)
            for v in (event.price, event.size_delta, event.leader_equity_usd)
        ):
            for f in followers:
                plan.skipped.append(
                    SkippedFollower(f.follower_id, "event_data_unavailable")
                )
            return plan

        if event.leader_equity_usd <= 0:
            for f in followers:
                plan.skipped.append(
                    SkippedFollower(f.follower_id, "leader_equity_unavailable")
                )
            return plan

        if event.price <= 0:
            # Цена нужна дважды: как стоимость ноги лидера и как делитель при
            # переводе desired_notional обратно в базовые единицы. С нулём
            # второй шаг — ZeroDivisionError посреди вебсокет-цикла.
            for f in followers:
                plan.skipped.append(SkippedFollower(f.follower_id, "price_unavailable"))
            return plan

        leader_notional = event.size_delta * event.price
        leader_risk_fraction = leader_notional / event.leader_equity_usd

        for f in followers:
            # Числа подписчика — из колонок Float той же строки follows, где
            # спокойно живёт NaN. Оставлять такую строку на расчёт нельзя не
            # потому, что NaN «заразит» размер (round_down ниже на нём
            # споткнётся), а потому что min() с NaN возвращает НЕ NaN:
            # min(desired, NaN) = desired, то есть подписчик с битой маржой
            # получил бы ордер, рассчитанный так, будто потолка маржи нет. При
            # этом исход решения не был бы виден в mirror_log.
            if not all(
                is_finite(v)
                for v in (f.allocation_usd, f.available_margin_usd, f.max_leverage)
            ):
                plan.skipped.append(
                    SkippedFollower(f.follower_id, "follower_data_unavailable")
                )
                continue

            desired_notional = leader_risk_fraction * f.allocation_usd
            max_notional_by_margin = f.available_margin_usd * f.max_leverage
            capped_notional = min(desired_notional, max_notional_by_margin)

            base_amount = _size_on_grid(
                capped_notional / event.price, constraints.size_decimals
            )

            if base_amount is None:
                plan.skipped.append(
                    SkippedFollower(f.follower_id, "mirror_size_uncomputable")
                )
                continue

            if base_amount < constraints.min_base_amount:
                plan.skipped.append(
                    SkippedFollower(f.follower_id, "below_min_order_size")
                )
                continue

            plan.orders.append(
                MirrorOrder(
                    f.follower_id,
                    event.market_id,
                    event.side,
                    base_amount,
                    reduce_only=False,
                )
            )
        return plan

    # --- уменьшение / закрытие лидером ---
    if not all(is_finite(v) for v in (event.size_delta, event.leader_position_before)):
        for f in followers:
            plan.skipped.append(
                SkippedFollower(f.follower_id, "event_data_unavailable")
            )
        return plan

    for f in followers:
        if not is_finite(f.current_mirrored_size):
            # Свой же NaN: строка подписчика пришла из базы, а база умеет хранить
            # Float('nan'), и проверка ниже (`<= 0`) его не замечает.
            plan.skipped.append(
                SkippedFollower(f.follower_id, "mirrored_size_unavailable")
            )
            continue

        if f.current_mirrored_size <= 0:
            plan.skipped.append(
                SkippedFollower(f.follower_id, "no_mirrored_position_to_reduce")
            )
            continue

        if event.leader_position_before <= 0:
            plan.skipped.append(
                SkippedFollower(f.follower_id, "leader_position_before_unavailable")
            )
            continue

        close_fraction = min(1.0, event.size_delta / event.leader_position_before)
        reduce_amount = _size_on_grid(
            f.current_mirrored_size * close_fraction, constraints.size_decimals
        )

        if reduce_amount is None:
            plan.skipped.append(
                SkippedFollower(f.follower_id, "mirror_size_uncomputable")
            )
            continue

        if reduce_amount < constraints.min_base_amount:
            plan.skipped.append(
                SkippedFollower(f.follower_id, "reduce_amount_below_min")
            )
            continue

        plan.orders.append(
            MirrorOrder(
                f.follower_id,
                event.market_id,
                event.side,
                reduce_amount,
                reduce_only=True,
            )
        )

    return plan
