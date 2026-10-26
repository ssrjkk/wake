"""
Слой доступа к PostgreSQL для модуля предсказаний: predict_markets /
predict_positions / predict_trades. Отдельная от db.py (копи-трейдинг) схема —
разные продуктовые модули, но общая identity: user_id здесь = тот же
followers.id, что и в копи-трейдинге, чтобы не заводить второй логин.

record_trade() — единственное место, где меняется q_yes/q_no рынка, позиция
юзера и лог сделки — всё в одной транзакции. Разойтись эти три вещи не должны
никогда, поэтому это одна функция, а не три вызываемые по отдельности.

Раньше это был SQLite-файл. Файл в контейнере живёт до ближайшего рестарта, а
в этих таблицах лежат позиции и невыплаченные выигрыши, поэтому источник
правды — PostgreSQL (alembic 001_initial), как и в остальном.

Форма ответов сохранена прежней, потому что фронт завязан на неё: resolve_at и
created_at наружу отдаются epoch-секундами, хотя в Postgres это TIMESTAMPTZ.
"""

from datetime import UTC, datetime

from sqlalchemy import and_, func, select, update

from database import async_session_factory
from pg_models import PredictMarket, PredictPosition, PredictTrade
from predict_amm import LMSRMarket


def _epoch(dt: datetime | None) -> float:
    return dt.timestamp() if dt else 0.0


def _market_dict(m: PredictMarket) -> dict:
    return {
        "id": m.id,
        "kind": m.kind,
        "question": m.question,
        "lighter_market_id": m.lighter_market_id,
        "threshold": m.threshold,
        "comparator": m.comparator,
        "resolve_at": _epoch(m.resolve_at),
        "b": m.b,
        "q_yes": m.q_yes,
        "q_no": m.q_no,
        "status": m.status,
        "outcome": m.outcome,
        "resolved_by": m.resolved_by,
        "evidence_url": m.evidence_url,
        "created_at": _epoch(m.created_at),
    }


def _position_dict(p: PredictPosition) -> dict:
    return {
        "id": p.id,
        "user_id": p.user_id,
        "market_id": p.market_id,
        "outcome": p.outcome,
        "shares": p.shares,
        "claimed": 1 if p.claimed else 0,
    }


# ── Рынки ────────────────────────────────────────────────────────────────────


