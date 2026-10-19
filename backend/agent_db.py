"""
Слой доступа к PostgreSQL для ИИ-агента и подписки: agent_trades, subscriptions.

До этого оба состояния жили словарями в процессе api/agent.py, и это была не
экономия, а две дыры:

- трайл сбрасывался рестартом. 14 дней «попробую» можно было получать заново на
  каждом деплое, а на Railway деплой — это и есть рестарт;
- память агента (сделки, win_rate, открытые позиции) умирала вместе с процессом,
  и дневной лимит объёма тоже обнулялся при каждом рестарте — то есть лимит,
  который должен ограничивать ущерб, действовал ровно до следующего выката.

Сделки агента пишутся в agent_trades с user_id и статусом (dry_run / sent /
failed), потому что иначе симуляция и реальные ордера лежат в одной таблице, и
через неделю по ней уже не сказать, что агент действительно исполнял.

UserRiskState отдельно не хранится: он выводится из тех же строк (см.
risk_state_today). Держать вторую копию дневного объёма значило бы иметь два
ответа на вопрос «сколько уже можно», и они бы разошлись.
"""

from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from agent_memory import AgentMemoryStore, TradeRecord
from database import async_session_factory
from pg_models import AgentTrade, Subscription as SubscriptionRow
from risk_limits import UserRiskState
from subscription import Subscription, Tier

_TIER_BY_NAME = {t.value: t for t in Tier}


class PendingMemory(AgentMemoryStore):
    """Память, которая записывает за собой.

    AgentMemoryStore остаётся чистой структурой данных без знания про базу:
    шаг агента синхронный (run_agent_step пишет в память по ходу), а запись в
    PostgreSQL может быть только в event loop. Поэтому сделка сначала попадает в
    pending, а flush_memory() дописывает её в базу, когда управление возвращается
    в обработчик."""

    def __init__(self, user_id: str):
        super().__init__()
        self.user_id = user_id
        self.pending: list[tuple[str, TradeRecord]] = []

    def record_open(self, *args, **kwargs) -> TradeRecord:
        t = super().record_open(*args, **kwargs)
        self.pending.append(("open", t))
        return t

    def record_close(self, trade_id: str, exit_price: float) -> TradeRecord:
        t = super().record_close(trade_id, exit_price)
        self.pending.append(("close", t))
        return t


def _record(r: AgentTrade) -> TradeRecord:
    return TradeRecord(
        id=r.id,
        market_id=r.market_id,
        side=r.side,
        entry_price=r.entry_price,
        size=r.size,
        opened_at=r.opened_at.timestamp(),
        context_note=r.context_note,
        exit_price=r.exit_price,
        closed_at=r.closed_at.timestamp() if r.closed_at else None,
    )


async def load_memory(user_id: str) -> PendingMemory:
    """Вся история агента пользователя — в рабочую память.

    Гидрируем на каждый шаг, а не кэшируем в процессе: история на десятки
    строк, а кэш означал бы, что второй воркер видит чужие записи в своём
    состоянии и разминулся бы с первым."""
    async with async_session_factory() as session:
        rows = (
            await session.scalars(
                select(AgentTrade)
                .where(AgentTrade.user_id == user_id)
                .order_by(AgentTrade.opened_at.asc(), AgentTrade.id.asc())
            )
        ).all()
    memory = PendingMemory(user_id)
    memory.trades = [_record(r) for r in rows]
    return memory


async def flush_memory(memory: PendingMemory, status: str) -> None:
    """Дозаписать то, что память набрала за шаг.

    status — чем закончился шаг (dry_run / sent / failed): он относится ко всем
    записям этого прогона, поэтому приходит извне, а не хранится в памяти."""
    if not memory.pending:
        return
    async with async_session_factory() as session:
        for kind, t in memory.pending:
            if kind == "open":
                await session.execute(
                    insert(AgentTrade)
                    .values(
                        id=t.id,
                        user_id=memory.user_id,
                        market_id=t.market_id,
                        side=t.side,
                        entry_price=t.entry_price,
                        size=t.size,
                        context_note=t.context_note,
                        opened_at=datetime.fromtimestamp(t.opened_at, UTC),
                        status=status,
                    )
                    .on_conflict_do_nothing(index_elements=["id"])
                )
            else:
                await session.execute(
                    update(AgentTrade)
                    .where(AgentTrade.id == t.id)
                    .values(
                        exit_price=t.exit_price,
                        closed_at=datetime.fromtimestamp(t.closed_at, UTC),
                    )
                )
        await session.commit()
    memory.pending.clear()


