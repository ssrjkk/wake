"""
Слой доступа к PostgreSQL для копи-трейда: leaders / followers / follows /
mirror_log.

Раньше это был SQLite-файл. Он был прав, пока Wake жил на одной машине, но
бэкенд разворачивается в контейнере, и файл в контейнере живёт до ближайшего
рестарта — а в копи-трейде в этом файле лежат аллокации и подписки, то есть
чужие деньги. Postgres поднят и настроен (alembic 001_initial), поэтому
единственный источник правды теперь он, и доступ к нему отсюда идёт один раз,
через этот модуль.

Ключи подписчиков здесь не хранятся — за ними в key_store.py. Разделён он
намеренно: утечка этой базы (переписка, аллокации, история) не должна равняться
утечке торговых ключей.

Форма ответов сохранена прежней, потому что фронт завязан на неё:
  - created_at — epoch-секунды числом (Portfolio.tsx делает new Date(x * 1000)),
    хотя в Postgres колонка TIMESTAMPTZ;
  - paused и reduce_only — 0/1, хотя в Postgres это BOOLEAN.
"""

from datetime import UTC, datetime
import json

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from database import async_session_factory
from pg_models import (
    Follow,
    Follower,
    Leader,
    LeaderTrackerState,
    MirrorLog,
    MirrorPosition,
)


def _epoch(dt: datetime | None) -> float:
    return dt.timestamp() if dt else 0.0


def _follow_dict(
    f: Follow, leader_handle: str | None = None, mirrored_size: float = 0.0
) -> dict:
    row = {
        "id": f.id,
        "follower_id": f.follower_id,
        "leader_id": f.leader_id,
        "allocation_usd": f.allocation_usd,
        "max_leverage": f.max_leverage,
        # Сумма по рынкам — только для отображения. Движку нужен размер в
        # конкретном рынке (mirrored_sizes_for_leader): базовая единица BTC и
        # базовая единица ETH не складываются ни в какую величину.
        "current_mirrored_size": mirrored_size,
        "paused": 1 if f.paused else 0,
        "created_at": _epoch(f.created_at),
        "deleted_at": _epoch(f.deleted_at) if f.deleted_at else None,
    }
    if leader_handle is not None:
        row["leader_handle"] = leader_handle
    return row


def _mirrored_total():
    """SUM(mirror_positions.size) по подписке — коррелированный подзапрос.

    Не денормализованная колонка: два параллельных ордера по разным рынкам
    одной подписки не сериализуются на общей строке follows, и «поддерживать
    сумму в той же транзакции» значило бы оставить в базе число, которое
    расходится с собственными строками mirror_positions. Считать при чтении
    дороже на один подзапрос и никогда не врёт."""
    return (
        select(func.coalesce(func.sum(MirrorPosition.size), 0.0))
        .where(MirrorPosition.follow_id == Follow.id)
        .correlate(Follow)
        .scalar_subquery()
    )


# ── Запись ───────────────────────────────────────────────────────────────────


async def upsert_leader(
    id_: str, lighter_account_index: int, handle: str, fee_bps: int = 8
) -> None:
    """Создаёт лидера или обновляет handle/fee_bps у существующего.

    created_at не трогается при обновлении: время регистрации лидера — часть
    его публичной карточки в Discover."""
    stmt = insert(Leader).values(
        id=id_,
        lighter_account_index=lighter_account_index,
        handle=handle,
        fee_bps=fee_bps,
        created_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["id"],
        set_={"handle": stmt.excluded.handle, "fee_bps": stmt.excluded.fee_bps},
    )
    async with async_session_factory() as session:
        await session.execute(stmt)
        await session.commit()


async def set_leader_active(id_: str, active: bool) -> None:
    """Включить и выключить публикацию лидера.

    Выключенный лидер не отдаёт подписчиков ни листенеру, ни витрине: строка
    leaders остаётся (вместе с ней держатся follows и mirror_log), но
    зеркалирование его сделок останавливается. Без этого рубильник в интерфейсе
    был бы косметикой — подписчики продолжали бы копировать человека, который
    объявил, что больше не публикуется."""
    async with async_session_factory() as session:
        await session.execute(
            update(Leader).where(Leader.id == id_).values(active=active)
        )
        await session.commit()


