"""
Property-тесты денежной математики: не «что даёт эта конкретная пара чисел»,
а «какое утверждение верно для ЛЮБОГО входа».

python3 -m unittest test_properties -v

Чем это отличается от test_quant.py, test_mirror_engine.py, test_predict_amm.py
и test_portfolio_risk.py: там зафиксированные примеры, в том числе собранные на
живых шагах Lighter. Здесь тот же код прогоняется через тысячи псевдослучайных
входов и проверяет неравенства, которые одним примером не проверить — «ордер
никогда не больше позиции», «обязательство рынка никогда не больше резерва».

Псевдослучайность на зерне (random.Random со своим зерном в каждой проверке), а
не hypothesis:
- упавший тест обязан воспроизводиться ровно с теми же числами, иначе он
  бесполезен в CI, где никто не пересматривает вывод прогона;
- контрпример искать не нужно — инварианты формулируются по определению функции
  и проверяются на всём диапазоне сразу;
- hypothesis — новая зависимость в requirements и в образе Docker, а выигрыш
  против тысяч зёрен с мусорными значениями в генераторе был бы нулевой.

Мусор (NaN, ±inf, нули, отрицательные) генерируется НАМЕРЕННО и в каждой
проверке: это не фантазия про битый вход, а то, что реально лежит в колонках
типа Float и что приходит из diff-а трекера позиций. Так этот файл и нашёл три
места до того, как они дошли до прода:
  - compute_mirror_plan бросала ValueError на NaN в аллокации подписчика —
    граница по полям события была, по полям подписчика нет, а вызывает её цикл
    вебсокета (leader_listener.py), где исключение стоит зеркалирования всем
    подписчикам лидера;
  - size_delta_neutral_position бросала ValueError на NaN капитале вместо
    обещанного None;
  - min(desired_notional, маржа) с NaN-маржой возвращает desired_notional, то
    есть подписчик с битой строкой получал ордер, рассчитанный «как будто
    потолка нет» — теперь такие строки пропускаются с явной причиной.
"""

import math
import random
import unittest
from decimal import Decimal

from funding_arb import size_delta_neutral_position
from mirror_engine import (
    FollowerConfig,
    LeaderEvent,
    MarketConstraints,
    Side,
    compute_mirror_plan,
)
from portfolio_risk import (
    Position,
    diversification_score,
    naive_dollar_volatility,
    pearson_correlation,
    portfolio_dollar_volatility,
    price_returns,
    suggest_hedge,
    volatility,
)
from predict_amm import LMSRMarket
from quant import round_down, scale_to_int

TRIALS = 2000
# Реальные шаги рынков Lighter: size_decimals 0..5, price_decimals 2..6 (замер
# mainnet 2026-10-24), а не выдуманный диапазон.
SIZE_DECIMALS = (0, 1, 2, 3, 4, 5)
NON_FINITE = (float("nan"), float("inf"), -float("inf"))


def tick_size(decimals: int) -> float:
    """Один шаг рынка при данном size_decimals — генератор берёт его за
    min_base_amount, чтобы «не ниже минимума» было чем проверить."""
    return 10.0**-decimals


def on_grid(value: float, decimals: int) -> bool:
    """Лежит ли значение на сетке рынка (шаг 10**-decimals).

    Проверка через Decimal(repr()), а не `value * 10**d`: у float произведение
    на шаге крупного рынка шумит до 6e-5 (замерено на 1e12-порядке), и этим
    шумом сетка неотличима от ошибки. Decimal(repr()) — ровно тот же путь,
    которым round_down на эту сетку значение и ставит."""
    scaled = Decimal(repr(value)).scaleb(decimals)
    return scaled == scaled.to_integral_value()


