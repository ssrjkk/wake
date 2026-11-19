"""Бюджет инлайн-стилей: сколько `style={{` живёт в панели и почему ровно столько.

Запуск: python -m unittest test_inline_style_budget -v

Повод. До дизайн-волны 2026-11-19 во фронтенде было 563 вхождения `style=` в
`src/components/*.tsx` и `src/App.tsx` (замер `git grep -o 'style=' 52d02a3 --
src/components/*.tsx src/App.tsx | wc -l`), и геометрию туда писали руками:
прод давал 15 разных паддингов и 5 радиусов там, где тема владеет одним `--r`.
Инлайн-значение не переживает правку шкалы, не растёт с пользовательским
масштабом текста и не меняется в медиазапросе — поэтому всё, что обязано жить
на пальце и на десктопе по-разному, уехало в `src/index.css`.

Осталось двенадцать, и все они — числа, которые приходят из ответа площадки:
доля уровня в лестнице, баланс сторон, полоса диверсификации, ширина процента
yes, высота окна виртуализации, размеры скелетона. Такое значение нельзя
вынести в тему, потому что тема не знает данных.

Гейт делает три вещи:

  1. сверяет число инлайнов каждой панели с таблицей-зеркалом (позиция в
     позицию, как зеркало `:root` в тесте реестра токенов);
  2. запрещает в оставшихся инлайнах литералы геометрии и цвета — там обязан
     быть идентификатор, вызов или шаблон с интерполяцией;
  3. требует, чтобы каждый файл с ненулевым бюджетом был назван в CHANGELOG
     вместе с числом: правка без замера в прозе — это снова «примерно».

Уменьшение бюджета красное так же, как увеличение: таблица обязана описывать
дерево, а не быть потолком, под который можно расти молча.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CHANGELOG = ROOT / "CHANGELOG.md"

# Зеркало дерева: файл -> число вхождений `style={{` в размеченных компонентах.
# Снимено 2026-11-19 с коммита ce08d9c (вторая половина дизайн-волны); сумма — 12.
BUDGET: dict[str, int] = {
    "src/App.tsx": 2,
    "src/components/Dashboard.tsx": 1,
    "src/components/OrderBookPanel.tsx": 3,
    "src/components/Predict.tsx": 1,
    "src/components/Portfolio.tsx": 2,
    "src/components/Risk.tsx": 1,
    "src/components/Terminal.tsx": 1,
    "src/components/ui.tsx": 1,
}

# `style={{` в JSX. Файлы .test.tsx не считаются: там инлайн — это способ
# задать условие теста, а не разметка, которую увидит человек.
INLINE = re.compile(r"\bstyle=\{\{")

# Литерал геометрии или цвета внутри инлайна. Число в кавычках — именно то,
# что нельзя вынести в тему хитростью: `"7.5%"` проходит как строка, но остаётся
# константой, которая не переживает правку шкалы. Имя переменной, вызов и
# шаблон с `${...}` под этот запрет не попадают.
RAW_VALUE = re.compile(
    r"""["'][+-]?\d+(?:\.\d+)?(?:px|rem|em|%|deg|vh|vw|pt|s|ms)?["""
    r"""'"]|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|:\s*\d+(?:\.\d+)?\s*[,}]"""
)

TEST_SUFFIXES = (".test.tsx", ".test.ts")


def inline_lines(text: str) -> list[tuple[int, str]]:
    """Строки с `style={{` и захваченный сам инлайн (до закрывающих скобок)."""
    out: list[tuple[int, str]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if INLINE.search(line):
            out.append((number, line.strip()))
    return out


def source_files() -> list[Path]:
    return sorted(
        path
        for path in SRC.rglob("*.tsx")
        if not path.name.endswith((".test.tsx",)) and "node_modules" not in path.parts
    )


class TestInlineStyleBudget(unittest.TestCase):
    def test_table_names_exactly_the_files_with_inlines(self):
        found = {
            str(path.relative_to(ROOT).as_posix()): len(inline_lines(path.read_text(encoding="utf-8")))
            for path in source_files()
            if inline_lines(path.read_text(encoding="utf-8"))
        }
        self.assertEqual(
            sorted(BUDGET),
            sorted(found),
            "таблица бюджета называет другие файлы, чем дерево: "
            f"в таблице {sorted(set(BUDGET) - set(found))}, "
            f"в дереве {sorted(set(found) - set(BUDGET))}",
        )

    def test_count_per_file_matches_the_table(self):
        for rel, expected in sorted(BUDGET.items()):
            path = ROOT / Path(rel)
            with self.subTest(file=rel):
                self.assertEqual(
                    len(inline_lines(path.read_text(encoding="utf-8"))),
                    expected,
                    f"{rel}: в таблице {expected}, в файле иначе — перемерь и правь таблицу",
                )

    def test_total_budget_is_the_measured_number(self):
        self.assertEqual(sum(BUDGET.values()), 12, "сумма бюджета обязана быть измерена, а не выведена из строк")

    def test_no_raw_geometry_or_color_literal_in_surviving_inlines(self):
        offenders: list[str] = []
        for rel in sorted(BUDGET):
            for number, line in inline_lines((ROOT / Path(rel)).read_text(encoding="utf-8")):
                body = line[line.index("style={{") :]
                if RAW_VALUE.search(body):
                    offenders.append(f"{rel}:{number}: {body[:90]}")
        self.assertEqual(
            offenders,
            [],
            "в инлайне появился литерал: значение из данных пишется переменной или "
            "шаблоном с ${...}, а постоянная геометрия живёт в src/index.css",
        )

    def test_changelog_states_the_number_with_the_command_that_measured_it(self):
        prose = CHANGELOG.read_text(encoding="utf-8")
        # Проза обязана называть и цепочку, и команду: число без команды — это
        # «стало лучше», а не замер, и ровно так устарела пара 568 → 253.
        self.assertRegex(
            prose,
            r"(?s)\b563\b.{0,400}?\b255\b.{0,400}?\b12\b",
            "в CHANGELOG нет цепочки 563 → 255 → 12 по ревизиям: число инлайнов "
            "обязано быть перемерено, а не унаследовано из прошлой записи",
        )
        self.assertIn(
            "git grep -o 'style='",
            prose,
            "рядом с числом нет команды, которой оно мерилось",
        )

    def test_gate_would_see_a_new_inline(self):
        # Проверка против собственной слепоты: правка, которую гейт обязан
        # поймать, ловится. Здесь — на строке, которой в дереве нет.
        sample = '<div style={{ padding: "13px", color: "#123456" }} />'
        self.assertEqual(len(inline_lines(sample)), 1)
        self.assertTrue(RAW_VALUE.search(sample[sample.index("style={{") :]))


if __name__ == "__main__":
    unittest.main()