async def upsert_follower(
    id_: str,
    l1_address: str,
    lighter_account_index: int | None = None,
    telegram_id: int | None = None,
) -> None:
    # COALESCE, а не прямое присваивание: логин через кошелёк не должен стирать
    # telegram_id предыдущего входа через Telegram, и наоборот.
    stmt = insert(Follower).values(
        id=id_,
        l1_address=l1_address,
        lighter_account_index=lighter_account_index,
        telegram_id=telegram_id,
        created_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["id"],
        set_={
            "lighter_account_index": func.coalesce(
                stmt.excluded.lighter_account_index, Follower.lighter_account_index
            ),
            "telegram_id": func.coalesce(
                stmt.excluded.telegram_id, Follower.telegram_id
            ),
        },
    )
    async with async_session_factory() as session:
        await session.execute(stmt)
        await session.commit()


async def create_follow(
    id_: str,
    follower_id: str,
    leader_id: str,
    allocation_usd: float,
    max_leverage: float = 3,
) -> None:
    async with async_session_factory() as session:
        session.add(
            Follow(
                id=id_,
                follower_id=follower_id,
                leader_id=leader_id,
                allocation_usd=allocation_usd,
                max_leverage=max_leverage,
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()


async def set_paused(follow_id: str, paused: bool) -> None:
    async with async_session_factory() as session:
        await session.execute(
            update(Follow).where(Follow.id == follow_id).values(paused=paused)
        )
        await session.commit()


async def add_mirrored_size(follow_id: str, market_id: int, delta: float) -> None:
    """Прибавить дельту к зеркальному размеру В ЭТОМ РЫНКЕ — атомарно.

    Прежняя форма принимала ИТОГОВОЕ число, которое вызывающий вычитал из
    строки, прочитанной до исполнения ордера: два события лидера рядом
    давали два «итога» из одного и того же прочитанного значения, и второй
    перезаписывал первый. Проигранный учёт здесь — это не округление: движок
    отвечает сам себе, сколько уже зеркалено, и расхождение с реальностью
    остаётся навсегда, потому что читать ему больше не откуда.

    market_id — часть ключа, а не украшение: reduce на 0.5 BTC при позиции
    0.5 BTC + 0.5 ETH раньше списывал дельту из общей суммы и оставлял ETH
    «неучтённым», после чего его закрытие считалось нечем уменьшать."""
    stmt = insert(MirrorPosition).values(
        follow_id=follow_id,
        market_id=market_id,
        # GREATEST в Python-виде для вставки новой строки: reduce без открытой
        # позиции — это ноль в этом рынке, а не отрицательная величина.
        size=max(0.0, delta),
        updated_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["follow_id", "market_id"],
        set_={
            "size": func.greatest(MirrorPosition.size + delta, 0.0),
            "updated_at": datetime.now(UTC),
        },
    )
    async with async_session_factory() as session:
        await session.execute(stmt)
        await session.commit()


async def mirrored_sizes_for_leader(leader_id: str) -> dict[str, dict[int, float]]:
    """{follow_id: {market_id: size}} для всех подписок лидера одним запросом.

    Движку нужен размер в КОНКРЕТНОМ рынке события: reduce считается от того,
    сколько у подписчика открыто именно там, а не от суммы по портфелю."""
    async with async_session_factory() as session:
        rows = await session.execute(
            select(
                MirrorPosition.follow_id,
                MirrorPosition.market_id,
                MirrorPosition.size,
            )
            .join(Follow, Follow.id == MirrorPosition.follow_id)
            .where(Follow.leader_id == leader_id)
        )
        sizes: dict[str, dict[int, float]] = {}
        for follow_id, market_id, size in rows.all():
            sizes.setdefault(follow_id, {})[market_id] = float(size)
        return sizes


async def load_tracker_state(leader_id: str) -> dict | None:
    """Последнее состояние позиций лидера или None, если его никогда не было
    (первый запуск). None — это «базой станет первый снапшот», а не ошибка."""
    async with async_session_factory() as session:
        row = await session.scalar(
            select(LeaderTrackerState).where(LeaderTrackerState.leader_id == leader_id)
        )
        if row is None:
            return None
        return {"equity": row.equity, "positions": json.loads(row.positions)}


async def save_tracker_state(
    leader_id: str, equity: float | None, positions: dict
) -> None:
    """Сохранить базу для диффа после рестарта — upsert по лидеру."""
    stmt = insert(LeaderTrackerState).values(
        leader_id=leader_id,
        equity=equity,
        positions=json.dumps(positions),
        updated_at=datetime.now(UTC),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["leader_id"],
        set_={
            "equity": stmt.excluded.equity,
            "positions": stmt.excluded.positions,
            "updated_at": datetime.now(UTC),
        },
    )
    async with async_session_factory() as session:
        await session.execute(stmt)
        await session.commit()


async def log_mirror_result(
    id_: str,
    follow_id: str,
    market_id: int,
    side: str,
    base_amount: float,
    reduce_only: bool,
    status: str,
    reason: str | None = None,
    tx_hash: str | None = None,
) -> None:
    async with async_session_factory() as session:
        session.add(
            MirrorLog(
                id=id_,
                follow_id=follow_id,
                market_id=market_id,
                side=side,
                base_amount=base_amount,
                reduce_only=reduce_only,
                status=status,
                reason=reason,
                tx_hash=tx_hash,
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()


# ── Чтение ───────────────────────────────────────────────────────────────────


async def active_follows_for_leader(leader_id: str) -> list[dict]:
    """Всё, что нужно compute_mirror_plan() и реальному исполнению по конкретному
    лидеру, одним запросом — включая lighter_account_index подписчика, не только
    его внутренний follower_id.

    deleted_at IS NULL здесь обязателен: отписавшийся подписчик остаётся в
    таблице ровно ради своего журнала, и без этого фильтра движок продолжал бы
    зеркалить человека, который вышел.

    Leader.active — то же по смыслу для другой стороны: выключивший публикацию
    лидер не имеет права двигать чужие счета, пока его строка в leaders не
    удалена."""
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(
                    Follow.id.label("follow_id"),
                    Follow.follower_id,
                    Follow.allocation_usd,
                    Follow.max_leverage,
                    Follower.lighter_account_index.label("follower_account_index"),
                )
                .join(Follower, Follower.id == Follow.follower_id)
                .join(Leader, Leader.id == Follow.leader_id)
                .where(
                    Follow.leader_id == leader_id,
                    Follow.paused.is_(False),
                    Follow.deleted_at.is_(None),
                    Leader.active.is_(True),
                )
            )
        ).mappings()
        return [dict(r) for r in rows]


async def follows_for_leader(leader_id: str) -> list[dict]:
    """Неактивные и отменённые папки исключены: этот ответ кормит счётчик
    подписчиков и AUM."""
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(Follow, _mirrored_total())
                .where(
                    Follow.leader_id == leader_id,
                    Follow.paused.is_(False),
                    Follow.deleted_at.is_(None),
                )
                .order_by(Follow.created_at.desc())
            )
        ).all()
        return [_follow_dict(f, mirrored_size=total) for f, total in rows]