class TestQuantTotality(unittest.TestCase):
    """Округление размера — единственная точка, через которую проходит каждый
    базовый размер ордера в бэкенде. Его инварианты и есть «недоисполнить
    безопасно, переисполнить нет»."""

    def test_round_down_never_increases_magnitude(self):
        rng = random.Random(101)
        for _ in range(TRIALS):
            decimals = rng.choice(SIZE_DECIMALS)
            value = rng.uniform(-1e6, 1e6)
            result = round_down(value, decimals)
            # Для отрицательного «вниз» — к нулю по модулю: так работает Decimal
            # ROUND_DOWN, и для размера ордера важен именно модуль — он никогда
            # не растёт.
            self.assertLessEqual(
                abs(result), abs(value) + 1e-12, f"{value} -> {result}"
            )
            self.assertTrue(math.isfinite(result))

    def test_round_down_result_is_always_on_the_market_grid(self):
        rng = random.Random(102)
        for _ in range(TRIALS):
            decimals = rng.choice(SIZE_DECIMALS)
            value = rng.uniform(0, 1e6)
            result = round_down(value, decimals)
            self.assertTrue(
                on_grid(result, decimals),
                f"round_down({value!r}, {decimals}) = {result!r} мимо шага 10**-{decimals}",
            )

    def test_round_down_of_a_grid_value_is_identity(self):
        rng = random.Random(103)
        for _ in range(TRIALS):
            decimals = rng.choice(SIZE_DECIMALS)
            value = rng.randint(0, 10**6) / 10**decimals
            self.assertEqual(
                round_down(value, decimals), value, f"{value} уже на сетке"
            )

    def test_round_down_refuses_non_finite_instead_of_returning_it(self):
        for value in NON_FINITE:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    round_down(value, 2)

    def test_round_down_refuses_sizes_wider_than_decimal_precision(self):
        """Не «ноль» и не «огромный ордер», а ValueError, ровно там, где
        значение перестаёт влезать в 28 разрядов Decimal-контекста (это
        getcontext().prec по умолчанию): число из D разрядов при шаге 10**-d
        требует D+d разрядов."""
        for decimals in SIZE_DECIMALS:
            with self.subTest(decimals=decimals):
                last_ok = 10.0 ** (27 - decimals)  # 28 разрядов — влезает
                self.assertEqual(round_down(last_ok, decimals), last_ok)
                for exponent in (28 - decimals, 30 - decimals):
                    with self.assertRaises(ValueError):
                        round_down(10.0**exponent, decimals)

    def test_scale_to_int_lands_on_the_nearest_tick(self):
        rng = random.Random(105)
        half = Decimal("0.5")
        for _ in range(TRIALS):
            decimals = rng.randint(2, 6)
            value = rng.uniform(0, 2e5)
            ticks = scale_to_int(value, decimals)
            # Точная проверка в Decimal: scale_to_int сам считает ROUND_HALF_UP
            # по Decimal(repr(value)), поэтому расстояние до выбранного тика не
            # больше половины тика — без float-допуска.
            exact = Decimal(repr(value)) * (Decimal(10) ** decimals)
            self.assertLessEqual(abs(Decimal(ticks) - exact), half)
            self.assertGreaterEqual(ticks, 0)

    def test_scale_to_int_refuses_non_finite(self):
        for value in NON_FINITE:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    scale_to_int(value, 4)


def leader_event(rng, *, is_increase, price, size_delta, equity, before):
    return LeaderEvent(
        market_id=rng.randint(0, 300),
        side=rng.choice([Side.LONG, Side.SHORT]),
        is_increase=is_increase,
        size_delta=size_delta,
        price=price,
        leader_equity_usd=equity,
        leader_position_before=before,
    )


def random_follower(rng, follower_id):
    """Поля подписчика с примесью неконечных значений — ровно то, что может
    лежать в строке follows."""
    pick = rng.random()
    allocation = (
        rng.uniform(0, 1e5) if pick < 0.8 else rng.choice(NON_FINITE + (0.0, -1.0))
    )
    pick = rng.random()
    margin = rng.uniform(0, 1e4) if pick < 0.8 else rng.choice(NON_FINITE + (0.0,))
    pick = rng.random()
    leverage = rng.uniform(1, 20) if pick < 0.85 else rng.choice(NON_FINITE + (0.0,))
    pick = rng.random()
    mirrored = (
        rng.uniform(0, 50) if pick < 0.75 else rng.choice(NON_FINITE + (-3.0, 0.0))
    )
    return FollowerConfig(
        follower_id=follower_id,
        allocation_usd=allocation,
        available_margin_usd=margin,
        max_leverage=leverage,
        current_mirrored_size=mirrored,
    )


