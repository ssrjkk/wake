"""
Тонкая обвязка вокруг протестированной логики: сравнение снапшотов позиции
(leader_position_tracker.py) и план зеркалирования (mirror_engine.py) проверены
тестами на фикстурах, точно соответствующих официальной схеме
apidocs.lighter.xyz/docs/websocket-reference — включая разворот позиции (закрытие
старой стороны + открытие новой, два события) и согласованность состояния между
сообщениями. Сам websockets.connect() тестами не покрыт: ему нужна живая сеть, и
проверено ровно то, что можно проверить без неё.

Что подтверждено, не предположение:
  - Каналы и их точная форма: account_all_positions/{ACCOUNT_ID} для позиций,
    user_stats/{ACCOUNT_ID} для portfolio_value как equity — обе схемы взяты из
    официальной документации, не угаданы
  - WS_URL — форма wss://{mainnet|testnet}.zklighter.elliot.ai/stream подтверждена
    официальными доками; хост берётся из WAKE_LIGHTER_NETWORK, а не из локального
    дефолта, чтобы данные и ордера относились к одной сети
  - db.active_follows_for_leader() — протестировано в test_db.py
  - compute_mirror_plan() — примеры в test_mirror_engine.py, инварианты на
    случайном входе в test_properties.py (план обязан отвечать причиной, а не
    исключением: исключение здесь = обрыв стрима для всех подписчиков лидера)
  - LeaderPositionTracker — реальная схема сообщений зафиксирована тестами
    (test_leader_position_tracker.py)
  - DRY_RUN=True по умолчанию: ордера не уходят, пока это явно не выключено

Осознанное упрощение, не устранённая неопределённость:
  - avg_entry_price из снапшота позиции — средняя цена по всей позиции, не цена
    именно последнего изменения. Разумное приближение для приращения, но не то же
    самое, что реальная цена конкретного филла. Точнее — слушать account_all_trades
    отдельно; не сделано здесь осознанно, чтобы не множить недоделанное в одном файле.
  - constraints (min_base_amount, size_decimals) тянутся из реальной order book по
    market_id события; рынка, которого нет в полученной книге, событие логируется
    как skip и не исполняется. Книга берётся один раз на старте процесса — новые
    рынки Lighter потребуют перезапуска листенера.
  - mirror_positions (follow_id, market_id) — учёт того, что движок ОТПРАВИЛ, а
    не того, что показывает биржа: после исполненного ордера размер этого рынка
    двигается на base_amount ордера, отдельного цикла сверки с позициями
    подписчика нет. Пока заявка MARKET+IOC исполняется целиком, расхождения не
    возникает; частичное исполнение (или сделка подписчика руками в том же
    рынке) накопит дрейф, и следующий reduce пойдёт от числа листенера, а не от
    реальной позиции на Lighter.

    Учёт per-market по той же причине: у подписчика с позициями в BTC и ETH
    закрытие BTC не вычитается из общей суммы и не теряет ETH. Сумма по рынкам
    (её отдаёт follows_for_leader под именем current_mirrored_size) остаётся
    только числом для отображения. Дрейф от ручных сделок отсутствие сверки не
    лечит и здесь — сверка с позициями подписчика на Lighter остаётся следующей
    задачей, а не сделанной.

Запуск:
    pip install lighter-sdk websockets
    python3 leader_listener.py --leader-id <id из базы> --account-index <lighter account лидера>
"""

import argparse
import asyncio
import json
import uuid
import logging

import db
import audit_log as al
from starlette.concurrency import run_in_threadpool
from encrypted_key_store import EncryptedKeyStore
from mirror_engine import (
    LeaderEvent,
    FollowerConfig,
    MarketConstraints,
    MirrorOrder,
    Side,
    compute_mirror_plan,
    is_buy_order,
    marketable_limit_price,
)
from quant import is_finite, scale_to_int
import lighter_rest
from config import DRY_RUN, LIGHTER_BASE_URL, LIGHTER_NETWORK, LIGHTER_WS_URL

logger = logging.getLogger("wake.leader_listener")