async def leader_stats() -> dict[str, dict]:
    """Подписчики и AUM по всем лидерам одним GROUP BY.

    Тот же фильтр, что у follows_for_leader (без паузы, без отписки), иначе
    витрина и консоль лидера показывали бы разные числа. Поштучный
    follows_for_leader() на каждого лидера — это N round-trip'ов там, где база
    отвечает одним запросом, и фронт платил за это ещё и N запросами к Lighter."""
    async with async_session_factory() as session:
        rows = await session.execute(
            select(
                Follow.leader_id,
                func.count().label("follower_count"),
                func.coalesce(func.sum(Follow.allocation_usd), 0.0).label(
                    "total_aum_usd"
                ),
            )
            .where(Follow.paused.is_(False), Follow.deleted_at.is_(None))
            .group_by(Follow.leader_id)
        )
        return {
            leader_id: {
                "follower_count": int(count),
                "total_aum_usd": float(aum),
            }
            for leader_id, count, aum in rows.all()
        }


async def follows_for_follower(follower_id: str) -> list[dict]:
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(Follow, Leader.handle, _mirrored_total())
                .join(Leader, Leader.id == Follow.leader_id)
                .where(Follow.follower_id == follower_id, Follow.deleted_at.is_(None))
                .order_by(Follow.created_at.desc())
            )
        ).all()
        return [
            _follow_dict(f, handle, mirrored_size=total) for f, handle, total in rows
        ]


async def mirror_log_for_follower(follower_id: str, limit: int) -> list[dict]:
    """Журнал решений копи-движка по подпискам этого подписчика: что mirror_engine
    запланировал и чем это закончилось (dry_run / sent / skipped / failed) — с
    причиной отказа. Пишет его leader_listener.py, здесь только чтение."""
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(MirrorLog, Leader.handle)
                .join(Follow, Follow.id == MirrorLog.follow_id)
                .join(Leader, Leader.id == Follow.leader_id)
                .where(Follow.follower_id == follower_id)
                # id — тай-брейк: созданы в один тик часов строки (веер одной
                # сделки лидера пишется циклом) иначе получали бы порядок,
                # различающийся между двумя подряд запросами.
                .order_by(MirrorLog.created_at.desc(), MirrorLog.id.desc())
                .limit(limit)
            )
        ).all()
        return [
            {
                "id": m.id,
                "follow_id": m.follow_id,
                "market_id": m.market_id,
                "side": m.side,
                "base_amount": m.base_amount,
                "reduce_only": 1 if m.reduce_only else 0,
                "status": m.status,
                "reason": m.reason,
                "tx_hash": m.tx_hash,
                "created_at": _epoch(m.created_at),
                "leader_handle": handle,
            }
            for m, handle in rows
        ]