def finite_follower(rng, follower_id):
    """Подписчик, у которого все числа настоящими числами и положительными —
    чтобы неравенства ниже было с чем сравнивать."""
    while True:
        follower = random_follower(rng, follower_id)
        values = (
            follower.allocation_usd,
            follower.available_margin_usd,
            follower.max_leverage,
            follower.current_mirrored_size,
        )
        if all(math.isfinite(v) and v > 0 for v in values):
            return follower


def random_constraints(rng):
    decimals = rng.choice(SIZE_DECIMALS)
    minimum = tick_size(decimals) if rng.random() < 0.9 else rng.uniform(0, 1e-3)
    return MarketConstraints(
        min_base_amount=minimum, size_decimals=decimals, price_decimals=2
    )


class TestMirrorPlanInvariants(unittest.TestCase):
    """compute_mirror_plan — место, где решение «сколько зеркалить» становится
    числом. Она обязана отвечать планом с причиной на каждого подписчика при
    ЛЮБОМ входе: вызывает её цикл вебсокета, и одно битое значение не имеет
    права стоить зеркалирования остальным."""

    def test_plan_is_total_and_accounts_for_every_follower(self):
        rng = random.Random(201)
        for _ in range(TRIALS):
            price = (
                rng.uniform(1e-4, 2e5)
                if rng.random() < 0.7
                else rng.choice(NON_FINITE + (0.0, -1.0))
            )
            size_delta = (
                rng.uniform(1e-4, 1e3)
                if rng.random() < 0.7
                else rng.choice(NON_FINITE + (0.0,))
            )
            equity = (
                rng.uniform(50, 5e6)
                if rng.random() < 0.7
                else rng.choice(NON_FINITE + (0.0,))
            )
            before = (
                rng.uniform(1e-3, 1e3)
                if rng.random() < 0.7
                else rng.choice(NON_FINITE + (0.0,))
            )
            followers = [
                random_follower(rng, f"f{i}") for i in range(rng.randint(1, 5))
            ]
            event = leader_event(
                rng,
                is_increase=rng.random() < 0.5,
                price=price,
                size_delta=size_delta,
                equity=equity,
                before=before,
            )
            # Ни один из этих входов не должен превратиться в исключение:
            # листенер отличает исключение только как обрыв соединения, а не как
            # «у одного подписчика битая строка».
            plan = compute_mirror_plan(event, followers, random_constraints(rng))
            ordered = [o.follower_id for o in plan.orders]
            skipped = [s.follower_id for s in plan.skipped]
            self.assertEqual(len(ordered) + len(skipped), len(followers))
            self.assertEqual(len(set(ordered) | set(skipped)), len(followers))
            self.assertFalse(
                set(ordered) & set(skipped),
                "подписчик не может быть одновременно зеркален и пропущен",
            )

    def test_every_emitted_order_is_a_real_size_inside_its_bounds(self):
        rng = random.Random(202)
        emitted = 0
        for _ in range(TRIALS):
            price = rng.uniform(1e-4, 2e5)
            size_delta = rng.uniform(1e-4, 1e3)
            equity = rng.uniform(50, 5e6)
            before = rng.uniform(1e-3, 1e3)
            is_increase = rng.random() < 0.5
            followers = [
                finite_follower(rng, f"f{i}") for i in range(rng.randint(1, 4))
            ]
            constraints = random_constraints(rng)
            event = leader_event(
                rng,
                is_increase=is_increase,
                price=price,
                size_delta=size_delta,
                equity=equity,
                before=before,
            )
            plan = compute_mirror_plan(event, followers, constraints)
            by_id = {f.follower_id: f for f in followers}
            for order in plan.orders:
                emitted += 1
                self.assertTrue(math.isfinite(order.base_amount), order)
                self.assertGreater(order.base_amount, 0, order)
                self.assertTrue(
                    on_grid(order.base_amount, constraints.size_decimals),
                    f"{order.base_amount!r} мимо шага рынка {constraints.size_decimals}",
                )
                self.assertGreaterEqual(
                    order.base_amount,
                    constraints.min_base_amount,
                    f"ордер меньше минимума рынка: {order}",
                )
                self.assertEqual(order.market_id, event.market_id)
                self.assertEqual(order.side, event.side)
                follower = by_id[order.follower_id]
                notional = order.base_amount * price
                slack = abs(notional) * 1e-9 + 1e-12
                if is_increase:
                    self.assertFalse(order.reduce_only)
                    # Недоисполнить безопасно, переисполнить — нет: и доля от
                    # своей аллокации, и потолок по марже соблюдены с точностью
                    # до округления вниз.
                    desired = (size_delta * price / equity) * follower.allocation_usd
                    ceiling = follower.available_margin_usd * follower.max_leverage
                    self.assertLessEqual(notional, min(desired, ceiling) + slack, order)
                else:
                    self.assertTrue(order.reduce_only)
                    self.assertLessEqual(
                        order.base_amount,
                        follower.current_mirrored_size + 1e-12,
                        "зеркальное закрытие больше собственной позиции подписчика",
                    )
        self.assertGreater(emitted, 0, "генератор никогда не выдал ордер — тест пустой")

    def test_non_finite_event_mirrors_nobody(self):
        rng = random.Random(203)
        followers = [random_follower(rng, f"f{i}") for i in range(3)]
        for value in NON_FINITE:
            # increase: price, size_delta, leader_equity_usd участвуют в расчёте
            for field, is_increase in (
                ("price", True),
                ("size_delta", True),
                ("equity", True),
                ("before", False),
                ("size_delta", False),
            ):
                with self.subTest(value=value, field=field, increase=is_increase):
                    event = leader_event(
                        rng,
                        is_increase=is_increase,
                        price=value if field == "price" else 100.0,
                        size_delta=value if field == "size_delta" else 1.0,
                        equity=value if field == "equity" else 5000.0,
                        before=value if field == "before" else 2.0,
                    )
                    plan = compute_mirror_plan(
                        event, followers, MarketConstraints(0.001, 3, 2)
                    )
                    self.assertEqual(plan.orders, [])
                    self.assertEqual(
                        [s.reason for s in plan.skipped],
                        ["event_data_unavailable"] * len(followers),
                    )

    def test_follower_config_garbage_has_a_fixed_answer_per_field(self):
        """Таблица, а не «что-нибудь разумное»: поведение при битой строке
        подписчика должно быть предсказуемым, потому что по этим причинам пишет
        mirror_log и по ним человек разбирает, почему его не зеркалили."""
        base = FollowerConfig("f1", 1000.0, 100.0, 5.0, 1.0)
        # сосед по событию с гарантированно валидными числами: у него ордер
        # обязан появиться в обеих ветках, иначе «битая строка не тронула
        # остальных» ничего не проверяет
        healthy = FollowerConfig("ok", 1000.0, 100.0, 5.0, 10.0)
        increase = LeaderEvent(
            market_id=7,
            side=Side.LONG,
            is_increase=True,
            size_delta=1.0,
            price=100.0,
            leader_equity_usd=5000.0,
        )
        reduce_ = LeaderEvent(
            market_id=7,
            side=Side.LONG,
            is_increase=False,
            size_delta=1.0,
            price=100.0,
            leader_equity_usd=5000.0,
            leader_position_before=2.0,
        )
        expectations = {
            ("allocation_usd", float("nan")): "follower_data_unavailable",
            ("allocation_usd", float("inf")): "follower_data_unavailable",
            ("available_margin_usd", float("nan")): "follower_data_unavailable",
            ("max_leverage", float("inf")): "follower_data_unavailable",
            ("allocation_usd", 0.0): "below_min_order_size",
            ("available_margin_usd", 0.0): "below_min_order_size",
            ("max_leverage", 0.0): "below_min_order_size",
            ("available_margin_usd", -100.0): "below_min_order_size",
            ("current_mirrored_size", float("nan")): "mirrored_size_unavailable",
            ("current_mirrored_size", float("inf")): "mirrored_size_unavailable",
            ("current_mirrored_size", 0.0): "no_mirrored_position_to_reduce",
            ("current_mirrored_size", -3.0): "no_mirrored_position_to_reduce",
        }
        for (field, value), reason in expectations.items():
            event = reduce_ if field == "current_mirrored_size" else increase
            with self.subTest(field=field, value=value):
                follower = FollowerConfig(**{**base.__dict__, field: value})
                plan = compute_mirror_plan(
                    event, [follower, healthy], MarketConstraints(1e-3, 3, 2)
                )
                self.assertEqual(
                    [s.reason for s in plan.skipped if s.follower_id == "f1"], [reason]
                )
                self.assertEqual(
                    [o.follower_id for o in plan.orders],
                    ["ok"],
                    "битая строка не должна влиять на соседа по событию",
                )

    def test_size_too_large_for_the_step_is_skipped_not_sent(self):
        """Все поля конечны и положительны, но размера ордера не существует:
        inf от переполнения произведения и число, которое не помещается в
        28 разрядов Decimal при шаге рынка. Это всё ещё «нет размера», а не
        ордер, и totality-граница обязана ответить причиной, а не исключением,
        потому что выше неё стоит цикл вебсокета."""
        for label, follower, event in (
            (
                "переполнение в inf",
                FollowerConfig("f1", 1e300, 1e300, 1e300, 0.0),
                LeaderEvent(
                    market_id=7,
                    side=Side.LONG,
                    is_increase=True,
                    size_delta=1e300,
                    price=1.0,
                    leader_equity_usd=1.0,
                ),
            ),
            (
                "не представимо на шаге",
                FollowerConfig("f1", 1e25, 1e25, 1.0, 0.0),
                LeaderEvent(
                    market_id=7,
                    side=Side.LONG,
                    is_increase=True,
                    size_delta=1.0,
                    price=1.0,
                    leader_equity_usd=1.0,
                ),
            ),
        ):
            with self.subTest(case=label):
                plan = compute_mirror_plan(
                    event, [follower], MarketConstraints(0.001, 3, 2)
                )
                self.assertEqual(plan.orders, [])
                self.assertEqual(
                    [s.reason for s in plan.skipped], ["mirror_size_uncomputable"]
                )


