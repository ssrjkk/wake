"""
[!]   Сам websockets.connect() НЕ запускался мной — библиотеки нет в этой песочнице
(проверено). Но это теперь тонкая обвязка вокруг протестированной логики, не
написанный вслепую парсинг: сравнение снапшотов позиции (leader_position_tracker.py)
прогнано 9/9 тестами на фикстурах, точно соответствующих официальной схеме
apidocs.lighter.xyz/docs/websocket-reference — включая разворот позиции (закрытие
старой стороны + открытие новой, два события) и согласованность состояния между
сообщениями.

Что теперь ТОЧНО подтверждено, не предположение:
  - Каналы и их точная форма: account_all_positions/{ACCOUNT_ID} для позиций,
    user_stats/{ACCOUNT_ID} для portfolio_value как equity — обе схемы взяты из
    официальной документации, не угаданы
  - WS_URL — форма wss://{mainnet|testnet}.zklighter.elliot.ai/stream подтверждена
    официальными доками; хост берётся из WAKE_LIGHTER_NETWORK, а не из локального
    дефолта, чтобы данные и ордера относились к одной сети
  - db.active_follows_for_leader() — протестировано в test_db.py
  - compute_mirror_plan() — 10/10 тестов зелёные
  - LeaderPositionTracker — 9/9 тестов зелёные, реальная схема сообщений
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
from encrypted_key_store import EncryptedKeyStore
from mirror_engine import (
    LeaderEvent,
    FollowerConfig,
    MarketConstraints,
    MirrorOrder,
    Side,
    compute_mirror_plan,
)
from quant import scale_to_int
from config import DRY_RUN, LIGHTER_BASE_URL, LIGHTER_WS_URL

logger = logging.getLogger("wake.leader_listener")

# Оба адреса — из config, т.е. из одной сети. Раздельные env-дефолты давали
# листенер, который слушает тестнет-стрим, читая ограничения из mainnet-книги.
LIGHTER_HTTP_URL = LIGHTER_BASE_URL
WS_URL = LIGHTER_WS_URL


def build_order_args(
    order: MirrorOrder,
    event_price: float,
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
      по $110k: IOC-бай не исполнялся никогда.

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
        "price": scale_to_int(event_price, constraints.price_decimals),
        "is_ask": (order.side == Side.SHORT) != order.reduce_only,
        "reduce_only": order.reduce_only,
        "account_index": follower_account_index,
    }


async def handle_leader_event(
    leader_id: str, raw_event: dict, constraints: MarketConstraints | None
):
    """raw_event — форма из leader_position_tracker.py, проверенная тестами против
    официальной схемы сообщений. constraints=None означает, что рынка нет в
    полученной книге: посчитать base_amount можно только с шагом и минимумом
    конкретного рынка, поэтому такой событие не исполняется, а логируется как
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
    followers = [
        FollowerConfig(
            follower_id=r["follower_id"],
            allocation_usd=r["allocation_usd"],
            available_margin_usd=r[
                "allocation_usd"
            ],  # см. app.py — то же упрощение, требует реальной margin-проверки
            max_leverage=r["max_leverage"],
            current_mirrored_size=r["current_mirrored_size"],
        )
        for r in rows
    ]

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

    plan = compute_mirror_plan(event, followers, constraints)

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

        key_store = (
            EncryptedKeyStore()
        )  # шифрование на диске — см. encrypted_key_store.py, всё ещё НЕ HSM-эквивалент
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

        args = build_order_args(
            order,
            event.price,
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
        await db.update_mirrored_size(
            follow_row["follow_id"],
            max(0.0, follow_row["current_mirrored_size"] + delta),
        )


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

            msg_type = msg.get("type", "")

            if msg_type == "update/user_stats":
                tracker.apply_user_stats(msg)
                continue

            if msg_type in (
                "update/account_all_positions",
                "subscribed/account_all_positions",
            ):
                try:
                    events = tracker.apply_position_update(msg)
                except (KeyError, TypeError, ValueError) as e:
                    # Сообщения Lighter бывают и по другой схеме, чем позиции
                    # (например, пустой market id). Умирать из-за одного такого —
                    # значит оставить всех подписчиков без зеркаления.
                    logger.warning("снапшот позиций не разобран: %s — пропускаю", e)
                    continue
                for raw_event in events:
                    try:
                        await handle_leader_event(
                            leader_id,
                            raw_event,
                            constraints_by_market.get(raw_event["market_id"]),
                        )
                    except Exception:
                        logger.exception(
                            "событие лидера %s не обработано до конца", raw_event
                        )
                continue

            # Прочие типы сообщений (heartbeat и т.п.) — игнорируем осознанно, не молча.


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
                "стрим оборвался (%s) — переподключение через %.0fс", e, delay
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