async def all_leaders() -> list[dict]:
    """Витрина Discover: только опубликованные лидеры.

    Выключивший публикацию исчезает отсюда, но остаётся в таблице — подписки и
    журнал никуда не деваются, а «мой лидер есть в базе, но не опубликован»
    читается отдельным запросом (leader_by_account_index)."""
    async with async_session_factory() as session:
        rows = (
            await session.scalars(
                select(Leader)
                .where(Leader.active.is_(True))
                .order_by(Leader.created_at.desc())
            )
        ).all()
        return [
            {
                "id": r.id,
                "lighter_account_index": r.lighter_account_index,
                "handle": r.handle,
                "fee_bps": r.fee_bps,
                "created_at": _epoch(r.created_at),
            }
            for r in rows
        ]


async def follower_by_l1(l1_address: str) -> dict | None:
    """Возвращает и привязанные к подписчику идентификаторы, а не только id:
    вход по кошельку и вход через Telegram ведут одного человека в одну строку,
    и по этому ответу видно, что именно уже привязано."""
    async with async_session_factory() as session:
        row = await session.scalar(
            select(Follower).where(Follower.l1_address == l1_address)
        )
        return (
            {
                "id": row.id,
                "lighter_account_index": row.lighter_account_index,
                "telegram_id": row.telegram_id,
            }
            if row
            else None
        )


async def follower(id_: str) -> dict | None:
    """Запись подписчика по её id — то, чем эндпоинт сверяет субъекта токена с
    тем, что реально лежит в базе (привязанный индекс аккаунта, telegram_id)."""
    async with async_session_factory() as session:
        row = await session.scalar(select(Follower).where(Follower.id == id_))
        return (
            None
            if row is None
            else {
                "id": row.id,
                "l1_address": row.l1_address,
                "lighter_account_index": row.lighter_account_index,
                "telegram_id": row.telegram_id,
            }
        )


async def leader_by_account_index(lighter_account_index: int) -> dict | None:
    """Карточка «чей это лидер» по индексу аккаунта Lighter.

    Отдаёт и active: по этому ответу интерфейс восстанавливает положение
    рубильника после перезагрузки страницы, поэтому «не опубликован» здесь —
    данные, а не отсутствие записи."""
    async with async_session_factory() as session:
        row = await session.scalar(
            select(Leader).where(Leader.lighter_account_index == lighter_account_index)
        )
        return (
            {
                "id": row.id,
                "handle": row.handle,
                "fee_bps": row.fee_bps,
                "active": row.active,
            }
            if row
            else None
        )


async def leader(id_: str) -> dict | None:
    async with async_session_factory() as session:
        row = await session.scalar(select(Leader).where(Leader.id == id_))
        if not row:
            return None
        return {
            "id": row.id,
            "lighter_account_index": row.lighter_account_index,
            "handle": row.handle,
            "active": row.active,
        }


async def owned_follow(follow_id: str, follower_id: str) -> dict | None:
    """Подписка, только если она принадлежит этому подписчику и не отменена —
    проверка владения на уровне запроса, а не в вызывающем коде."""
    async with async_session_factory() as session:
        row = (
            await session.execute(
                select(Follow, _mirrored_total()).where(
                    Follow.id == follow_id,
                    Follow.follower_id == follower_id,
                    Follow.deleted_at.is_(None),
                )
            )
        ).first()
        return _follow_dict(row[0], mirrored_size=row[1]) if row else None


async def delete_follow(follow_id: str, follower_id: str) -> bool:
    """Отписка: строка помечается deleted_at и снимается с зеркаления (paused),
    журнал mirror_log остаётся на месте.

    Удалять строку нельзя: на неё ссылается mirror_log, и жёсткий DELETE давал
    IntegrityError — 500 на обычной кнопке «отписаться». ON DELETE CASCADE
    стер бы единственную запись того, что копи-движок делал с деньгами
    подписчика.

    WHERE с проверкой владельца и WHERE deleted_at IS NULL — один запрос: между
    «проверить, что своя» и «пометить» параллельный отзыв не должен успеть
    превратить отписку в отметку на уже удалённой строке."""
    async with async_session_factory() as session:
        result = await session.execute(
            update(Follow)
            .where(
                Follow.id == follow_id,
                Follow.follower_id == follower_id,
                Follow.deleted_at.is_(None),
            )
            .values(deleted_at=datetime.now(UTC), paused=True)
        )
        await session.commit()
        return result.rowcount > 0
