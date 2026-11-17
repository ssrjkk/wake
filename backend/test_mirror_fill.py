"""Сверка отправленной зеркала с тем, что площадка действительно исполнила.

python3 -m unittest test_mirror_fill -v

Вход — уже разобранные строки ленты `/api/v1/trades` (форму разбирает
test_lighter_rest.py на живых снимках ответа), выход — статус и исполненный
базовый размер. Листенер от этого файла тоньше: он выбирает окно повторов и
пишет результат в журнал.

Проверяется четыре вещи, за которые в копи-трейде отвечают деньгами:

  - в учёт идёт ТОЛЬКО наша заявка: строки чужих ордеров того же аккаунта,
    чужих рынков и чужой роли (мейкер вместо тейкера) не складываются;
  - частичное исполнение не притворяется полным и не округляется до нуля;  - «филлов нет» и «филл не удалось прочитать» — разные исходы: первый не
    двигает учёт и говорит «IOC снят с цены», второй говорит «неизвестно»;
  - сумма идёт по десятичной сетке рынка: 0.1 + 0.2 обязано дать ровно 0.3,
    иначе полное исполнение выглядело бы частичным.
"""

import unittest
import uuid

import mirror_fill


def fill(
    trade_id=1001,
    client=None,
    account=900,
    market=8,
    size="0.005",
    type="trade",
):
    """Строка ленты в той форме, которую отдаёт
    `lighter_rest.get_account_taker_fills`: ровно шесть полей, размер — float,
    сторона тейкера уже выбрана. Лишних полей здесь намеренно нет — сверка
    обязана видеть тот же словарь, что ей отдадут в бою; настоящая цепочка
    «JSON площадки → парсер → fill_report» проверяется в test_lighter_rest."""
    return {
        "trade_id": trade_id,
        "market_id": market,
        "type": type,
        "taker_account_index": account,
        "taker_client_order_index": client if client is not None else CLIENT,
        "size": None if size is None else float(size),
    }


UID = "2f4a0c3e-9f0b-4f3a-9d1e-6c2b0a5e7d11"
CLIENT = mirror_fill.client_order_index(UID)


def report(fills, ordered=0.01, **kwargs):
    params = {
        "account_index": 900,
        "market_id": 8,
        "order_uid": UID,
        "ordered_base": ordered,
    }
    params.update(kwargs)
    return mirror_fill.fill_report(fills, **params)


class TestClientOrderIndex(unittest.TestCase):
    """Ключ атрибуции: один и тот же расчёт на стороне отправки (build_order_args)
    и на стороне сверки. Разъездился бы модуль — листенер не находил бы в ленте
    собственные ордеры, и каждый филл выглядел бы снятым с цены."""

    def test_same_uid_always_gives_the_same_index(self):
        self.assertEqual(
            mirror_fill.client_order_index(UID), mirror_fill.client_order_index(UID)
        )

    def test_different_uid_gives_a_different_index(self):
        indexes = {
            mirror_fill.client_order_index(str(uuid.uuid4())) for _ in range(200)
        }
        self.assertEqual(len(indexes), 200, "коллизия client_order_index")

    def test_index_fits_in_the_int32_the_venue_expects(self):
        for _ in range(200):
            index = mirror_fill.client_order_index(str(uuid.uuid4()))
            self.assertTrue(0 <= index < 2**31)


class TestFullFill(unittest.TestCase):
    def test_one_row_covering_the_order_is_filled(self):
        r = report([fill(size="0.01")], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.FILLED)
        self.assertEqual(r.executed_base, 0.01)
        self.assertIsNone(r.reason)

    def test_several_rows_of_one_order_sum_up(self):
        """IOC по объёму книги исполняется несколькими строками — это и есть
        частичное исполнение по заявке, но полное по объёму."""
        r = report(
            [
                fill(trade_id=1, size="0.004"),
                fill(trade_id=2, size="0.0035"),
                fill(trade_id=3, size="0.0025"),
            ],
            ordered=0.01,
        )
        self.assertEqual(r.status, mirror_fill.FILLED)
        self.assertAlmostEqual(r.executed_base, 0.01)

    def test_decimal_grid_not_binary_noise(self):
        """0.1 + 0.2 в float — 0.30000000000000004. На float-сумме полное
        исполнение стало бы «частичным», и учёт подписался бы числом, которого
        на площадке нет."""
        r = report(
            [fill(trade_id=1, size="0.1"), fill(trade_id=2, size="0.2")], ordered=0.3
        )
        self.assertEqual(r.status, mirror_fill.FILLED)
        self.assertEqual(r.executed_base, 0.3)

    def test_the_venue_reporting_more_than_ordered_is_capped(self):
        """Больше заказанного IOC исполнить не может, поэтому такая строка —
        сбой разбора или чужой ордер с нашим id: учёт не обязан расти выше
        плана, а журнал обязан показать, что площадка сообщила лишнее."""
        r = report([fill(size="0.02")], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.FILLED)
        self.assertEqual(r.executed_base, 0.01)
        self.assertIn("0.02", r.reason)


