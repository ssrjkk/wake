"""
Тесты общего округления (quant.py). Единственное место, где проверяется, что
«вниз» — это вниз, а «в тики рынка» — это ближайший тик, а не нижний.

Числа в тестах взяты не из головы, а из живых шагов цены Lighter: price_decimals
у перпов mainnet на момент проверки 2..6 (SMIC — 4, ETH — 4), size_decimals 0..4,
и именно на таких значениях float-арифметика и ломалась.
"""

import unittest

from quant import round_down, scale_to_int


class TestRoundDown(unittest.TestCase):
    def test_float_noise_does_not_eat_a_tick(self):
        # int(0.29 * 100) == 28 на float-арифметике — ровно этот баг здесь закрыт.
        self.assertEqual(round_down(0.29, 2), 0.29)
        self.assertEqual(round_down(0.57, 2), 0.57)
        self.assertEqual(round_down(4.35, 2), 4.35)
        self.assertEqual(round_down(0.029, 2), 0.02)

    def test_never_rounds_up(self):
        self.assertEqual(round_down(0.9999996, 2), 0.99)
        self.assertEqual(round_down(1.0 / 3, 3), 0.333)
        self.assertEqual(round_down(0.001, 0), 0.0)

    def test_zero_decimals_and_whole_values(self):
        self.assertEqual(round_down(7.9, 0), 7.0)
        self.assertEqual(round_down(12.0, 4), 12.0)


class TestScaleToInt(unittest.TestCase):
    def test_price_becomes_market_ticks(self):
        self.assertEqual(scale_to_int(110_432.55, 2), 11_043_255)
        self.assertEqual(scale_to_int(0.1634, 4), 1634)
        self.assertEqual(scale_to_int(2.0, 6), 2_000_000)

    def test_uses_nearest_tick_not_floor(self):
        # Для цены нижний тик означал бы лимитку хуже рынка на целый шаг.
        self.assertEqual(scale_to_int(100.999, 2), 10_100)
        self.assertEqual(scale_to_int(100.004, 2), 10_000)

    def test_base_amount_of_a_full_tick_survives(self):
        self.assertEqual(scale_to_int(0.29, 2), 29)


if __name__ == "__main__":
    unittest.main(verbosity=2)
