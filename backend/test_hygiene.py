"""
Гигиена исходников проекта — то, что нельзя проверить типами и что уже случалось
здесь руками.

python3 -m unittest test_hygiene -v

Зачем это тест, а не правило в голове: в русскоязычные докстринги и комментарии
этого проекта несколько раз попадали подмены письменностей, а глаз такое не
видит, потому что читает слово по контексту. Ловилось и иероглиф вместо русского
слова («осталось», «такой», «самой» — трижды за один заход), и латинская буква
внутри кириллического слова (латинские L и e там, где должны быть кириллические
Л и е), и слипшееся написание латинского термина рядом с русским словом без
пробела. Поэтому защита не в внимательности, а в конвейере: падающая проверка
дешевле, чем правка постфактум.

Сами примеры здесь не приводятся нарочно — файл, который ловит такое, не может
сам содержать это же, и проверяющий это тест упал бы на собственном тексте.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Ассортимент блоков CJK: иероглифика Каны, хирагана/катакана, идеограммы,
# совместимые идеограммы и корейские слоги.
CJK = re.compile(
    "["
    "\u3040-\u30ff"  # хирагана, катакана
    "\u31f0-\u31ff"  # катакана-расширение
    "\u3400-\u4dbf"  # идеограммы расширение A
    "\u4e00-\u9fff"  # идеограммы базовые
    "\uf900-\ufaff"  # идеограммы совместимые
    "\uac00-\ud7af"  # корейские слоги
    "]"
)
ZERO_WIDTH = re.compile("[\u200b-\u200d\u2060\ufeff]")
TRAILING_WS = re.compile(r"[ \t]+$")
CYRILLIC = "\u0430-\u044f\u0451\u0410-\u042f\u0401"
# \u041b\u0430\u0442\u0438\u043d\u0438\u0446\u0430, \u0432\u043f\u0438\u0441\u0430\u043d\u043d\u0430\u044f \u0432 \u043a\u0438\u0440\u0438\u043b\u043b\u0438\u0447\u0435\u0441\u043a\u043e\u0435 \u0441\u043b\u043e\u0432\u043e, \u0438 \u043d\u0430\u043e\u0431\u043e\u0440\u043e\u0442 \u2014 \u0442\u043e\u0442 \u0436\u0435 \u043a\u043b\u0430\u0441\u0441
# \u043e\u043f\u0435\u0447\u0430\u0442\u043a\u0438, \u0447\u0442\u043e \u0438 \u0438\u0435\u0440\u043e\u0433\u043b\u0438\u0444: \u0433\u043b\u0430\u0437 \u0434\u043e\u0441\u0442\u0440\u0430\u0438\u0432\u0430\u0435\u0442 \u0441\u043b\u043e\u0432\u043e \u043f\u043e \u043a\u043e\u043d\u0442\u0435\u043a\u0441\u0442\u0443 \u0438 \u043d\u0435 \u0437\u0430\u043c\u0435\u0447\u0430\u0435\u0442
# \u043f\u043e\u0434\u043c\u0435\u043d\u044b. \u0422\u0430\u043a\u043e\u0435 \u043b\u043e\u0432\u0438\u043b\u043e\u0441\u044c \u0433\u043e\u0434\u0430\u043c\u0438 \u043f\u043e\u0437\u0436\u0435, \u0447\u0435\u043c \u0431\u044b\u043b\u043e \u043d\u0430\u043f\u0438\u0441\u0430\u043d\u043e, \u043f\u043e\u0442\u043e\u043c\u0443 \u0447\u0442\u043e \u0432\u044b\u0433\u043b\u044f\u0434\u0438\u0442
# \u043a\u0430\u043a \u043e\u043f\u0435\u0447\u0430\u0442\u043a\u0430 \u0442\u043e\u043b\u044c\u043a\u043e \u043a\u043e\u0433\u0434\u0430 \u0435\u0451 \u0438\u0449\u0435\u0448\u044c: \u00ab\u0440\u0430\u0441\u0447\u0451\u0442Risk-\u043f\u0430\u043d\u0435\u043b\u0438\u00bb, \u00ab\u0434\u0435peg\u00bb, \u00abLe\u0436\u0438\u0442\u00bb.
# \u0418\u0441\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u2014 \u0431\u0443\u043a\u0432\u044b escape-\u043f\u043e\u0441\u043b\u0435\u0434\u043e\u0432\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u0435\u0439: \u0432 "\n\u0438\u043b\u0438" \u043b\u0430\u0442\u0438\u043d\u0441\u043a\u0430\u044f n \u043d\u0435 \u0447\u0430\u0441\u0442\u044c
# \u0441\u043b\u043e\u0432\u0430, \u0430 \u043f\u0435\u0440\u0435\u0432\u043e\u0434 \u0441\u0442\u0440\u043e\u043a\u0438.
MIXED_SCRIPT = re.compile(rf"[A-Za-z][{CYRILLIC}]|[{CYRILLIC}][A-Za-z]")

SOURCE_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".css",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".json",
    ".sql",
    ".html",
}
SKIP_DIRS = {
    "node_modules",
    ".git",
    "dist",
    ".venv",
    "allure-results",
    "__pycache__",
    "visualizationOutputDirectory",
}


def sources():
    for path in ROOT.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def _lines_with(path, pattern):
    """Номера строк, где встречается pattern; файлы не нашей кодировки пропускаются."""
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return []
    return [
        number
        for number, line in enumerate(text.splitlines(), 1)
        if pattern.search(line)
    ]


class TestSourceHygiene(unittest.TestCase):
    def test_no_cjk_in_sources(self):
        bad = []
        for path in sources():
            for number in _lines_with(path, CJK):
                bad.append(f"{path.relative_to(ROOT)}:{number}")
        self.assertEqual(
            bad,
            [],
            "в исходниках появились иероглифы азиатских письменностей — "
            "обычно это случайная подмена русского слова на кириллице рядом",
        )

    def test_no_latin_inside_cyrillic_words(self):
        bad = []
        for path in sources():
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for number, line in enumerate(text.splitlines(), 1):
                for match in MIXED_SCRIPT.finditer(line):
                    if line[match.start() - 1 : match.start()] == "\\":
                        continue  # буква escape-последовательности, не слово
                    bad.append(f"{path.relative_to(ROOT)}:{number}: {match.group(0)!r}")
        self.assertEqual(
            bad,
            [],
            "латиница и кириллица слились в одно слово — обычно это опечатка "
            "в русском тексте (или буква l вместо кириллической Л), которую "
            "глаз достраивает и не видит",
        )

    def test_no_zero_width_characters(self):
        bad = []
        for path in sources():
            for number in _lines_with(path, ZERO_WIDTH):
                bad.append(f"{path.relative_to(ROOT)}:{number}")
        self.assertEqual(
            bad, [], "невидимые zero-width символы ломают поиск по коду и копирование"
        )

    def test_no_trailing_whitespace_in_code(self):
        bad = []
        for path in sources():
            if path.suffix not in {".py", ".ts", ".tsx"}:
                continue
            for number in _lines_with(path, TRAILING_WS):
                bad.append(f"{path.relative_to(ROOT)}:{number}")
        self.assertEqual(bad, [], "хвостовые пробелы дают шум в diff")

    def test_readme_pair_exists(self):
        """Документация двуязычная по договору: английская основная, русская
        вторичной. README.ru.md без README.md — сломанный договор."""
        self.assertTrue((ROOT / "README.md").is_file())
        self.assertTrue((ROOT / "README.ru.md").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
