"""Правила кодирования ордеров Arcus: тики движка, границы, подписываемый payload.

Сети и ключей здесь нет — модуль отвечает только за то, какие именно байты
уходят в подпись и в тело запроса. Ошибка в этом слое — не отказ сервиса, а
ордер с другой ценой или другим размером, поэтому правила взяты из живого
гайда площадки (https://docs.arcus.xyz/guides/rest-trading.md, снимок
2026-11-05) и каждое закрыто тестом.

Две ловушки стоят того, чтобы быть названными здесь, а не в комментарии к
тесту:

* ``goodTilTime`` в теле — микросекунды, а поле ``g`` в подписанном payload —
  наносекунды. Один и тот же момент в двух единицах: перепутать — значит
  подписать не то, что отправляешь, и получить отказ, а хуже того — принять
  чужой срок действия за свой.
* ``price`` и ``quantity`` в теле — десятичные СТРОКИ, а ``p`` и ``q`` в
  payload — целые числа тиков, выведенные из них же. Тело и подпись обязаны
  сойтись на одном значении, иначе подпись формальна: движок сверяет одно с
  другим и отвергает пару, где размер не кратен шагу.
"""

from __future__ import annotations

import math
from decimal import ROUND_HALF_EVEN, Decimal

# Wire-значения площадки, а не наши имена: менять их — значит менять протокол.
OP_PLACE = 1
OP_CANCEL = 2
PAYLOAD_VERSION = 1
SIDE = {"BUY": 0, "SELL": 1}
TIF = {"GTT": 0, "FOK": 1, "IOC": 2, "ALO": 3}
ORDER_TYPES = ("LIMIT", "MARKET")

# Движок отвержает ордер меньше $5, кроме reduce-only (гайд: «Minimum notional
# is $5, with reduce-only orders exempt»). Проверка наша нужна не для того,
# чтобы заменить серверную, а чтобы человек получил «не хватает до минимального
# ордера», а не структурированный отказ площадки.
MIN_ORDER_NOTIONAL_USD = Decimal("5")

# Для MARKET price — защитная граница проскальзывания, и она обязана лежать не
# дальше 10 % от mark-цены; из-за этого MARKET у Arcus ведёт себя как
# marketable limit, и гайд прямо предлагает вместо него агрессивный LIMIT.
MARKET_MAX_DEVIATION = Decimal("0.10")

# «Must be at least one month ahead of the current system timestamp».
MIN_GOOD_TIL_DAYS = 31

_US_PER_SECOND = 1_000_000
_NS_PER_MICROSECOND = 1_000


def _decimal(value, name: str) -> Decimal:
    """Число, пригодное для денег: конечное и точное.

    float сюда попадает только через str(): Decimal(0.1) — это
    0.1000000000000000055511151231257827021181593401408312225341796875, и на
    шаге 1e-8 такое число перестает быть кратным само себе.
    """
    if isinstance(value, bool):
        raise ValueError(f"{name} не может быть булевым")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, str):
        try:
            result = Decimal(value)
        except (ArithmeticError, ValueError):
            raise ValueError(f"{name} не число: {value!r}") from None
    elif isinstance(value, int):
        result = Decimal(value)
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"{name} не конечное число: {value!r}")
        result = Decimal(str(value))
    else:
        raise ValueError(f"{name} должен быть числом, пришло {type(value).__name__}")
    if not result.is_finite():
        raise ValueError(f"{name} не конечное число: {result}")
    return result


def to_ticks(value, unit, name: str = "значение") -> int:
    """Сколько целых ``unit`` содержится в ``value``.

    Цена обязана быть кратна tickSize, размер — stepSize. Молча округлять
    нельзя: урезанный вниз размер — это уже другой ордер, а не тот же самый,
    поэтому не-кратность здесь ошибка, а не потеря в младшем разряде.

    Нулю и отрицательному числу в ордере делать нечего: площадка требует
    «positive decimal string», а пропущенный ноль дал бы подписанный ордер
    размером 0 — не отказ, а отправленную пустоту.
    """
    amount = _decimal(value, name)
    step = _decimal(unit, "шаг")
    if step <= 0:
        raise ValueError(f"шаг должен быть положительным, пришло {step}")
    if amount <= 0:
        raise ValueError(f"{name} должно быть положительным, пришло {amount}")
    count = amount / step
    if count != count.to_integral_value():
        raise ValueError(f"{name}={amount} не кратно шагу {step}")
    return int(count)


def snap_to_tick(price, tick):
    """Ближайшая положительная цена, кратная шагу (округление, не усечение).

    Гайд делает то же самое на float с ``round(..., 10)``; здесь тот же
    результат, но на Decimal: бинарное округление на тике 1e-8 оставляет хвост,
    который движок отвергнет как не-тик, и ордер вернётся с отказом вместо
    исполнения.
    """
    amount = _decimal(price, "цена")
    step = _decimal(tick, "tickSize")
    if step <= 0:
        raise ValueError(f"tickSize должен быть положительным, пришло {step}")
    if amount <= 0:
        raise ValueError(f"цена должна быть положительной, пришло {amount}")
    ticks = (amount / step).quantize(Decimal(1), rounding=ROUND_HALF_EVEN)
    if ticks <= 0:
        raise ValueError(f"цена {amount} меньше одного тика {step}")
    # quantize по шагу, а не normalize: normalize даёт «5E-8» на тике 1e-8, и
    # эта строка ушла бы в тело запроса как цена — формат, который площадка не
    # обязана принимать, и отказ пришёл бы уже после подписи.
    return (ticks * step).quantize(step)


