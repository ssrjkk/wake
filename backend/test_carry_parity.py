"""Пара carry-ног: одна таблица написаний, две реализации.

Запуск: python3 -m unittest test_carry_parity -v

Повод. `pairable_carry_markets` (backend/funding_arb.py) решает, по каким
инструментам дельта-нейтральная позиция вообще строится, и именно его ответ
читает `/funding-arb/size`. Панель (`src/components/Funding.tsx`) показывала
список по своему правилу: спот искался по суффиксу `"/USDC"`, а `status` не
проверялся ни на одной ноге. Неактивный рынок — Lighter отдаёт их в
`/orderBooks` — выглядел открытой возможностью, и предложение поставить
позицию по рынку, где ордер не принять, было молча рабочим местом.

Теперь панель разбирает книгу той же функцией, что и тесты (`src/lib/carry.ts`),
а таблица написаний одна: она лежит в `src/lib/carry.test.ts`, читается отсюда
как есть и прогоняется здесь через бэкенд. Сверка таблиц, а не кода —
сознательная граница: второй копии правила на Python не появляется, а
разночтение двух реализаций ловится ровно на тех строках, на которых его
ловит фронтенд.

Отдельно закреплено, что таблица вообще различает правила: зеркало прежнего
суффиксного разбора (`_suffix_rule`) обязано расходиться с ней на неактивных
ногах. Таблица, на которой правило и его догадка дают один ответ, ничего не
проверяет.
"""

import re
import unittest
from pathlib import Path

from funding_arb import pairable_carry_markets

ROOT = Path(__file__).resolve().parent.parent
TS_TEST = ROOT / "src" / "lib" / "carry.test.ts"
TS_CARRY = ROOT / "src" / "lib" / "carry.ts"
PANEL = ROOT / "src" / "components" / "Funding.tsx"

# Строка таблицы пишется в одну линию и в одном порядке ключей — это формат,
# а не стиль: regex ниже разбирает именно его.
PAIR_ROW = re.compile(
    r'\{\s*perp:\s*"(?P<perp>[^"]*)",\s*spot:\s*"(?P<spot>[^"]*)",'
    r'\s*perpStatus:\s*"(?P<perp_status>active|inactive)",'
    r'\s*spotStatus:\s*"(?P<spot_status>active|inactive)",'
    r"\s*pair:\s*(?P<pair>true|false)\s*\}"
)
BASE_ROW = re.compile(
    r'\{\s*spot:\s*"(?P<spot>[^"]*)",\s*base:\s*(?:"(?P<base>[^"]*)"|null)\s*\}'
)


def _rows(text: str, pattern: re.Pattern) -> list:
    """Разбор таблицы из TS-файла. Пустой результат — это не «тест пройден», а
    сломанный формат: молча сверять нечего было бы нельзя."""
    found = [m.groupdict() for m in pattern.finditer(text)]
    if not found:
        raise AssertionError(
            f"в {TS_TEST.name} не найдено ни одной строки таблицы — формат изменился, "
            "а сверка с ним здесь нет"
        )
    return found


def _books(row: dict) -> list:
    return [
        {
            "market_id": 1,
            "symbol": row["perp"],
            "market_type": "perp",
            "status": row["perp_status"],
            "min_base_amount": "0.001",
            "supported_size_decimals": 4,
        },
        {
            "market_id": 2,
            "symbol": row["spot"],
            "market_type": "spot",
            "status": row["spot_status"],
            "min_base_amount": "0.001",
            "supported_size_decimals": 4,
        },
    ]


def _suffix_rule(books: list, quote: str = "USDC") -> list:
    """Зеркало прежнего панельного разбора: суффикс и никаких проверок статуса.

    Нужна ровно одна строка правила — иначе «прежняя реализация» превратится в
    вторую копию нынешней и расхождение перестанет быть измеримым.
    """
    perps = {b["symbol"] for b in books if b.get("market_type") == "perp"}
    out = []
    for b in books:
        if b.get("market_type") != "spot":
            continue
        symbol = b.get("symbol", "")
        if symbol.endswith(f"/{quote}"):
            base = symbol[: -len(f"/{quote}")]
            if base in perps:
                out.append(base)
    return out


