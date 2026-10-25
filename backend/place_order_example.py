"""
Реальный пример подписи и отправки ордера на Lighter — через их SDK, а не через
браузерный кошелёк.

[!] Единственное, что делает этот скрипт, — выставляет настоящий ордер. Поэтому его
дефолтная сеть — testnet, хотя весь остальной бэкенд по умолчанию на mainnet
(config.py): данные надо брать с основной сети, а тут само действие. Mainnet
включают двумя переменными сразу — WAKE_LIGHTER_NETWORK=mainnet и
WAKE_MAINNET_LIVE=true, — когда путь ордера проверен на тестнете и размер готов
потерять живые деньги. Одна network не подтверждение, а настройка данных.

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
import uuid

import lighter

import lighter_rest
from config import LIGHTER_HOSTS

# Одна сеть на весь скрипт: книга, цена и отправка должны смотреть в неё же,
# иначе размер считается по decimal'ам одной сети, а ордер уходит в другую.
# Значение по умолчанию — testnet, вопреки дефолту config.py: тут само действие, а
# не данные. Неизвестная сеть сюда не доходит — config.py проверяет
# WAKE_LIGHTER_NETWORK на импорте lighter_rest, то есть строкой раньше, и ровно
# тем же списком.
NETWORK = os.environ.get("WAKE_LIGHTER_NETWORK", "testnet")
BASE_URL = f"https://{LIGHTER_HOSTS[NETWORK]}"

# Второй выключатель для живой сети — тот же, что у продукта (config.py).
# Единственное, что делает этот скрипт, — выставляет настоящий ордер, и раньше
# достаточно было WAKE_LIGHTER_NETWORK=mainnet: это значение стоит в .env.prod и
# является дефолтом всего бэкенда, а dry_run скрипт не читал вовсе. Ордер уходил
# живыми деньгами с одного неверного слова в окружении.
if NETWORK == "mainnet" and os.environ.get("WAKE_MAINNET_LIVE", "").lower() not in (
    "1",
    "true",
    "yes",
):
    raise SystemExit(
        "WAKE_LIGHTER_NETWORK=mainnet требует WAKE_MAINNET_LIVE=true: этот скрипт "
        "не симулирует, он отправляет ордер настоящими деньгами. Путь ордера "
        "проверяют на WAKE_LIGHTER_NETWORK=testnet, потом подтверждают отдельно."
    )


def _env_number(name: str, default: str) -> float:
    """Число из окружения с отказом вместо трейсбека.

    Голый float(os.environ.get(...)) на опечатке бросал ValueError из модуля, и
    оператор получал стек вызовов вместо строки «WAKE_ORDER_SIZE_USD=abc — нужно
    число». NaN и inf парсятся без ошибки: NaN проходил дальше в math.floor и
    падал уже там, а inf превращал размер заявки в бесконечность."""
    raw = os.environ.get(name, default)
    try:
        value = float(raw)
    except ValueError as e:
        raise SystemExit(f"{name}={raw!r}: нужно число") from e
    if not math.isfinite(value):
        raise SystemExit(f"{name}={raw!r}: нужно конечное число")
    return value


def _env_index(name: str, default: str) -> int:
    """Индекс аккаунта или API-ключа: целое, неотрицательное, то же объяснение."""
    value = _env_number(name, default)
    if not value.is_integer() or value < 0:
        raise SystemExit(f"{name}={value}: нужно целое число не меньше нуля")
    return int(value)


SYMBOL = os.environ.get("WAKE_ORDER_SYMBOL", "ETH").strip()
SIZE_USD = _env_number("WAKE_ORDER_SIZE_USD", "100")
if SIZE_USD <= 0:
    raise SystemExit(f"WAKE_ORDER_SIZE_USD={SIZE_USD}: размер должен быть больше нуля")

# Сторона проверяется списком, а не сравнением SIDE == "sell". Прежний код
# превращал ЛЮБУЮ строку, не равную "sell", в buy: "SELL", "sell " и "sll"
# означали не отказ, а противоположную позицию — шорт становился лонгом на том
# же размере.
SIDE = os.environ.get("WAKE_ORDER_SIDE", "buy").strip().lower()
if SIDE not in ("buy", "sell"):
    raise SystemExit(f"WAKE_ORDER_SIDE={SIDE!r}: ожидается buy или sell")

ACCOUNT_INDEX = _env_index("LIGHTER_ACCOUNT_INDEX", "0")
API_KEY_INDEX = _env_index("LIGHTER_API_KEY_INDEX", "0")
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
            # Уникальный index замысла: по нему ордер ищут в Lighter и отменяют, а
            # signing_service по нему же проверяет идемпотентность — второй запрос
            # с тем же index возвращает первый tx_hash, не отправляя ордер.
            client_order_index=int(uuid.uuid4().int % 2**31),
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
