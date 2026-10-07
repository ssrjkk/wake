"""
Реальный пример подписи и отправки ордера на Lighter — через их SDK, а не через
браузерный кошелёк.

[!] Единственное, что делает этот скрипт, — выставляет настоящий ордер. Поэтому его
дефолтная сеть — testnet, хотя весь остальной бэкенд по умолчанию на mainnet
(config.py): данные надо брать с основной сети, а тут само действие. Mainnet
включают (WAKE_LIGHTER_NETWORK=mainnet), когда путь ордера проверен на тестнете и
размер готов потерять живые деньги.

Это НЕ часть браузерного приложения (src/). В реальном продукте этот код живёт на
сервере и становится ядром копи-движка: вместо ручного вызова main() — триггер по
WebSocket-событию «лидер открыл позицию», и create_order вызывается для каждого
подписчика с его собственным API-ключом и его аллокацией/лимитами
(см. leader_listener.py и mirror_engine.py — тот же путь, уже с лимитами).

Установка:
    pip install lighter-sdk

Lighter API key (API_KEY_INDEX + приватный ключ) создаётся ОТДЕЛЬНО от
Ethereum-кошелька — через app.lighter.xyz, после подключения кошелька. Это НЕ
приватный ключ кошелька:
- им нельзя вывести средства;
- он привязан к конкретному account_index (счёт или саб-аккаунт);
- именно такой ключ подписчик выдаёт Wake для копи-трейдинга, а не мастер-кошелёк.

Источник примера: https://apidocs.lighter.xyz/docs/trading (Signing Transactions).
"""

import asyncio
import math
import os
import time

import lighter

import lighter_rest
from config import LIGHTER_HOSTS

# Одна сеть на весь скрипт: книга, цена и отправка должны смотреть в неё же,
# иначе размер считается по decimal'ам одной сети, а ордер уходит в другую.
NETWORK = os.environ.get("WAKE_LIGHTER_NETWORK", "testnet")
if NETWORK not in LIGHTER_HOSTS:
    raise SystemExit(
        f"WAKE_LIGHTER_NETWORK={NETWORK!r}: доступно {', '.join(sorted(LIGHTER_HOSTS))}"
    )
BASE_URL = f"https://{LIGHTER_HOSTS[NETWORK]}"

SYMBOL = os.environ.get("WAKE_ORDER_SYMBOL", "ETH")
SIZE_USD = float(os.environ.get("WAKE_ORDER_SIZE_USD", "100"))
SIDE = os.environ.get("WAKE_ORDER_SIDE", "buy")  # buy | sell

ACCOUNT_INDEX = int(os.environ.get("LIGHTER_ACCOUNT_INDEX", "0"))
API_KEY_INDEX = int(os.environ.get("LIGHTER_API_KEY_INDEX", "0"))
API_KEY_PRIVATE_KEY = os.environ.get("LIGHTER_API_KEY_PRIVATE_KEY", "")


def find_perp_market(symbol: str, network: str) -> dict:
    """Перп-рынок по тикеру — из живой книги Lighter. market_index, decimal'ы и
    min_base_amount берутся оттуда, а не из памяти: у одного тикера на разных сетях
    разные id и ограничения, а ордер с неверным числом знаков сеть просто отклонит."""
    for book in lighter_rest.get_order_books(network):
        if (
            book.get("symbol") == symbol
            and book.get("market_type") == "perp"
            and book.get("status") == "active"
        ):
            return book
    raise SystemExit(f"активного перп-рынка {symbol} в книге {network} нет")


async def main():
    if not API_KEY_PRIVATE_KEY:
        raise SystemExit(
            "LIGHTER_API_KEY_PRIVATE_KEY не задан. Создай API key на app.lighter.xyz "
            f"({NETWORK}-режим) и положи в backend/.env — см. backend/.env.example."
        )

    market = find_perp_market(SYMBOL, NETWORK)
    market_index = int(market["market_id"])
    size_decimals = int(market["supported_size_decimals"])
    price_decimals = int(market["supported_price_decimals"])
    min_base_amount = float(market["min_base_amount"])

    price = lighter_rest.get_mark_price(market_index, NETWORK)
    # Вниз, всегда вниз: округление вверх дало бы ордер больше запрошенного размера,
    # а лимиты считаются от того, что уже стоит в заявке.
    base_amount = math.floor(SIZE_USD / price * 10**size_decimals) / 10**size_decimals
    if base_amount < min_base_amount:
        raise SystemExit(
            f"размер {base_amount} меньше минимума рынка ({min_base_amount}) — "
            f"нужно больше {SIZE_USD} USD при цене {price}"
        )

    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: API_KEY_PRIVATE_KEY},
        account_index=ACCOUNT_INDEX,
    )

    try:
        tx, tx_hash, err = await client.create_order(
            market_index=market_index,
            # Свой уникальный index — по нему ордер отменяют, если он ещё жив.
            client_order_index=int(time.time()),
            base_amount=int(base_amount * 10**size_decimals),
            # Для IOC-маркета это предельно приемлемая цена. Здесь она равна
            # последней mark-цене, без запаса на проскальзывание: на резком рынке
            # такой ордер отклонят, а не исполнят по плохой цене. Запас добавляют
            # осознанно, потому что он и есть максимальное проскальзывание.
            price=int(round(price * 10**price_decimals)),
            is_ask=SIDE == "sell",  # False = buy/long, True = sell/short
            order_type=client.ORDER_TYPE_MARKET,
            time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=False,
            order_expiry=client.DEFAULT_IOC_EXPIRY,
        )
        print(
            "сеть:",
            NETWORK,
            "| рынок:",
            market["symbol"],
            "| размер:",
            base_amount,
            "| цена:",
            price,
        )
        print("tx:", tx)
        print("tx_hash:", tx_hash)
        # code=200 значит «принято сиквенсером», а не «гарантированно исполнено»:
        # исполнение подтверждают websocket-каналом ордеров (leader_position_tracker.py).
        print("err:", err)
    finally:
        await client.close()


if __name__ == "__main__":
    asyncio.run(main())
