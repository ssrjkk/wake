"""python3 -m unittest test_risk_limits -v"""

import unittest
from risk_limits import RiskLimits, UserRiskState, check_order, record_executed


class TestPerTransactionLimit(unittest.TestCase):
    def test_order_within_limit_allowed(self):
        limits = RiskLimits(max_order_usd=500)
        state = UserRiskState("u1")
        r = check_order(limits, state, market_id=0, requested_usd=300)
        self.assertTrue(r.allowed)
        self.assertEqual(r.capped_size_usd, 300)

    def test_order_exceeding_per_transaction_cap_rejected(self):
        limits = RiskLimits(max_order_usd=500)
        state = UserRiskState("u1")
        r = check_order(limits, state, market_id=0, requested_usd=10_000)
        self.assertFalse(r.allowed)
        self.assertIn("транзакцию", r.reason)

    def test_this_is_the_actual_mitigation_a_decimal_bug_cannot_bypass(self):
        # Симуляция: баг умножил размер в 1000 раз (0.5 -> 500 usd стало 500_000 usd)
        limits = RiskLimits(max_order_usd=500)
        state = UserRiskState("u1")
        buggy_requested_size = 500 * 1000
        r = check_order(limits, state, market_id=0, requested_usd=buggy_requested_size)
        self.assertFalse(
            r.allowed, "лимит должен поймать раздутый багом размер, а не пропустить его"
        )


class TestDailyVolumeLimit(unittest.TestCase):
    def test_blocks_once_daily_volume_exhausted(self):
        limits = RiskLimits(max_order_usd=500, max_daily_volume_usd=1000)
        state = UserRiskState("u1", volume_today_usd=1000)
        r = check_order(limits, state, market_id=0, requested_usd=100)
        self.assertFalse(r.allowed)
        self.assertIn("дневной лимит", r.reason)

    def test_caps_order_to_remaining_daily_budget_instead_of_flat_reject(self):
        limits = RiskLimits(max_order_usd=500, max_daily_volume_usd=1000)
        state = UserRiskState("u1", volume_today_usd=900)  # осталось 100
        r = check_order(limits, state, market_id=0, requested_usd=300)
        self.assertTrue(r.allowed)
        self.assertEqual(r.capped_size_usd, 100)

    def test_record_executed_accumulates_across_multiple_orders(self):
        limits = RiskLimits(max_daily_volume_usd=1000)
        state = UserRiskState("u1")
        record_executed(state, market_id=0, executed_usd=400)
        record_executed(state, market_id=0, executed_usd=400)
        r = check_order(limits, state, market_id=0, requested_usd=300)
        self.assertEqual(r.capped_size_usd, 200)  # 1000 - 800 уже потрачено


class TestPositionLimit(unittest.TestCase):
    def test_blocks_once_position_limit_reached_on_that_market(self):
        limits = RiskLimits(max_position_usd=1000)
        state = UserRiskState("u1", open_position_usd={0: 1000})
        r = check_order(limits, state, market_id=0, requested_usd=100)
        self.assertFalse(r.allowed)
        self.assertIn("позиции", r.reason)

    def test_position_limit_is_per_market_not_global(self):
        limits = RiskLimits(max_position_usd=1000)
        state = UserRiskState("u1", open_position_usd={0: 1000})  # рынок 0 полон
        r = check_order(
            limits, state, market_id=1, requested_usd=500
        )  # рынок 1 свободен
        self.assertTrue(r.allowed)


class TestReduceOnlyBypassesLimits(unittest.TestCase):
    def test_closing_a_position_is_never_blocked_by_limits(self):
        limits = RiskLimits(max_order_usd=100, max_daily_volume_usd=0)  # всё исчерпано
        state = UserRiskState("u1", volume_today_usd=99999)
        r = check_order(
            limits, state, market_id=0, requested_usd=50_000, is_reduce_only=True
        )
        self.assertTrue(
            r.allowed,
            "закрытие позиции не должно блокироваться лимитами — иначе выход из позиции невозможен",
        )


class TestRecordExecuted(unittest.TestCase):
    def test_reduce_only_decreases_position_not_increases(self):
        state = UserRiskState("u1", open_position_usd={0: 500})
        record_executed(state, market_id=0, executed_usd=200, is_reduce_only=True)
        self.assertEqual(state.open_position_usd[0], 300)

    def test_position_never_goes_negative_on_overclose(self):
        state = UserRiskState("u1", open_position_usd={0: 100})
        record_executed(state, market_id=0, executed_usd=500, is_reduce_only=True)
        self.assertEqual(state.open_position_usd[0], 0.0)


class TestNonFiniteCannotPass(unittest.TestCase):
    (
        """NaN и inf не должны проходить лимит молча.

    Проверка в коде до этой правки была `if requested_usd > limits.max_order_usd`,
    а любое сравнение с NaN — False. Результат: ордер на «не-число» получал
    allowed=True, capped_size_usd=NaN, и NaN уезжал дальше — в JSON ответа
    (Starlette сериализует с allow_nan=False и падал 500) либо в int() при
    расчёте размера ордера (ValueError).""",
    )

    def test_nan_is_blocked_not_allowed(self):
        res = check_order(RiskLimits(), UserRiskState("u1"), 0, float("nan"))
        self.assertFalse(res.allowed)
        self.assertEqual(res.capped_size_usd, 0.0)

    def test_infinity_is_blocked(self):
        res = check_order(RiskLimits(), UserRiskState("u1"), 0, float("inf"))
        self.assertFalse(
            res.allowed, "inf > max_order_usd — True, но и это отказ, а не «разрешено»"
        )

    def test_record_executed_ignores_non_finite(self):
        """Игнорирует, а не прибавляет: раз попав в volume_today_usd, NaN отравил
        бы счётчик навсегда — все последующие сравнения с лимитом давали бы False,
        и пользователь не мог бы больше ни открыть, ни закрыть."""
        state = UserRiskState("u1", volume_today_usd=100.0, open_position_usd={0: 50.0})
        record_executed(state, market_id=0, executed_usd=float("nan"))
        self.assertEqual(state.volume_today_usd, 100.0)
        self.assertEqual(state.open_position_usd[0], 50.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