class TestLMSRInvariants(unittest.TestCase):
    """Цена бинарного рынка и обязательство маркетмейкера под ней — то, чем
    человек рискует в панели Predict."""

    def test_prices_are_complementary_and_inside_zero_one(self):
        rng = random.Random(301)
        for _ in range(TRIALS):
            market = LMSRMarket(
                b=rng.uniform(0.5, 5000.0),
                q_yes=rng.uniform(-1e4, 1e4),
                q_no=rng.uniform(-1e4, 1e4),
            )
            yes = market.price_yes()
            self.assertGreaterEqual(yes, 0.0)
            self.assertLessEqual(yes, 1.0)
            # price_no() — это буквально 1 - price_yes(); сумма обязана быть
            # ровно 1.0, иначе оба исхода вместе продаются дороже или дешевле
            # одного доллара.
            self.assertEqual(yes + market.price_no(), 1.0)

    def test_liability_never_exceeds_the_declared_reserve(self):
        """max_subsidy() — не справка, а граничный убыток маркетмейкера: за
        любые q shares, оцененные по текущим ценам, не могут быть больше
        уплаченного больше чем на b·ln(2). Считается через публичный trade(),
        чтобы проверка не пересказывала формулу из того же файла."""
        rng = random.Random(302)
        ln2 = math.log(2)
        for _ in range(TRIALS):
            b = rng.uniform(0.5, 5000.0)
            market = LMSRMarket(b=b)
            q_yes = rng.uniform(-1e5, 1e5)
            q_no = rng.uniform(-1e5, 1e5)
            paid = market.trade("yes", q_yes) + market.trade("no", q_no)
            collected = paid + b * ln2  # C(0,0) = b·ln2, уплаченное над нулевой точкой
            liability = (
                q_yes * market.price_yes() + q_no * market.price_no() - collected
            )
            self.assertTrue(math.isfinite(liability))
            self.assertLessEqual(liability, b * 1e-9)
            self.assertGreaterEqual(liability, -(market.max_subsidy() + b * 1e-9))

    def test_reserve_is_exactly_the_short_of_a_fresh_market(self):
        rng = random.Random(303)
        for _ in range(500):
            b = rng.uniform(1.0, 5000.0)
            market = LMSRMarket(b=b)
            self.assertAlmostEqual(
                market._cost(0.0, 0.0), market.max_subsidy(), places=9
            )

    def test_round_trip_of_shares_costs_nothing(self):
        rng = random.Random(304)
        for _ in range(TRIALS):
            b = rng.uniform(1.0, 5000.0)
            q_yes = rng.uniform(0, 1e4)
            q_no = rng.uniform(0, 1e4)
            market = LMSRMarket(b=b, q_yes=q_yes, q_no=q_no)
            outcome = rng.choice(["yes", "no"])
            shares = rng.uniform(0, 500)
            paid = market.trade(outcome, shares)
            refunded = market.trade(outcome, -shares)
            self.assertAlmostEqual(paid + refunded, 0.0, delta=abs(paid) * 1e-9 + 1e-9)
            self.assertAlmostEqual(market.q_yes, q_yes, places=6)
            self.assertAlmostEqual(market.q_no, q_no, places=6)

    def test_more_yes_never_lowers_the_yes_price(self):
        rng = random.Random(305)
        for _ in range(TRIALS):
            b = rng.uniform(1.0, 5000.0)
            q_yes = rng.uniform(-1e4, 1e4)
            q_no = rng.uniform(-1e4, 1e4)
            step = rng.uniform(0, 100)
            before = LMSRMarket(b, q_yes, q_no).price_yes()
            after = LMSRMarket(b, q_yes + step, q_no).price_yes()
            self.assertGreaterEqual(after, before - 1e-12)