# Оба адреса — из config, т.е. из одной сети. Раздельные env-дефолты давали
# листенер, который слушает тестнет-стрим, читая ограничения из mainnet-книги.
LIGHTER_HTTP_URL = LIGHTER_BASE_URL
WS_URL = LIGHTER_WS_URL


def _key_store() -> EncryptedKeyStore | None:
    """Хранилище ключей подписчиков или None.

    Конструктор бросает RuntimeError, если WAKE_MASTER_KEY не задан, а
    `_read()` — если файл не расшифровывается. Вызов идёт из цикла вебсокета,
    где любое исключение читается как обрыв соединения: одна опечатка в env
    стоила бы зеркалирования всем подписчикам лидера, вместо того чтобы
    оставить честную строчку «keystore_unavailable» в mirror_log."""
    try:
        return EncryptedKeyStore()
    except RuntimeError as e:
        logger.error("хранилище ключей недоступно: %s", e)
        return None


def build_order_args(
    order: MirrorOrder,
    limit_price: float,
    constraints: MarketConstraints,
    follower_account_index: int,
    order_uid: str,
) -> dict:
    """Как зеркальный ордер превращается в аргументы create_order — отдельно от
    сети и от ключа, потому что именно здесь раньше терялись деньги.

    Три вещи, каждая из которых была багом, а не стилем:

      Цена. Lighter ждёт целое в тиках рынка (price * 10**supported_price_decimals —
      см. place_order_example.py и src/lib/lighter.ts). `int(event.price)` давал
      DOGE 0.16 -> 0 и BTC 110432.55 -> 110432, то есть лимитку в $110 на рынок
      по $110k: IOC-бай не исполнялся никогда. Значение сюда приходит уже
      рыночным (mark-цена от _event_mark_price), а не ценой входа лидера.

      Сторона. order.side — это СТОРОНА ПОЗЫЦИИ (её берёт из снапшота лидера),
      а не направление сделки. Открыть лонг = buy, закрыть лонг = sell. Без
      XOR с reduce_only закрытие лонга уходило как buy+reduce_only, то есть
      позиция подписчика не закрывалась никогда.

      client_order_index. Уникален на каждый реальный замысел и выводим из id
      строки mirror_log: по нему ордер потом ищется в Lighter, а две разные
      сделки лидера не делят один индекс (в отличие от time-ms % 1e6, где
      коллизия на горизонте часа — норма).
    """
    return {
        "market_index": order.market_id,
        "client_order_index": int(uuid.UUID(order_uid).int % 2**31),
        "base_amount": scale_to_int(order.base_amount, constraints.size_decimals),
        "price": scale_to_int(limit_price, constraints.price_decimals),
        "is_ask": not is_buy_order(order),
        "reduce_only": order.reduce_only,
        "account_index": follower_account_index,
    }


async def _event_mark_price(market_id: int) -> float | None:
    """Текущая mark-цена рынка для IOC-лимита, либо None, если её нет.

    Цена события — это avg_entry_price лидера, а не рынок. Для закрытия
    убыточной позиции она стоит по другую сторону книги (лонг, вошедший по
    2000 при рынке 1500, закрывается sell-лимитом 2000), IOC не исполняется,
    и подписчик остаётся в позиции, из которой лидер уже вышел; на
    наращивании симметрично — buy-лимит ниже рынка. Поэтому опорная цена —
    mark, а запас MAX_SLIPPAGE_BPS задаёт, какое проскальзывание приемлемо.

    Читается ОДИН раз на событие, а не на ордер: запрос синхронный (urllib),
    и в цикле подписчиков он блокировал бы event loop на таймаут каждого
    запроса, останавливая и вебсокет, и обработку следующих событий. Поэтому
    run_in_threadpool, как и у остальных HTTP-вызовов в этом файле.

    None, а не «подставь цену события», потому что решение о фолбэке — в
    вызывающем коде: запас на проскальзывание вокруг цены входа лидера
    придвинул бы лимит к рынку в неверную пользу (продажу убыточного лонга
    опустил бы ещё ниже). Без mark ордер идёт по цене события как есть, и
    причина видна в логе."""
    try:
        mark = await run_in_threadpool(
            lighter_rest.get_mark_price, market_id, LIGHTER_NETWORK
        )
    except (RuntimeError, ValueError) as e:
        logger.warning(
            "mark-цена рынка %s не получена (%s) — IOC-лимит по цене события",
            market_id,
            e,
        )
        return None
    if not is_finite(mark) or mark <= 0:
        logger.warning(
            "mark-цена рынка %s невалидна (%r) — IOC-лимит по цене события",
            market_id,
            mark,
        )
        return None
    return mark


