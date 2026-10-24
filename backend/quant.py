"""
Одно округление на весь бэкенд.

Причина появиться: в проекте было два независимых `_round_down` — в funding_arb.py
`int(value * 10**d)`, в mirror_engine.py `int(round(value * 10**d, 6))`. Первый
на реальных числах режет размер на шаг вниз: 0.29 монеты при d=2 это
`int(28.999999999999996)` = 28, то есть 0.28. Второй спасён случайной шестёркой
в round() и сам может округлить вверх (0.009999996 → 0.01), чего «вниз» обещать
не должно. Третье место (agent_runner.py) умножало на 10**decimals и отбрасывало
дробь через int() уже по пути в Lighter.

Здесь арифметика через Decimal: значение берётся из repr(), то есть из самой
короткой записи, которую float вообще отдаёт человеку ("0.29"), и к ней
применяется нужное направление округления. Двойной float-шум в результат
не попадает ни при каком направлении.

Направления два и они не взаимозаменяемы:
  round_down — размер ордера. Недоисполнить безопасно, переисполнить нет.
  scale_to_int — цена в тиках рынка. Здесь нужен ближайший тик, а не
    систематически нижний: нижняя цена у BUY-лимитки означает «не исполнилось».

Третье требование — определённость: NaN и inf наружу не возвращаются никогда.
`round_down(nan)` молча отдавал NaN, а `NaN <= 0` и `NaN < min_base_amount` —
это False, так что ордер с размером NaN проходил всю проверку и умирал уже в
`scale_to_int`, на исполнении, где он выглядит как сбой Lighter, а не как
мусор на входе. Здесь граница одна: неконечное значение — ValueError.
"""

import math
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation

_ONE = Decimal(1)


def is_finite(value: object) -> bool:
    """Годится ли значение в денежный расчёт: число и конечное.

    None, строка, NaN и inf — всё «нет данных», и различать их нужно не в
    вызывающем коде: там каждый делает это по-своему и часть сравнивает
    `<= 0`, что NaN пропускает."""
    try:
        return math.isfinite(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False


def _dec(value: float) -> Decimal:
    """repr(), а не Decimal(float): Decimal(0.29) хранит 0.28999999999999998,
    и ровно этот шум round_down() затем режет вниз."""
    try:
        x = float(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"нужно число, пришло {value!r}") from e
    if not math.isfinite(x):
        raise ValueError(f"нужно конечное число, пришло {value!r}")
    return Decimal(repr(x))


def round_down(value: float, decimals: int) -> float:
    """Округление ВНИЗ до шага рынка (10**-decimals). Модуль значения при этом
    никогда не растёт: Decimal ROUND_DOWN идёт к нулю, поэтому для положительного
    размера — это «не больше посчитанного», а размеры ордера наружу всегда
    положительные."""
    step = _ONE.scaleb(-decimals)
    try:
        return float(_dec(value).quantize(step, rounding=ROUND_DOWN))
    except InvalidOperation as e:
        # Decimal не квантизует число, которое не влезает в свою точность
        # (1e30 при 28 разрядах). Для ордера это не «ноль», а невалидный вход.
        raise ValueError(
            f"значение {value!r} не округляется к шагу 10**-{decimals}"
        ) from e


def scale_to_int(value: float, decimals: int) -> int:
    """Человеческое число → целое в тиках рынка (price * 10**price_decimals),
    как того требует lighter.SignerClient.create_order. Ближайший тик."""
    scaled = _dec(value) * (_ONE.scaleb(decimals))
    return int(scaled.to_integral_value(rounding=ROUND_HALF_UP))