class TestPortfolioRiskInvariants(unittest.TestCase):
    """Risk-панель показывает число, по которому человек открывает хедж. Если
    неравенства ниже нарушаются, число врёт."""

    def test_volatility_is_finite_and_non_negative_on_garbage(self):
        rng = random.Random(401)
        for _ in range(TRIALS):
            series = [
                rng.uniform(-1, 1) if rng.random() > 0.2 else rng.choice(NON_FINITE)
                for _ in range(rng.randint(0, 12))
            ]
            value = volatility(series)
            self.assertTrue(math.isfinite(value), series)
            self.assertGreaterEqual(value, 0.0)

    def test_price_returns_drops_bad_pairs_and_never_raises(self):
        rng = random.Random(402)
        junk = (0.0, -1.0) + NON_FINITE
        for _ in range(TRIALS):
            prices = [
                rng.uniform(1, 1e5) if rng.random() > 0.15 else rng.choice(junk)
                for _ in range(rng.randint(0, 15))
            ]
            returns = price_returns(prices)
            self.assertLessEqual(len(returns), max(len(prices) - 1, 0))
            for value in returns:
                self.assertTrue(math.isfinite(value), prices)

    def test_correlation_is_bounded_and_symmetric_about_sign(self):
        rng = random.Random(403)
        for _ in range(TRIALS):
            n = rng.randint(2, 30)
            a = [rng.uniform(-0.2, 0.2) for _ in range(n)]
            b = [rng.uniform(-0.2, 0.2) for _ in range(n)]
            self.assertGreaterEqual(pearson_correlation(a, b), -1.0)
            self.assertLessEqual(pearson_correlation(a, b), 1.0)
            if volatility(a) > 0:
                self.assertAlmostEqual(pearson_correlation(a, a), 1.0, places=12)
                self.assertAlmostEqual(
                    pearson_correlation(a, [-x for x in a]), -1.0, places=12
                )

    def test_portfolio_volatility_never_exceeds_the_naive_sum(self):
        """Неравенство треугольника: риск портфеля не может быть больше суммы
        рисков ног. Если бы мог — панель показывала бы отрицательную
        «диверсификацию» на корректных данных."""
        rng = random.Random(404)
        for _ in range(TRIALS):
            markets = list(range(rng.randint(1, 5)))
            returns = {
                mid: [rng.uniform(-0.2, 0.2) for _ in range(rng.randint(4, 40))]
                for mid in markets
            }
            positions = [
                Position(mid, f"S{mid}", rng.uniform(-5000, 5000)) for mid in markets
            ]
            actual = portfolio_dollar_volatility(positions, returns)
            naive = naive_dollar_volatility(positions, returns)
            self.assertTrue(math.isfinite(actual) and math.isfinite(naive))
            self.assertGreaterEqual(actual, 0.0)
            self.assertLessEqual(actual, naive + 1e-9)
            score = diversification_score(positions, returns)
            self.assertGreaterEqual(score, -1e-9)
            self.assertLessEqual(score, 1.0 + 1e-9)

    def test_zero_and_short_legs_stay_inside_the_same_bounds(self):
        rng = random.Random(405)
        for _ in range(TRIALS):
            returns = {
                mid: [rng.uniform(-0.2, 0.2) for _ in range(rng.randint(4, 30))]
                for mid in range(3)
            }
            positions = [
                Position(0, "A", 0.0),
                Position(1, "B", rng.uniform(-1e4, 1e4)),
                Position(2, "C", -rng.uniform(0, 1e4)),
            ]
            actual = portfolio_dollar_volatility(positions, returns)
            self.assertTrue(math.isfinite(actual) and actual >= 0.0)
            self.assertLessEqual(
                actual, naive_dollar_volatility(positions, returns) + 1e-9
            )

    def test_opposite_series_cancel_the_exposure_not_add_it(self):
        """ЗНАК корреляции — то, ради чего вообще считается ковариация.

        Два рынка, ряды которых точные противоположности: лонг на оба даёт
        нулевой риск портфеля, лонг плюс шорт — максимальный (двойная наивная
        сумма). Если в формуле variance взять |corr| вместо corr, оба числа
        поменяются местами, и Risk-панель наоборот скажет, что диверсификации
        нет там, где она полная. Ни один другой тест в проекте эту подмену не
        ловит: там отрицательной корреляции между РАЗНЫМИ рынками просто нет."""
        rng = random.Random(407)
        checked = 0
        for _ in range(TRIALS):
            a = [rng.uniform(-0.2, 0.2) for _ in range(rng.randint(4, 30))]
            if volatility(a) == 0:
                continue
            checked += 1
            returns = {0: a, 1: [-x for x in a]}
            same_direction = [Position(0, "A", 1000.0), Position(1, "B", 1000.0)]
            opposite = [Position(0, "A", 1000.0), Position(1, "B", -1000.0)]
            naive = naive_dollar_volatility(same_direction, returns)
            # Точное погашение в float даёт остаток ~1.7e-8 от наивного риска
            # (замер на 5000 парах): дисперсия сходится к нулю вычитанием, а
            # потом ещё берётся корень — поэтому допуск относительный, а не
            # «ноль с шестью знаками».
            self.assertLessEqual(
                portfolio_dollar_volatility(same_direction, returns), naive * 1e-6
            )
            self.assertGreaterEqual(
                diversification_score(same_direction, returns), 1.0 - 1e-6
            )
            self.assertAlmostEqual(
                portfolio_dollar_volatility(opposite, returns),
                naive_dollar_volatility(opposite, returns),
                places=6,
            )
            self.assertAlmostEqual(
                diversification_score(opposite, returns), 0.0, places=6
            )
        self.assertGreater(checked, 0, "генератор не дал ни одного нефлатового ряда")

    def test_hedge_of_an_anticorrelated_candidate_keeps_the_right_sign(self):
        """Знак hedge_notional_usd — это сторона ордера, который человек реально
        откроет. Антикоррелированный актив хеджируется позицией В ТУ ЖЕ сторону
        (лонг + лонг), а не противоположной; подмена знака в формуле h*
        превращает хедж в удвоение риска, и результат всё ещё выглядит
        правдоподобно."""
        rng = random.Random(408)
        for _ in range(TRIALS):
            a = [rng.uniform(-0.2, 0.2) for _ in range(rng.randint(4, 30))]
            if volatility(a) == 0:
                continue
            scale = rng.uniform(0.5, 2.0)
            returns = {0: a, 1: [-scale * x for x in a]}
            target = Position(0, "A", rng.choice([1000.0, -1000.0]))
            suggestion = suggest_hedge(target, [(1, "B")], returns)
            self.assertIsNotNone(suggestion, "полный хедж антикоррелированным рядом")
            self.assertLess(suggestion.correlation_to_target, -0.99)
            self.assertLess(suggestion.correlation_to_target, -0.99)
            # тот же знак, что у позиции цели
            self.assertEqual(
                math.copysign(1.0, suggestion.hedge_notional_usd),
                math.copysign(1.0, target.signed_notional_usd),
            )

    def test_hedge_suggestion_never_offers_more_risk(self):
        rng = random.Random(406)
        offered = 0
        for _ in range(TRIALS):
            returns = {
                mid: [rng.uniform(-0.2, 0.2) for _ in range(rng.randint(4, 30))]
                for mid in range(4)
            }
            if rng.random() < 0.3:
                # кандидат, реально связанный с целью: без таких строк
                # генератор никогда не доходил бы до предложения и тест был бы
                # пустым
                returns[2] = [x * rng.uniform(0.2, 2.0) for x in returns[0]]
            notional = rng.uniform(-1e4, 1e4)
            target = Position(0, "T", notional if notional else 1000.0)
            suggestion = suggest_hedge(target, [(1, "B"), (2, "C"), (3, "D")], returns)
            if suggestion is None:
                continue
            offered += 1
            self.assertTrue(math.isfinite(suggestion.hedge_notional_usd))
            self.assertEqual(
                suggestion.symbol, {1: "B", 2: "C", 3: "D"}[suggestion.market_id]
            )
            self.assertGreaterEqual(suggestion.correlation_to_target, -1.0)
            self.assertLessEqual(suggestion.correlation_to_target, 1.0)
            self.assertLess(
                suggestion.resulting_portfolio_vol_usd, suggestion.unhedged_vol_usd
            )
            self.assertGreaterEqual(suggestion.unhedged_vol_usd, 0.0)
        self.assertGreater(
            offered, 0, "генератор никогда не предложил хедж — тест пустой"
        )