async def handle_leader_event(
    leader_id: str, raw_event: dict, constraints: MarketConstraints | None
):
    """raw_event — форма из leader_position_tracker.py, проверенная тестами против
    официальной схемы сообщений. constraints=None означает, что рынка нет в
    полученной книге: посчитать base_amount можно только с шагом и минимумом
    конкретного рынка, поэтому такое событие не исполняется, а логируется как
    skip — молча угаданный размер зеркального ордера стоит реальных денег."""
    event = LeaderEvent(
        market_id=raw_event["market_id"],
        side=Side.LONG if raw_event["side"] == "long" else Side.SHORT,
        is_increase=raw_event["is_increase"],
        size_delta=raw_event["size_delta"],
        price=raw_event["price"],
        leader_equity_usd=raw_event["leader_equity_usd"],
        leader_position_before=raw_event.get("leader_position_before", 0),
    )

    rows = await db.active_follows_for_leader(leader_id)
    by_follower = {r["follower_id"]: r for r in rows}
    # Размер подписчика — в рынке СОБЫТИЯ. Сумма по всем рынкам (её отдаёт
    # follows_for_leader для отображения) для reduce непригодна: закрытие BTC
    # посчитало бы долю от BTC+ETH и запросило больше, чем у подписчика есть.
    mirrored_sizes = await db.mirrored_sizes_for_leader(leader_id)

    if constraints is None:
        reason = f"market_constraints_unavailable:{event.market_id}"
        logger.warning(
            "лидер %s: рынок %s не в книге Lighter — фолловеры не зеркалены",
            leader_id,
            event.market_id,
        )
        for r in rows:
            await db.log_mirror_result(
                str(uuid.uuid4()),
                r["follow_id"],
                event.market_id,
                event.side.value,
                0,
                False,
                "skipped",
                reason,
            )
        return

    # Маржа — число Lighter, а не заявка подписчика. Подписчик сам пишет
    # allocation_usd (до $1e9 на валидаторе), а единственный кап в планировщике —
    # `доступная маржа × max_leverage`: на заявленном числе он не ограничивает
    # ничем реальным, и ордер на $50-аккаунт планировался бы на $1e9. Ответ
    # `/account` даёт total_asset_value — верхнюю границу обеспеченной маржи
    # (свободную маржу публичный ответ не отдаёт), и этого достаточно, чтобы кап
    # считался по средствам, которые площадка подтверждает.
    #
    # Аккаунт, по которому числа нет (Lighter не ответил, аккаунта нет, средства
    # нулевые), в план не попадает и уходит в mirror_log с причиной: молча
    # просчитать его по прежней схеме значило бы спланировать ордер, который
    # биржа отклонит, и подписчик увидит в журнале «ордер не прошёл» вместо
    # «маржа не подтверждена».
    #
    # Проверка рынка стоит выше этого цикла нарочно: считывать маржу подписчиков
    # ради события, которое всё равно не исполнится, — это запрос к Lighter на
    # каждого подписчика впустую.
    followers: list[FollowerConfig] = []
    margin_unverified: list[dict] = []
    for r in rows:
        equity = None
        if r["follower_account_index"] is not None:
            try:
                equity = await run_in_threadpool(
                    lighter_rest.get_account_equity,
                    r["follower_account_index"],
                    LIGHTER_NETWORK,
                )
            except RuntimeError as e:
                logger.warning(
                    "маржа подписчика %s не получена: %s", r["follower_id"], e
                )
        if equity is None:
            margin_unverified.append(r)
            continue
        followers.append(
            FollowerConfig(
                follower_id=r["follower_id"],
                allocation_usd=r["allocation_usd"],
                available_margin_usd=equity,
                max_leverage=r["max_leverage"],
                current_mirrored_size=mirrored_sizes.get(r["follow_id"], {}).get(
                    event.market_id, 0.0
                ),
            )
        )

    plan = compute_mirror_plan(event, followers, constraints)

    for r in margin_unverified:
        logger.info("skip follower=%s reason=margin_unverified", r["follower_id"])
        await db.log_mirror_result(
            str(uuid.uuid4()),
            r["follow_id"],
            event.market_id,
            event.side.value,
            0,
            event.is_increase is False,
            "skipped",
            "margin_unverified",
        )

    for skipped in plan.skipped:
        logger.info("skip follower=%s reason=%s", skipped.follower_id, skipped.reason)
        # mirror_log.follow_id ссылается на follows(id), а SkippedFollower несёт
        # follower_id подписчика. Записать его напрямую — IntegrityError, и он
        # прилетает на самом обычном пути (skip возникает, когда аллокации не
        # хватает на минимальный ордер), т.е. вешает листенер посреди стрима.
        await db.log_mirror_result(
            str(uuid.uuid4()),
            by_follower[skipped.follower_id]["follow_id"],
            event.market_id,
            event.side.value,
            0,
            event.is_increase is False,
            "skipped",
            skipped.reason,
        )

    # Mark-цена нужна только живому исполнению и одна на всё событие: у всех
    # ордеров по нему один рынок, а в dry-run сеть трогать незачем.
    mark_price = None
    if plan.orders and not DRY_RUN:
        mark_price = await _event_mark_price(event.market_id)

    for order in plan.orders:
        follow_row = by_follower[order.follower_id]
        log_id = str(uuid.uuid4())
        if DRY_RUN:
            logger.info("dry_run would place %s", order)
            await db.log_mirror_result(
                log_id,
                follow_row["follow_id"],
                order.market_id,
                order.side.value,
                order.base_amount,
                order.reduce_only,
                "dry_run",
            )
            continue

        key_store = _key_store()
        if key_store is None:
            # Хранилище недоступно целиком (нет WAKE_MASTER_KEY, файл не
            # расшифровывается). Это отказ по всем ордерам, но не исключение:
            # для цикла вебсокета исключение равносильно обрыву стрима, и
            # подписчики лишились бы зеркалирования из-за конфигурации процесса.
            logger.error("исполнение невозможно: хранилище ключей недоступно")
            await db.log_mirror_result(
                log_id,
                follow_row["follow_id"],
                order.market_id,
                order.side.value,
                order.base_amount,
                order.reduce_only,
                "failed",
                "keystore_unavailable",
            )
            continue

        key = key_store.get_key(order.follower_id)
        if not key:
            logger.error(
                "no key on file for follower=%s — skipping execution",
                order.follower_id,
            )
            await db.log_mirror_result(
                log_id,
                follow_row["follow_id"],
                order.market_id,
                order.side.value,
                order.base_amount,
                order.reduce_only,
                "failed",
                "no_key",
            )
            await al.log_action(
                al.AuditEntry(
                    actor=f"follower:{order.follower_id}",
                    action="key_access_denied",
                    resource=f"follower:{order.follower_id}",
                    details={"reason": "no_key", "market_id": order.market_id},
                    success=False,
                )
            )
            continue

        limit_price = (
            marketable_limit_price(mark_price, is_buy_order(order))
            if mark_price is not None
            else event.price
        )
        args = build_order_args(
            order,
            limit_price,
            constraints,
            follow_row["follower_account_index"],
            log_id,
        )

        # Тот же паттерн, что в place_order_example.py / signing_service.py —
        # намеренно не дублирую здесь другую реализацию.
        import lighter  # локальный импорт: только когда реально доходим до исполнения

        try:
            client = lighter.SignerClient(
                url=LIGHTER_HTTP_URL,
                api_private_keys={key["api_key_index"]: key["private_key"]},
                account_index=args.pop("account_index"),
            )
            try:
                tx, tx_hash, err = await client.create_order(
                    **args,
                    order_type=client.ORDER_TYPE_MARKET,
                    time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                    order_expiry=client.DEFAULT_IOC_EXPIRY,
                )
            finally:
                await client.close()
        except Exception as e:
            # Сбой одного ордера не имеет права ронять цикл: вместе с процессом
            # умерло бы и зеркаление всех остальных подписчиков, молча.
            logger.exception("исполнение не дошло до Lighter: %s", e)
            await db.log_mirror_result(
                log_id,
                follow_row["follow_id"],
                order.market_id,
                order.side.value,
                order.base_amount,
                order.reduce_only,
                "failed",
                f"execute_error: {e}",
            )
            continue

        if err:
            # Размер позиции подписчика НЕ двигается: ордера нет, а вера в него
            # дороже самого пропуска. Один раз записав закрытие, которого не было,
            # листенер навсегда разъедется с реальностью на аккаунте подписчика.
            logger.error(
                "Lighter отклонил ордер follower=%s: %s", order.follower_id, err
            )
            await db.log_mirror_result(
                log_id,
                follow_row["follow_id"],
                order.market_id,
                order.side.value,
                order.base_amount,
                order.reduce_only,
                "failed",
                str(err),
                tx_hash,
            )
            continue

        await db.log_mirror_result(
            log_id,
            follow_row["follow_id"],
            order.market_id,
            order.side.value,
            order.base_amount,
            order.reduce_only,
            "sent",
            None,
            tx_hash,
        )
        delta = order.base_amount if not order.reduce_only else -order.base_amount
        await db.add_mirrored_size(follow_row["follow_id"], order.market_id, delta)