def _day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


async def risk_state_today(user_id: str) -> UserRiskState:
    """Дневной объём и открытые позиции — из agent_trades, а не из счётчика в
    памяти.

    Ножки считаются отдельно: покупка и продажа одной и той же сделки — два
    исполнения, и прежний UserRiskState списывал на них лимит дважды же, чем
    record_executed() при шаге. Граница дня — UTC: локальный часовой пояс
    сервера делал бы «сегодня» зависимым от того, где стоит контейнер."""
    now = datetime.now(UTC)
    async with async_session_factory() as session:
        rows = (
            await session.scalars(
                select(AgentTrade).where(
                    AgentTrade.user_id == user_id,
                    (AgentTrade.opened_at >= _day_start(now))
                    | (AgentTrade.closed_at >= _day_start(now)),
                )
            )
        ).all()
    state = UserRiskState(user_id=user_id)
    for r in rows:
        if r.opened_at >= _day_start(now):
            state.volume_today_usd += r.size * r.entry_price
        if r.closed_at is not None and r.closed_at >= _day_start(now):
            state.volume_today_usd += r.size * r.exit_price
        if r.closed_at is None:
            state.open_position_usd[r.market_id] = (
                state.open_position_usd.get(r.market_id, 0.0) + r.size * r.entry_price
            )
    return state


# ── Подписка ─────────────────────────────────────────────────────────────────


def _subscription(row: SubscriptionRow) -> Subscription:
    return Subscription(
        user_id=row.user_id,
        tier=_TIER_BY_NAME.get(row.tier, Tier.FREE),
        started_at=row.started_at.timestamp(),
        trial_started_at=row.trial_started_at.timestamp()
        if row.trial_started_at
        else None,
    )


async def get_subscription(user_id: str) -> Subscription | None:
    async with async_session_factory() as session:
        row = await session.scalar(
            select(SubscriptionRow).where(SubscriptionRow.user_id == user_id)
        )
        return _subscription(row) if row else None


async def ensure_trial(user_id: str) -> Subscription:
    """Выдать трайл, если подписки ещё нет; существующую — вернуть как есть.

    ON CONFLICT DO NOTHING, а не DO UPDATE: повторный вызов /start-trial не
    должен двигать trial_started_at, иначе трайл становится возобновляемым по
    одному клику. Отдельно заметим: это защита от «продлить самому себе», а не
    от «завести второй кошелёк» — с некастодиальным входом новый адрес это
    новый пользователь, и честного способа отказать ему без оплаты нет."""
    now = datetime.now(UTC)
    async with async_session_factory() as session:
        await session.execute(
            insert(SubscriptionRow)
            .values(
                user_id=user_id,
                tier=Tier.FREE_TRIAL.value,
                started_at=now,
                trial_started_at=now,
            )
            .on_conflict_do_nothing(index_elements=["user_id"])
        )
        await session.commit()
        row = await session.scalar(
            select(SubscriptionRow).where(SubscriptionRow.user_id == user_id)
        )
    return _subscription(row)


async def set_tier(user_id: str, tier: Tier) -> Subscription | None:
    """Сменить тир. rowcount == 0 — подписки нет, и апгрейд её не создаёт:
    /upgrade только для той строки, что уже заведена трайлом."""
    async with async_session_factory() as session:
        result = await session.execute(
            update(SubscriptionRow)
            .where(SubscriptionRow.user_id == user_id)
            .values(tier=tier.value)
        )
        await session.commit()
        if result.rowcount == 0:
            return None
        row = await session.scalar(
            select(SubscriptionRow).where(SubscriptionRow.user_id == user_id)
        )
    return _subscription(row)