async def create_market(
    id_: str,
    kind: str,
    question: str,
    resolve_at: float,
    b: float,
    lighter_market_id: int | None = None,
    threshold: float | None = None,
    comparator: str | None = None,
) -> None:
    if kind not in ("price", "event"):
        raise ValueError("kind должен быть 'price' или 'event'")
    if kind == "price" and (
        lighter_market_id is None or threshold is None or comparator is None
    ):
        raise ValueError(
            "price-рынок требует lighter_market_id, threshold и comparator"
        )
    async with async_session_factory() as session:
        session.add(
            PredictMarket(
                id=id_,
                kind=kind,
                question=question,
                lighter_market_id=lighter_market_id,
                threshold=threshold,
                comparator=comparator,
                resolve_at=datetime.fromtimestamp(resolve_at, UTC),
                b=b,
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()


async def get_market(market_id: str) -> dict | None:
    async with async_session_factory() as session:
        m = await session.scalar(
            select(PredictMarket).where(PredictMarket.id == market_id)
        )
        return _market_dict(m) if m else None


async def list_markets(
    status: str = "open", limit: int | None = None, offset: int = 0
) -> list[dict]:
    """'open' | 'resolved' | 'all'. Резолванные нужны интерфейсу: показать исход и
    дать забрать выигрыш, а не выбросить рынок из вида вместе с деньгами юзера.

    limit=None — весь список, так читает резолвер: ему нужен каждый просроченный
    рынок, и пропустить часть из-за страницы значило бы оставить рынок без
    резолюции. HTTP-роут передаёт страницу (см. GET /predict/markets), потому что
    витрина без потолка росла бы вместе с числом рынков, а рисует её один
    пользователь."""
    if status == "all":
        stmt = select(PredictMarket).order_by(PredictMarket.resolve_at.desc())
    elif status in ("open", "resolved"):
        stmt = (
            select(PredictMarket)
            .where(PredictMarket.status == status)
            .order_by(PredictMarket.resolve_at.asc())
        )
    else:
        raise ValueError(f"неизвестный статус фильтра: {status}")
    if limit is not None:
        stmt = stmt.limit(int(limit)).offset(int(offset))
    async with async_session_factory() as session:
        return [_market_dict(m) for m in (await session.scalars(stmt)).all()]


async def market_stats() -> dict[str, dict]:
    """Объём и число сделок по каждому рынку одним запросом.
    volume_usd = сумма |cost_usd| по predict_trades: купил на $30, продал на $12 —
    объём $42. Это честно только для сделок через Wake; прямого доступа к книге
    LMSR-пула нет, и выдавать его за рыночный объём не стоит."""
    stmt = select(
        PredictTrade.market_id,
        func.sum(func.abs(PredictTrade.cost_usd)).label("volume_usd"),
        func.count().label("trade_count"),
    ).group_by(PredictTrade.market_id)
    async with async_session_factory() as session:
        rows = (await session.execute(stmt)).mappings()
        return {
            r["market_id"]: {
                "market_id": r["market_id"],
                "volume_usd": r["volume_usd"] or 0.0,
                "trade_count": r["trade_count"],
            }
            for r in rows
        }


# ── Сделки и позиции ─────────────────────────────────────────────────────────


async def record_trade(
    trade_id: str, user_id: str, market_id: str, outcome: str, shares: float
) -> float:
    """Покупка (shares>0) или продажа (shares<0). Возвращает cost_usd (положительное —
    юзер платит, отрицательное — юзеру платят). Меняет q_yes/q_no рынка, позицию и
    пишет лог — атомарно в одной транзакции.

    Строка рынка блокируется FOR UPDATE: состояние пула читается и перезаписывается
    внутри одного вызова. В SQLite это держалось на единственном письмен; в
    PostgreSQL два параллельных трейда прочитали бы одинаковые q_yes/q_no, и второй
    записал бы цену, посчитанную от уже устаревшего пула — то есть продал бы shares
    по цене, которой рынок уже не имел.

    Дедлайн закрывает приём сделок здесь, а не только в интерфейсе: исход
    price-рынка определён в resolve_at (оракул берёт цену на этот момент), а
    статус "resolved" появляется на тик позже. В этом окне рынок формально открыт,
    и любой, кто видит живую цену BTC, знает исход заранее — покупает его по цене
    пула ниже доллара и получает доллар. Резолвер крутится раз в
    WAKE_PREDICT_RESOLVER_TICK секунд, значит окно есть у каждого рынка всегда, а
    величина его — максимум субсидии пула, b·ln2."""
    async with async_session_factory() as session:
        market = await session.scalar(
            select(PredictMarket).where(PredictMarket.id == market_id).with_for_update()
        )
        if market is None:
            raise ValueError(f"рынок {market_id} не найден")
        if market.status != "open":
            raise ValueError(f"рынок {market_id} не открыт (status={market.status})")
        if market.resolve_at <= datetime.now(UTC):
            raise ValueError(
                f"дедлайн рынка {market_id} наступил "
                f"({int(market.resolve_at.timestamp())}) — исход уже определён, "
                "сделки не принимаются"
            )

        amm = LMSRMarket(b=market.b, q_yes=market.q_yes, q_no=market.q_no)
        cost = amm.trade(outcome, shares)
        market.q_yes = amm.q_yes
        market.q_no = amm.q_no

        pos = await session.scalar(
            select(PredictPosition).where(
                PredictPosition.user_id == user_id,
                PredictPosition.market_id == market_id,
                PredictPosition.outcome == outcome,
            )
        )
        if pos is None:
            if shares < 0:
                raise ValueError("нельзя продать shares без существующей позиции")
            session.add(
                PredictPosition(
                    id=trade_id + "-pos",
                    user_id=user_id,
                    market_id=market_id,
                    outcome=outcome,
                    shares=shares,
                )
            )
        else:
            new_shares = pos.shares + shares
            if new_shares < -1e-9:
                raise ValueError("нельзя продать больше shares, чем есть в позиции")
            pos.shares = max(new_shares, 0)

        session.add(
            PredictTrade(
                id=trade_id,
                user_id=user_id,
                market_id=market_id,
                outcome=outcome,
                shares=shares,
                cost_usd=cost,
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()
        return cost


async def list_user_positions(user_id: str) -> list[dict]:
    """Позиции юзера вместе с рынками и затратами. Стоимость входа считается по
    predict_trades (SUM(cost_usd) — сколько реально уплачено за исход с учётом
    продаж), а не по текущей LMSR-цене: так видно, в плюс или в минус позиция."""
    spent = (
        select(
            PredictTrade.market_id,
            PredictTrade.outcome,
            func.sum(PredictTrade.cost_usd).label("net_cost"),
        )
        .where(PredictTrade.user_id == user_id)
        .group_by(PredictTrade.market_id, PredictTrade.outcome)
        .subquery()
    )
    stmt = (
        select(
            PredictPosition.market_id,
            PredictPosition.outcome,
            PredictPosition.shares,
            PredictPosition.claimed,
            PredictMarket.question,
            PredictMarket.kind,
            PredictMarket.status,
            PredictMarket.resolve_at,
            PredictMarket.b,
            PredictMarket.q_yes,
            PredictMarket.q_no,
            PredictMarket.outcome.label("market_outcome"),
            func.coalesce(spent.c.net_cost, 0.0).label("net_cost"),
        )
        .join(PredictMarket, PredictMarket.id == PredictPosition.market_id)
        .outerjoin(
            spent,
            and_(
                spent.c.market_id == PredictPosition.market_id,
                spent.c.outcome == PredictPosition.outcome,
            ),
        )
        .where(PredictPosition.user_id == user_id, PredictPosition.shares > 0)
        .order_by(PredictMarket.resolve_at.asc())
    )
    async with async_session_factory() as session:
        rows = (await session.execute(stmt)).mappings()
        return [
            dict(r)
            | {
                "resolve_at": _epoch(r["resolve_at"]),
                "claimed": 1 if r["claimed"] else 0,
            }
            for r in rows
        ]


async def get_position(user_id: str, market_id: str, outcome: str) -> dict | None:
    async with async_session_factory() as session:
        p = await session.scalar(
            select(PredictPosition).where(
                PredictPosition.user_id == user_id,
                PredictPosition.market_id == market_id,
                PredictPosition.outcome == outcome,
            )
        )
        return _position_dict(p) if p else None


# ── Резолюция и выплаты ──────────────────────────────────────────────────────


async def resolve_market(
    market_id: str,
    outcome: str,
    resolved_by: str | None = None,
    evidence_url: str | None = None,
) -> None:
    """Исход выносится один раз. Повторный резолв менял бы выплату постфактум —
    рынок, по которому уже есть позиции, не может дважды закончиться разным
    исходом, поэтому здесь это запрещено на уровне слоя данных, а не только в
    HTTP-обвязке (резолвер и кураторский эндпоинт идут через эту же функцию).

    FOR UPDATE закрывает гонку двух резолверов: ручной триггер куратора и
    predict_resolver.py по таймеру могут сойтись к одному рынку в одном тике."""
    async with async_session_factory() as session:
        market = await session.scalar(
            select(PredictMarket).where(PredictMarket.id == market_id).with_for_update()
        )
        if market is None:
            raise ValueError(f"рынок {market_id} не найден")
        if market.status != "open":
            raise ValueError(
                f"рынок {market_id} уже резолвлен с исходом {market.outcome}"
            )
        await session.execute(
            update(PredictMarket)
            .where(PredictMarket.id == market_id)
            .values(
                status="resolved",
                outcome=outcome,
                resolved_by=resolved_by,
                evidence_url=evidence_url,
            )
        )
        await session.commit()


async def claim_winnings(user_id: str, market_id: str) -> float:
    """Резолвнутый рынок: победившие shares стоят $1 каждая, проигравшие — $0.
    Помечает позицию claimed, чтобы нельзя было забрать дважды — и позиция тоже
    блокируется, потому что два параллельных клима одного пользователя иначе
    прочитали бы claimed=false одновременно и заплатили бы себе дважды."""
    async with async_session_factory() as session:
        market = await session.scalar(
            select(PredictMarket).where(PredictMarket.id == market_id)
        )
        if market is None or market.status != "resolved":
            raise ValueError("рынок не резолвлен")
        pos = await session.scalar(
            select(PredictPosition)
            .where(
                PredictPosition.user_id == user_id,
                PredictPosition.market_id == market_id,
                PredictPosition.outcome == market.outcome,
            )
            .with_for_update()
        )
        if pos is None or pos.claimed:
            return 0.0
        payout = pos.shares * 1.0
        pos.claimed = True
        await session.commit()
        return payout