def build_constraints(books: list) -> dict:
    """market_id -> MarketConstraints из реальной книги Lighter.

    Ключ — market_id, а не «BTC-шаблон на весь тикер»: у рынков разные
    supported_size_decimals, supported_price_decimals и min_base_amount, один
    шаблон дал бы неверный base_amount и неверную цену на всём, кроме BTC.
    Значения размеров в ответе API — строки (min_base_amount="0.00007"),
    поэтому явные float(); decimals приходят числами.

    Рынок без любого из трёх полей исключается, а не получает дефолт: дефолт
    price_decimals=0 — это молча отправленный ордер с ценой в десять-сто тысяч
    раз меньше рынка."""
    out = {}
    for b in books:
        if b.get("status") != "active":
            continue
        try:
            out[int(b["market_id"])] = MarketConstraints(
                min_base_amount=float(b["min_base_amount"]),
                size_decimals=int(b["supported_size_decimals"]),
                price_decimals=int(b["supported_price_decimals"]),
            )
        except (KeyError, TypeError, ValueError):
            continue  # рынок без полей ограничения не должен ронять весь список
    return out


async def handle_stream_message(
    msg: dict, tracker, leader_id: str, constraints_by_market: dict
) -> None:
    """Одно сообщение вебсокета — отдельно от соединения, чтобы ветки разбора
    (и их отказы) проверялись тестами без живого Lighter.

    user_stats больше не применяется «как есть»: portfolio_value приходит
    строкой из внешнего источника, и float() на неожиданной форме бросал
    TypeError прямо в цикле `async for`, то есть обрывал стрим для всех
    подписчиков из-за одного поля в одном сообщении. Отказ разбора — строка в
    логе, соединение живёт.

    Состояние сохраняется ДО исполнения событий. Порядок выбран сознательно:
    упавший посреди обработки процесс повторит событие от старой базы
    (at-most-once — лучше пропущенная сделка, чем удвоенная позиция), а не
    применит его дважды от новой."""
    msg_type = msg.get("type", "")

    if msg_type == "update/user_stats":
        try:
            tracker.apply_user_stats(msg)
        except (KeyError, TypeError, ValueError) as e:
            logger.warning("user_stats не разобран: %s — пропускаю", e)
        return

    if msg_type not in (
        "update/account_all_positions",
        "subscribed/account_all_positions",
    ):
        # Прочие типы (heartbeat и т.п.) — игнорируем осознанно, не молча.
        return

    try:
        events = tracker.apply_position_update(msg)
    except (KeyError, TypeError, ValueError) as e:
        # Сообщения Lighter бывают и по другой схеме, чем позиции (например,
        # пустой market id). Умирать из-за одного такого — значит оставить всех
        # подписчиков без зеркаления.
        logger.warning("снапшот позиций не разобран: %s — пропускаю", e)
        return

    try:
        await db.save_tracker_state(
            leader_id, tracker.equity, tracker.snapshot()["positions"]
        )
    except Exception as e:
        # Не блокируем зеркалирование из-за учёта: без базы после рестарта
        # будет пропуск, но сейчас сделка важнее.
        logger.error("состояние трекера не сохранено: %s", e)

    for raw_event in events:
        try:
            await handle_leader_event(
                leader_id,
                raw_event,
                constraints_by_market.get(raw_event["market_id"]),
            )
        except Exception:
            logger.exception("событие лидера %s не обработано до конца", raw_event)