class TestPartialFill(unittest.TestCase):
    def test_smaller_than_ordered_is_partially_filled(self):
        r = report([fill(size="0.004")], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.PARTIALLY_FILLED)
        self.assertAlmostEqual(r.executed_base, 0.004)

    def test_reason_explains_the_cause_and_leaves_the_numbers_to_columns(self):
        """base_amount и filled_base_amount — соседние колонки той же строки, а
        reason объясняет причину. Числа в тексте означали бы вторую копию,
        расходящуюся с колонками молча."""
        r = report([fill(size="0.004")], ordered=0.01)
        self.assertIn("IOC", r.reason)
        self.assertNotIn("0.004", r.reason)
        self.assertNotIn("0.01", r.reason)


class TestAttribution(unittest.TestCase):
    """Ни одна чужая строка не имеет права попасть в наш учёт: лента пришла по
    фильтру аккаунта и рынка, но фильтр — чужой код, а деньги — наши."""

    def test_row_of_another_order_of_the_same_account_is_not_ours(self):
        other = fill(
            trade_id=1, client=mirror_fill.client_order_index(str(uuid.uuid4()))
        )
        r = report([other], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.UNFILLED)
        self.assertEqual(r.executed_base, 0.0)

    def test_row_of_another_market_is_not_ours(self):
        r = report([fill(market=9)], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.UNFILLED)

    def test_liquidation_row_is_not_our_order(self):
        """Ликвидация аккаунта — не исполнение зеркального ордера: её размер в
        учёт не идёт, иначе движок посчитал бы, что сам закрыл позицию."""
        r = report([fill(size="0.01", type="liquidation")], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.UNFILLED)

    def test_our_account_as_maker_is_not_our_taker_order(self):
        r = report([fill(account=700)], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.UNFILLED)

    def test_our_own_row_still_counts_when_others_share_the_page(self):
        noise = [
            fill(trade_id=1, client=7),
            fill(trade_id=2, account=700, size="0.5"),
            fill(trade_id=3, market=12, size="0.5"),
        ]
        r = report(noise + [fill(trade_id=4, size="0.01")], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.FILLED)
        self.assertAlmostEqual(r.executed_base, 0.01)


class TestNothingFilled(unittest.TestCase):
    def test_empty_tape_is_unfilled_not_unconfirmed(self):
        """Пустая лента при прочитанном ответе — это «филла нет». IOC, снятый с
        цены, отвечает УСПЕШНО, и до этой сверки такой исход писался в журнал
        как исполненная сделка."""
        r = report([], ordered=0.01)
        self.assertEqual(r.status, mirror_fill.UNFILLED)
        self.assertEqual(r.executed_base, 0.0)
        # Нулевой исполненный размер — то, ради чего этот исход существует:
        # учёт не сдвинется ни на единицу. Число в причине писать не нужно, оно
        # уже лежит в колонках строки (base_amount, filled_base_amount).
        self.assertEqual(r.reason, "IOC снят с цены: ни одной сделки по этой заявке")

    def test_unfilled_reason_says_the_order_was_cancelled_by_price(self):
        r = report([], ordered=0.01)
        self.assertIn("IOC", r.reason)


class TestUnreadableRow(unittest.TestCase):
    def test_row_without_a_size_is_no_data_not_zero(self):
        """`size: None` — строка без данных, а не нулевой филл. Сложить её как
        ноль значило бы сказать «исполнено 0.004 из 0.010» по ленте, в которой
        одного числа нет, и на этом вывести учёт."""
        r = report(
            [fill(trade_id=5, size="0.004"), fill(trade_id=6, size=None)], ordered=0.01
        )
        self.assertEqual(r.status, mirror_fill.UNCONFIRMED)
        self.assertIsNone(r.executed_base)
        self.assertIn("6", r.reason)


if __name__ == "__main__":
    unittest.main()