class TestCarryTableIsReadable(unittest.TestCase):
    def setUp(self):
        self.text = TS_TEST.read_text(encoding="utf-8")
        self.rows = _rows(self.text, PAIR_ROW)
        self.bases = _rows(self.text, BASE_ROW)

    def test_table_is_big_enough_to_be_a_check(self):
        self.assertGreaterEqual(len(self.rows), 10, str(len(self.rows)))
        self.assertGreaterEqual(len(self.bases), 8, str(len(self.bases)))

    def test_table_has_rows_on_both_sides_of_every_rule(self):
        """И активных пар, и отказа по статусу, и отказа по разбору — по
        несколько, иначе правка одного условия не покраснела бы нигде."""
        pairs = [r for r in self.rows if r["pair"] == "true"]
        inactive = [
            r
            for r in self.rows
            if r["pair"] == "false"
            and "inactive" in (r["perp_status"], r["spot_status"])
        ]
        parse = [
            r
            for r in self.rows
            if r["pair"] == "false"
            and "inactive" not in (r["perp_status"], r["spot_status"])
        ]
        self.assertGreaterEqual(len(pairs), 2)
        self.assertGreaterEqual(len(inactive), 3)
        self.assertGreaterEqual(len(parse), 5)

    def test_every_spot_spelling_is_checked_against_the_backend_too(self):
        """Таблица разбора не может остаться набором ожиданий только для TS:
        каждое написание из неё обязано стоять и в таблице пар, где его видит
        бэкенд."""
        in_pairs = {r["spot"] for r in self.rows}
        missing = [r["spot"] for r in self.bases if r["spot"] not in in_pairs]
        self.assertEqual(missing, [])


class TestBackendMatchesTheFrontendTable(unittest.TestCase):
    def setUp(self):
        self.rows = _rows(TS_TEST.read_text(encoding="utf-8"), PAIR_ROW)

    def test_backend_answers_the_table(self):
        for row in self.rows:
            with self.subTest(
                perp=row["perp"],
                spot=row["spot"],
                status=f"{row['perp_status']}/{row['spot_status']}",
            ):
                legs = pairable_carry_markets(_books(row))
                expected = [row["perp"]] if row["pair"] == "true" else []
                self.assertEqual([leg.symbol for leg in legs], expected)

    def test_a_pair_names_both_legs_by_id(self):
        """Символ базы — это ещё не нога: у пары должны быть id перпа и спота,
        иначе размер считается по чужой книге."""
        for row in self.rows:
            if row["pair"] != "true":
                continue
            with self.subTest(perp=row["perp"]):
                leg = pairable_carry_markets(_books(row))[0]
                self.assertEqual((leg.perp_market_id, leg.spot_market_id), (1, 2))

    def test_table_distinguishes_the_rule_from_the_suffix_guess(self):
        """Строки, на которых прежний суффиксный разбор отвечает иначе, чем
        правило, — измеримая часть таблицы. Их список закреплён: новая строка,
        которая ничего не различает, в таблицу попадает, а её вклад — ноль, и
        незаметно, что проверка выродилась."""
        differs = []
        for row in self.rows:
            naive = _suffix_rule(_books(row))
            honest = [leg.symbol for leg in pairable_carry_markets(_books(row))]
            if naive != honest:
                differs.append(f"{row['perp']} + {row['spot']}")
        self.assertEqual(
            differs,
            ["SOL + SOL/USDC", "LINK + LINK/USDC", "DOGE + DOGE/USDC"],
        )


class TestPanelUsesTheSharedRule(unittest.TestCase):
    """Одного правила в модуле мало: панель могла бы остаться при своём разборе
    и просто не показывать расхождение. Поэтому проверяется сам исходник."""

    def test_panel_reads_the_carry_module(self):
        source = PANEL.read_text(encoding="utf-8")
        self.assertIn("pairableCarryMarkets", source)
        self.assertIn('from "../lib/carry"', source)

    def test_no_string_compare_of_the_quote_survives_the_sources(self):
        """`endsWith("/USDC")` — та форма, из-за которой спот становился парой по
        хвосту строки. В панели и в модуле правила ей не место; в тесте она
        есть намеренно, как зеркало прежнего разбора."""
        for path in (PANEL, TS_CARRY):
            with self.subTest(path=path.name):
                self.assertNotIn('endsWith("/USDC")', path.read_text(encoding="utf-8"))

    def test_carry_module_gates_both_legs_on_status(self):
        """Обе ноги читают статус рынка, и читают в разных смыслах: перп берётся
        только активный, неактивный спот отвергается. Проверка по строкам
        правила, а не по поведению, нужна ровно потому, что поведение здесь
        проверяет vitest, а этот гейт его не запускает.

        Читается не литерал `status === "active"`, а вызов `isTradeable`: с
        этого года торгуемость рынка решает одна функция в `src/lib/lighter.ts`,
        и правило, повторённое строкой в панели, расходится с ней в тот день,
        когда площадка добавит второй признак. Сырое сравнение с флагом внутри
        модуля правила поэтому красное: оно и есть второй владелец правила."""
        source = TS_CARRY.read_text(encoding="utf-8")
        gates = [
            line.strip()
            for line in source.splitlines()
            if "market_type" in line and "isTradeable" in line
        ]
        self.assertEqual(len(gates), 2, gates)
        self.assertIn('market_type === "perp"', gates[0])
        self.assertIn("isTradeable(m)", gates[0])
        self.assertIn('market_type !== "spot"', gates[1])
        self.assertIn("!isTradeable(m)", gates[1])
        for bypass in ('status === "active"', 'status !== "active"'):
            self.assertNotIn(bypass, source, f"второй владелец флага статуса: {bypass}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