async def _stream(
    leader_id: str, leader_account_index: int, tracker, constraints_by_market: dict
):
    """Одно подключение к стриму Lighter. Возвращается при обрыве, падает только
    если не смог подключиться — перезаподключением рулит run_forever."""
    import websockets  # pip install websockets

    async with websockets.connect(WS_URL) as ws:
        await ws.send(
            json.dumps(
                {
                    "type": "subscribe",
                    "channel": f"account_all_positions/{leader_account_index}",
                }
            )
        )
        await ws.send(
            json.dumps(
                {"type": "subscribe", "channel": f"user_stats/{leader_account_index}"}
            )
        )

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except (ValueError, TypeError):
                logger.warning("не-JSON в стриме — пропускаю: %.120r", raw)
                continue
            await handle_stream_message(msg, tracker, leader_id, constraints_by_market)


async def run_forever(
    leader_id: str, leader_account_index: int, retry_delay: float = 5.0
):
    """Стрим должен переживать обрывы. Одиночное `async with connect()` умирало
    на первом же ProtocolError или на разрыве от Lighter — процесс запускали,
    он молча стоял полдня и зеркалить переставал, а подписчики считали, что
    копи-трейд работает."""
    import websockets  # noqa: F401  (pip install websockets) — connect() внутри _stream
    from leader_position_tracker import LeaderPositionTracker
    from lighter_rest import get_order_books

    try:
        constraints_by_market = build_constraints(get_order_books())
        logger.info(
            "ограничения получены по %d активным рынкам", len(constraints_by_market)
        )
    except Exception as e:
        # Без книги считать размер нельзя ни на одном рынке. Не падаем: листенер
        # продолжает видеть события и честно пишет skip, вместо того чтобы
        # уходить с молчаливой дырой в зеркалении.
        constraints_by_market = {}
        logger.error("order books не получены (%s) — ордера исполняться не будут", e)

    tracker = LeaderPositionTracker()
    # База для диффа после рестарта. Без неё первый снапшот выглядит как
    # «лидер только что открыл весь портфель»: деплой зеркалил бы его позиции
    # заново поверх уже открытых у подписчиков, а закрытия, сделанные за время
    # простоя, не эмитились бы никогда.
    try:
        state = await db.load_tracker_state(leader_id)
    except Exception as e:
        state = None
        logger.error(
            "сохранённое состояние лидера не прочитано (%s) — базой станет "
            "первый снапшот",
            e,
        )
    if state is not None:
        try:
            tracker.restore(state)
            logger.info(
                "состояние восстановлено: позиций %d, equity %s",
                len(tracker.positions),
                tracker.equity,
            )
        except (KeyError, TypeError, ValueError) as e:
            logger.error(
                "сохранённое состояние не разобрано (%s) — базой станет первый снапшот",
                e,
            )

    logger.info(
        "DRY_RUN=%s — %s",
        DRY_RUN,
        "реальные ордера НЕ уходят" if DRY_RUN else "РЕАЛЬНОЕ ИСПОЛНЕНИЕ ВКЛЮЧЕНО",
    )
    logger.info("Слушаю лидера account_index=%s на %s", leader_account_index, WS_URL)

    delay = retry_delay
    while True:
        try:
            await _stream(
                leader_id, leader_account_index, tracker, constraints_by_market
            )
            delay = retry_delay  # стрим жил нормально — сбрасываем паузу
        except Exception as e:
            logger.warning(
                "стрим оборвался (%s) — переподключение через %.0f с", e, delay
            )
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60.0)


async def main(leader_id: str, leader_account_index: int):
    await run_forever(leader_id, leader_account_index)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--leader-id", required=True)
    parser.add_argument("--account-index", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(main(args.leader_id, args.account_index))
