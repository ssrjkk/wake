"""
РЕАЛЬНЫЙ пример подписи ордера на Lighter — через их SDK, не через wagmi/браузерный кошелёк.

[!]   Это размещает настоящий ордер, если вставить реальные ключи и запустить против mainnet.
    Для экспериментов используй testnet (см. testnet-адрес в доках apidocs.lighter.xyz —
    не угадываю его здесь, сверься сам).

Это НЕ часть браузерного приложения (src/). В реальном продукте этот код живёт на сервере
и становится ядром копи-движка: вместо ручного вызова main() — триггер по WebSocket-событию
"лидер открыл позицию", и create_order вызывается для каждого подписчика с его собственным
API-ключом и его собственной аллокацией/лимитами.

Установка:
    pip install lighter-sdk

Lighter API key (API_KEY_INDEX + приватный ключ) создаётся ОТДЕЛЬНО от Ethereum-кошелька —
через app.lighter.xyz, после подключения кошелька. Это НЕ приватный ключ кошелька:
- им нельзя вывести средства;
- он привязан к конкретному account_index (счёт или саб-аккаунт);
- именно такой ключ подписчик выдаёт Wake для копи-трейдинга — не свой мастер-кошелёк.

Источник примера: https://apidocs.lighter.xyz/docs/trading (Signing Transactions).
"""

import asyncio
import os
import lighter

# Всё берётся из переменных окружения — см. .env.example, без правки кода.
# По умолчанию тестнет: реальный ордер на тестнете, ноль реальных денег.
BASE_URL = os.environ.get("LIGHTER_BASE_URL", "https://testnet.zklighter.elliot.ai")

ACCOUNT_INDEX = int(os.environ.get("LIGHTER_ACCOUNT_INDEX", "0"))
API_KEY_INDEX = int(os.environ.get("LIGHTER_API_KEY_INDEX", "0"))
API_KEY_PRIVATE_KEY = os.environ.get("LIGHTER_API_KEY_PRIVATE_KEY", "")


async def main():
    if not API_KEY_PRIVATE_KEY:
        raise RuntimeError(
            "LIGHTER_API_KEY_PRIVATE_KEY не задан. Создай API key на app.lighter.xyz "
            "(testnet-режим) и положи в backend/.env — см. .env.example."
        )
    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: API_KEY_PRIVATE_KEY},
        account_index=ACCOUNT_INDEX,
    )

    # Перед реальным использованием: возьми supported_size_decimals /
    # supported_price_decimals нужного маркета из orderBooks (см. getOrderBooks()
    # в src/lib/lighter.ts) и переведи размер/цену в целые числа, как требует API —
    # это НЕ опционально, из этого API так работает.
    tx, tx_hash, err = await client.create_order(
        market_index=0,                # ETH-PERP; market_id из getOrderBooks()
        client_order_index=1234,       # свой уникальный id ордера — чтобы отменить позже
        base_amount=10,                # пример: 0.001 ETH при supported_size_decimals=4
        price=3100_00,                 # худшая приемлемая цена; пример при decimals=2
        is_ask=False,                  # False = long/buy, True = short/sell
        order_type=client.ORDER_TYPE_MARKET,
        time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
        reduce_only=False,
        order_expiry=client.DEFAULT_IOC_EXPIRY,
    )
    print("tx:", tx)
    print("tx_hash:", tx_hash)
    print("err:", err)  # code=200 значит "принято сиквенсером", не "гарантированно исполнено" —
                         # реальное исполнение подтверждай через websocket-канал ордеров

    await client.close()


if __name__ == "__main__":
    asyncio.run(main())
