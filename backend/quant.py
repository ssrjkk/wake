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
"""

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

_ONE = Decimal(1)


def _dec(value: float) -> Decimal:
    """repr(), а не Decimal(float): Decimal(0.29) хранит 0.28999999999999998,
    и ровно этот шум round_down() затем режет вниз."""
    return Decimal(repr(float(value)))


def round_down(value: float, decimals: int) -> float:
    """Округление ВНИЗ до шага рынка (10**-decimals). Никогда не увеличивает."""
    step = _ONE.scaleb(-decimals)
    return float(_dec(value).quantize(step, rounding=ROUND_DOWN))


def scale_to_int(value: float, decimals: int) -> int:
    """Человеческое число → целое в тиках рынка (price * 10**price_decimals),
    как того требует lighter.SignerClient.create_order. Ближайший тик."""
    scaled = _dec(value) * (_ONE.scaleb(decimals))
    return int(scaled.to_integral_value(rounding=ROUND_HALF_UP))