def good_til_time(now_s: float, days: int = MIN_GOOD_TIL_DAYS) -> int:
    """Срок жизни ордера в микросекундах — ровно столько, сколько просит тело.

    ``days`` меньше месяца — это гарантированный отказ площадки, поэтому
    отсекается здесь: дешевле упасть в своей строке, чем отправить ордер, который
    движок завернёт по той же причине через секунду.
    """
    moment = _decimal(now_s, "now_s")
    if days < MIN_GOOD_TIL_DAYS:
        raise ValueError(
            f"goodTilTime обязан быть не ближе {MIN_GOOD_TIL_DAYS} дней, пришло {days}"
        )
    return int((moment + Decimal(days) * 86_400) * _US_PER_SECOND)


def market_price_bound(mark_price, side: str) -> Decimal:
    """Защитная граница MARKET-ордера: BUY — выше mark, SELL — ниже.

    Отрицательная или нулевая mark-цена — это не «рынок дешёвый», а сломанные
    данные: граница, посчитанная от нуля, дала бы ордер по нулевой цене, и
    движок принял бы его как настоящий.
    """
    if side not in SIDE:
        raise ValueError(f"неизвестная сторона ордера: {side!r}")
    mark = _decimal(mark_price, "mark-цена")
    if mark <= 0:
        raise ValueError(f"mark-цена должна быть положительной, пришло {mark}")
    deviation = mark * MARKET_MAX_DEVIATION
    return (mark + deviation) if side == "BUY" else (mark - deviation)


def notional_ok(price, size, reduce_only: bool = False) -> bool:
    """Хватает ли ордера на минимальный размер площадки (reduce-only — нет)."""
    if reduce_only:
        return True
    return _decimal(price, "цена") * _decimal(size, "размер") >= MIN_ORDER_NOTIONAL_USD


def _address_field(address: str) -> str:
    if not isinstance(address, str) or not address.startswith("0x"):
        raise ValueError(f"адрес должен быть 0x-строкой, пришло {address!r}")
    # Подпись считается по нижнему регистру (гайд: «the signed payload uses the
    # lowercase address»), а тело запроса отправляет адрес как есть.
    return address.lower()


def place_order_payload(
    *,
    address: str,
    account_index: int,
    market_id: int,
    side: str,
    time_in_force: str,
    price,
    size,
    tick_size,
    step_size,
    good_til_us: int,
    now_ns: int,
    reduce_only: bool = False,
) -> str:
    """Каноническая строка, которую подписывает Ed25519.

    Порядок полей — часть протокола: подпись считается по этим байтам, и ещё
    один пробел или другой порядок дают валидную на вид подпись к другому
    сообщению. ``g`` — наносекунды, хотя ``goodTilTime`` в теле — микросекунды.
    """
    if side not in SIDE:
        raise ValueError(f"неизвестная сторона ордера: {side!r}")
    if time_in_force not in TIF:
        raise ValueError(f"неизвестный time-in-force: {time_in_force!r}")
    return (
        f'{{"ad":"{_address_field(address)}",'
        f'"ai":{int(account_index)},'
        f'"ct":{int(now_ns)},'
        f'"g":{int(good_til_us) * _NS_PER_MICROSECOND},'
        f'"m":{int(market_id)},'
        f'"op":{OP_PLACE},'
        f'"p":{to_ticks(price, tick_size, "цена")},'
        f'"q":{to_ticks(size, step_size, "размер")},'
        f'"r":{1 if reduce_only else 0},'
        f'"s":{SIDE[side]},'
        f'"t":{TIF[time_in_force]},'
        f'"v":{PAYLOAD_VERSION}}}'
    )


def cancel_order_payload(
    *,
    address: str,
    account_index: int,
    order_id: str,
    market_id: int,
    now_ns: int,
) -> str:
    """Payload отмены: у неё свои поля — без цены, размера и TIF (op 2)."""
    if not order_id:
        raise ValueError("order_id обязателен для отмены")
    return (
        f'{{"ad":"{_address_field(address)}",'
        f'"ai":{int(account_index)},'
        f'"ct":{int(now_ns)},'
        f'"id":"{order_id}",'
        f'"m":{int(market_id)},'
        f'"op":{OP_CANCEL},'
        f'"v":{PAYLOAD_VERSION}}}'
    )


def _plain(value) -> str:
    """Десятичная строка без экспоненты.

    Decimal печатает 0.00000005 как «5E-8», а тело запроса ждёт «positive
    decimal string» — формат, в котором площадка число узнает.
    """
    return format(_decimal(value, "число"), "f")


def place_order_body(
    *,
    address: str,
    account_index: int,
    market_id: int,
    side: str,
    order_type: str,
    price,
    size,
    time_in_force: str,
    good_til_us: int,
    now_ns: int,
) -> dict:
    """Тело запроса: те же числа, что ушли в подпись, но в форме тела.

    MARKET обязан быть IOC (площадка отвечает «must be IOC for MARKET orders»),
    и это проверяется здесь: иначе запрос ушёл бы заведомо с отказом, а
    пользователю показался бы как поломка интеграции.
    """
    if order_type not in ORDER_TYPES:
        raise ValueError(f"неизвестный тип ордера: {order_type!r}")
    if order_type == "MARKET" and time_in_force != "IOC":
        raise ValueError("MARKET-ордер обязан быть IOC")
    return {
        "address": address,
        "accountIndex": int(account_index),
        "marketId": int(market_id),
        "orderSide": side,
        "orderType": order_type,
        "quantity": _plain(size),
        "price": _plain(price),
        "timeInForce": time_in_force,
        "goodTilTime": str(int(good_til_us)),
        "timestamp": int(now_ns),
    }
