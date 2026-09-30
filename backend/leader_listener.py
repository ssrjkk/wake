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
  - WS_URL — wss://testnet.zklighter.elliot.ai/stream, подтверждено официальными доками
  - db.active_follows_for_leader() — протестировано в test_db.py
  - compute_mirror_plan() — 10/10 тестов зелёные
  - LeaderPositionTracker — 9/9 тестов зелёные, реальная схема сообщений
  - DRY_RUN=True и тестнет — по умолчанию, это фаза проверок, не реальных денег

Осознанное упрощение, не устранённая неопределённость:
  - avg_entry_price из снапшота позиции — средняя цена по всей позиции, не цена
    именно последнего изменения. Разумное приближение для приращения, но не то же
    самое, что реальная цена конкретного филла. Точнее — слушать account_all_trades
    отдельно; не сделано здесь осознанно, чтобы не множить недоделанное в одном файле.
  - constraints (min_base_amount, size_decimals) — захардкожены под BTC/ETH-подобный
    рынок ниже, реально нужно тянуть из getOrderBooks() по market_id динамически.

Запуск (тестнет):
    pip install lighter-sdk websockets
    python3 leader_listener.py --leader-id <id из базы> --account-index <lighter account лидера на тестнете>
"""

import argparse
import asyncio
import os
import uuid

import db
import audit_log as al
from encrypted_key_store import EncryptedKeyStore
from mirror_engine import LeaderEvent, FollowerConfig, MarketConstraints, Side, compute_mirror_plan

DB_PATH = "wake.db"
DRY_RUN = os.environ.get("WAKE_DRY_RUN", "true").lower() != "false"
LIGHTER_HTTP_URL = os.environ.get("LIGHTER_BASE_URL", "https://testnet.zklighter.elliot.ai")  # testnet по умолчанию

# Подтверждено (apidocs.lighter.xyz websocket-reference): wss://{mainnet|testnet}.zklighter.elliot.ai/stream
WS_URL = os.environ.get("LIGHTER_WS_URL", "wss://testnet.zklighter.elliot.ai/stream")


async def handle_leader_event(leader_id: str, raw_event: dict, constraints: MarketConstraints):
    """raw_event — предполагаемая форма, см. предупреждение в докстринге файла."""
    event = LeaderEvent(
        market_id=raw_event["market_id"],
        side=Side.LONG if raw_event["side"] == "long" else Side.SHORT,
        is_increase=raw_event["is_increase"],
        size_delta=raw_event["size_delta"],
        price=raw_event["price"],
        leader_equity_usd=raw_event["leader_equity_usd"],
        leader_position_before=raw_event.get("leader_position_before", 0),
    )

    with db.connect(DB_PATH) as conn:
        rows = db.active_follows_for_leader(conn, leader_id)
        followers = [
            FollowerConfig(
                follower_id=r["follower_id"],
                allocation_usd=r["allocation_usd"],
                available_margin_usd=r["allocation_usd"],  # см. app.py — то же упрощение, требует реальной margin-проверки
                max_leverage=r["max_leverage"],
                current_mirrored_size=r["current_mirrored_size"],
            )
            for r in rows
        ]

        plan = compute_mirror_plan(event, followers, constraints)

        for skipped in plan.skipped:
            print(f"[skip] follower={skipped.follower_id} reason={skipped.reason}")
            db.log_mirror_result(conn, str(uuid.uuid4()), skipped.follower_id, event.market_id,
                                  event.side.value, 0, event.is_increase is False, "skipped", skipped.reason)

        for order in plan.orders:
            follow_row = next(r for r in rows if r["follower_id"] == order.follower_id)
            if DRY_RUN:
                print(f"[dry_run] would place {order}")
                db.log_mirror_result(conn, str(uuid.uuid4()), follow_row["follow_id"], order.market_id,
                                      order.side.value, order.base_amount, order.reduce_only, "dry_run")
                continue

            key_store = EncryptedKeyStore()  # шифрование на диске — см. encrypted_key_store.py, всё ещё НЕ HSM-эквивалент
            key = key_store.get_key(order.follower_id)
            if not key:
                print(f"[fail] no key on file for follower={order.follower_id} — skipping execution")
                db.log_mirror_result(conn, str(uuid.uuid4()), follow_row["follow_id"], order.market_id,
                                      order.side.value, order.base_amount, order.reduce_only, "failed", "no_key")
                with al.connect("audit.db") as audit_conn:
                    al.log_action(audit_conn, al.AuditEntry(
                        actor=f"follower:{order.follower_id}",
                        action="key_access_denied",
                        resource=f"follower:{order.follower_id}",
                        details={"reason": "no_key", "market_id": order.market_id},
                        success=False,
                    ))
                continue

            # Тот же паттерн, что в place_order_example.py / signing_service.py —
            # намеренно не дублирую здесь другую реализацию.
            import lighter  # локальный импорт: только когда реально доходим до исполнения
            client = lighter.SignerClient(
                url=LIGHTER_HTTP_URL,
                api_private_keys={key["api_key_index"]: key["private_key"]},
                account_index=follow_row["follower_account_index"],
            )
            tx, tx_hash, err = await client.create_order(
                market_index=order.market_id,
                client_order_index=int(uuid.uuid4().int % 1_000_000),
                base_amount=int(order.base_amount * 10 ** constraints.size_decimals),
                price=int(event.price),
                is_ask=(order.side == Side.SHORT),
                order_type=client.ORDER_TYPE_MARKET,
                time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                reduce_only=order.reduce_only,
                order_expiry=client.DEFAULT_IOC_EXPIRY,
            )
            await client.close()

            status = "sent" if not err else "failed"
            db.log_mirror_result(conn, str(uuid.uuid4()), follow_row["follow_id"], order.market_id,
                                  order.side.value, order.base_amount, order.reduce_only, status, str(err) if err else None, tx_hash)
            db.update_mirrored_size(
                conn, follow_row["follow_id"],
                follow_row["current_mirrored_size"] + (order.base_amount if not order.reduce_only else -order.base_amount),
            )


async def main(leader_id: str, leader_account_index: int):
    import json
    import websockets  # pip install websockets — не установлено в этой песочнице
    from leader_position_tracker import LeaderPositionTracker

    constraints = MarketConstraints(min_base_amount=0.001, size_decimals=3)  # TODO: тянуть реально из getOrderBooks() по рынку
    tracker = LeaderPositionTracker()

    print(f"DRY_RUN={DRY_RUN} — {'реальные ордера НЕ уходят' if DRY_RUN else '[!]  РЕАЛЬНОЕ ИСПОЛНЕНИЕ ВКЛЮЧЕНО'}")
    print(f"Слушаю лидера account_index={leader_account_index} на {WS_URL}")

    async with websockets.connect(WS_URL) as ws:
        await ws.send(json.dumps({"type": "subscribe", "channel": f"account_all_positions/{leader_account_index}"}))
        await ws.send(json.dumps({"type": "subscribe", "channel": f"user_stats/{leader_account_index}"}))

        async for raw in ws:
            msg = json.loads(raw)
            msg_type = msg.get("type", "")

            if msg_type == "update/user_stats":
                tracker.apply_user_stats(msg)
                continue

            if msg_type in ("update/account_all_positions", "subscribed/account_all_positions"):
                for raw_event in tracker.apply_position_update(msg):
                    await handle_leader_event(leader_id, raw_event, constraints)
                continue

            # Прочие типы сообщений (heartbeat и т.п.) — игнорируем осознанно, не молча.


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--leader-id", required=True)
    parser.add_argument("--account-index", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(main(args.leader_id, args.account_index))