class TestDeltaNeutralSizing(unittest.TestCase):
    """Cash-and-carry: обе ноги должны оставаться внутри капитала, иначе
    «дельта-нейтральная» позиция требует больше, чем в неё дали."""

    def test_legs_fit_the_capital_and_the_market_grid(self):
        rng = random.Random(501)
        sized = 0
        for _ in range(TRIALS):
            capital = rng.uniform(20, 1e6)
            price = rng.uniform(1e-4, 2e5)
            perp_d = rng.choice(SIZE_DECIMALS)
            spot_d = rng.choice(SIZE_DECIMALS)
            perp_min = tick_size(perp_d)
            spot_min = tick_size(spot_d)
            position = size_delta_neutral_position(
                capital, price, perp_d, spot_d, perp_min, spot_min
            )
            if position is None:
                continue
            sized += 1
            self.assertTrue(
                on_grid(position.perp_base_amount, perp_d)
                and on_grid(position.spot_base_amount, spot_d),
                position,
            )
            self.assertGreaterEqual(position.perp_base_amount, perp_min)
            self.assertGreaterEqual(position.spot_base_amount, spot_min)
            total = position.perp_notional_usd + position.spot_notional_usd
            self.assertTrue(math.isfinite(total))
            self.assertLessEqual(total, capital + 1e-9)
        self.assertGreater(sized, 0, "генератор никогда не посчитал позицию")

    def test_bad_inputs_return_none_instead_of_raising(self):
        junk = NON_FINITE + (0.0, -100.0)
        for value in junk:
            with self.subTest(capital=value):
                self.assertIsNone(
                    size_delta_neutral_position(value, 100.0, 2, 2, 0.01, 0.01)
                )
            with self.subTest(price=value):
                self.assertIsNone(
                    size_delta_neutral_position(1000.0, value, 2, 2, 0.01, 0.01)
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
