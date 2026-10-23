"""
Гигиена исходников проекта — то, что нельзя проверить типами и что уже случалось
здесь руками.

python3 -m unittest test_hygiene -v

Зачем это тест, а не правило в голове: в русскоязычные докстринги и комментарии
этого проекта несколько раз попадали иероглифы азиатских письменностей — вместо
русского слова вставлялось китайское или японское, и глаз это не видит, потому
что читает кириллицу по контексту. Такое уже ловилось трижды за один заход
(«осталось», «такой», «самой»), поэтому защита не в внимательности, а в
конвейере: падающая проверка дешевле, чем правка постфактум.

Сами примеры иероглифов здесь не приводятся нарочно — файл, который ловит
такое, не может сам содержать это же.
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
