"""Реестр токенов темы: `:root` против того, кто их на самом деле читает.

Запуск: python -m unittest test_theme_registry -v

Повод. В `:root` лежало 59 объявлений, а читались 43. Остальные шестнадцать —
блок «Старые имена» (`--bg-primary`, `--border-subtle`, `--orange`, `--blue`…) и
`--green` с `--red`, повторявшие литералами уже объявленные `--up` и `--down`.
Ни один файл их не вызывал. Такой набор опасен не длиной: правка `--green` не
меняла ничего, а `--up` и `--green` разошлись бы в тот день, когда кто-то
решил бы, что «зелёный в проекте один». Это тот же класс, что и переменная
окружения, которую никто не читает, — только здесь цена ошибки видна на экране.

Второй дырой был сам гейт темы: `src/components/theme.gate.test.ts` держит
зеркало `:root` руками, и ничего не сверяло его с темой. Дверь односторонняя:
новый цвет без зеркала гейт не пропустит как литерал, а вот `var(--новый-токен)`
пройдёт и в матрицу контраста не попадёт — проверка «каждый текст читается на
каждой поверхности» перестанет видеть ровно тот токен, который добавили.

Отсюда пять проверок, и все выводятся из дерева:

  1. в `:root` нет объявления, которое никто не читает;
  2. нет вызова `var(--x)`, которому нечего разрешаться;
  3. у opaque-цветов в теме нет двух имён на одно значение;
  4. зеркало гейта совпадает с `:root` по именам и значениям;
  5. списки самой матрицы контраста (`PANELS`, `FS_TOKENS`, `TEXTS`, `TINTED`)
     называют те токены, которые есть в теме, а не те, что остались от
     прошлой правки.

Пункт 2 требует честного списка источников значения: тема знает не только `x:
...` в CSS. `--w` пишет инлайн-стиль терминала, `--tg-safe-*` — обвязка мини-
аппа через `setProperty`, причём именем из шаблона. Все четыре способа
объявления находятся сканированием, а не списком в этом файле: список руками
устарел бы ровно так же, как устарели шестнадцать алиасов.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "src" / "index.css"
THEME_GATE = ROOT / "src" / "components" / "theme.gate.test.ts"

COMMENT = re.compile(r"/\*.*?\*/", re.S)
DECLARATION = re.compile(r"(--[a-z0-9-]+)\s*:\s*([^;{}]+);")
USE = re.compile(r"var\((--[a-z0-9-]+)")
INLINE_CUSTOM = re.compile(r"""["'](--[a-z0-9-]+)["']\s*:""")
SET_LITERAL = re.compile(r"""setProperty\(\s*["'](--[a-z0-9-]+)["']""")
SET_TEMPLATE = re.compile(r"setProperty\(\s*`(--[a-z0-9-]*?)\$\{")
HEX = re.compile(r"^#[0-9a-fA-F]{3,8}$")
RGBA = re.compile(r"^rgba?\(")
NAME_LIST = r"const %s\s*(?::[^=]+)?=\s*\[(.*?)\]"
QUOTED_NAME = re.compile(r"""["'](--[a-z0-9-]+)["']""")
TINTED_PAIR = re.compile(
    r"""\[\s*["'](--[a-z0-9-]+)["']\s*,\s*["'](--[a-z0-9-]+)["']\s*\]"""
)


def _strip_comments(text: str) -> str:
    """Комментарии темы объясняют числа и называют токены словами — без
    отсечения они читались бы и как объявления, и как вызовы."""
    return COMMENT.sub("", text)


def _root_blocks(text: str) -> list:
    """Тело каждого блока `:root { … }`, включая вложенные в медиа-запросы."""
    out = []
    for match in re.finditer(r":root\s*\{", text):
        open_at = text.index("{", match.start())
        depth = 0
        for index in range(open_at, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    out.append(text[open_at + 1 : index])
                    break
    return out


def _shipped_text() -> str:
    """Код фронта без тестов: гейт темы и пробы читают токены как текст своих
    регулярных выражений, и учитывать их значило бы найти использования,
    которых в приложении нет."""
    files = [
        path
        for path in sorted((ROOT / "src").rglob("*.ts*"))
        if path.is_file() and ".test." not in path.name
    ]
    files.append(ROOT / "index.html")
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


class TokenRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.css = _strip_comments(CSS.read_text(encoding="utf-8"))
        cls.code = _shipped_text()
        cls.gate = THEME_GATE.read_text(encoding="utf-8")
        cls.root = {}
        for block in _root_blocks(cls.css):
            for name, value in DECLARATION.findall(block):
                cls.root.setdefault(name, value.strip())
        cls.declared_css = set(re.findall(r"^\s*(--[a-z0-9-]+)\s*:", cls.css, re.M))
        cls.families = SET_TEMPLATE.findall(cls.code)
        cls.declared_code = set(INLINE_CUSTOM.findall(cls.code)) | set(
            SET_LITERAL.findall(cls.code)
        )
        cls.used = set(USE.findall(cls.css)) | set(USE.findall(cls.code))

    def _is_declared(self, name: str) -> bool:
        return (
            name in self.declared_css
            or name in self.declared_code
            or any(name.startswith(family) for family in self.families)
        )


class TestRegistryIsReal(TokenRegistry):
    def test_registry_parsed_not_guessed(self):
        """Пустой разбор сделал бы все проверки зелёными навсегда."""
        self.assertGreaterEqual(
            len(self.root),
            40,
            f"из :root вычитано {len(self.root)} объявлений — разбор сломался",
        )
        for name in ("--bg-1", "--fg", "--fs-data", "--line", "--text-muted"):
            self.assertIn(name, self.root, f"токена {name} нет в разобранном реестре")
        self.assertGreaterEqual(
            len(self.used),
            40,
            "вызовов var() найдено меньше сорока — сканер кода не видит фронт",
        )

    def test_value_come_from_the_theme_not_from_this_file(self):
        """Значения читаются из CSS, а не переписываются здесь: иначе проверка
        зеркала сравнивала бы файл сам с собой."""
        self.assertEqual(self.root["--bg-1"], "#101011")
        self.assertEqual(self.root["--fg-3"], "#8f8f97")
        self.assertTrue(HEX.match(self.root["--accent"]))


class TestDeadAndUndeclared(TokenRegistry):
    def test_no_token_is_declared_and_read_by_nobody(self):
        dead = sorted(name for name in self.root if name not in self.used)
        self.assertEqual(
            dead,
            [],
            "токен объявлен и не вызывается ни из CSS, ни из кода — это второе "
            "имя, которое никто не правит, и первое, что разъезжается",
        )

    def test_every_read_token_has_a_declaration(self):
        undeclared = sorted(name for name in self.used if not self._is_declared(name))
        self.assertEqual(
            undeclared,
            [],
            "var() над необъявленным токеном разрешается в пустоту: объявление "
            "считается невалидным в момент вычисления, и свойство уезжает в "
            "наследуемое значение, а не в «серое по умолчанию»",
        )

    def test_custom_properties_written_from_code_are_read(self):
        """Обратная сторона для инлайн-стилей: код пишет `--x`, а читает его
        только CSS. Забыть правило в index.css — молча несуществующий элемент."""
        unread = sorted(name for name in self.declared_code if name not in self.used)
        self.assertEqual(
            unread,
            [],
            "код записывает кастомное свойство, которое никто не вызывает",
        )

    def test_the_dynamic_families_are_the_ones_the_code_uses(self):
        """Шаблоны `setProperty(`--…${…}`)` — единственный случай, где имя
        нельзя собрать целиком; семейство перечислено, чтобы правка имени в
        обвязке мини-аппа не осталась невидимой."""
        self.assertEqual(self.families, ["--tg-safe-"])
        for name in ("--tg-safe-top", "--tg-safe-bottom"):
            self.assertIn(name, self.used, f"{name} больше не вызывается из темы")


class TestColorGovernance(TokenRegistry):
    def _colors(self, pattern):
        return {
            name: value.lower()
            for name, value in self.root.items()
            if pattern.match(value)
        }

    def test_no_two_names_for_the_same_color(self):
        opaque = self._colors(HEX)
        by_value = {}
        for name, value in opaque.items():
            by_value.setdefault(value, []).append(name)
        dupes = {
            value: sorted(names) for value, names in by_value.items() if len(names) > 1
        }
        self.assertEqual(
            dupes,
            {},
            "один цвет под двумя именами: правка одного не тронет другое, и в "
            "тот день, когда «зелёный в проекте один» решит поменяться, "
            "разъедутся оба",
        )

    def test_gate_mirror_lists_exactly_the_theme_colors(self):
        text = THEME_GATE.read_text(encoding="utf-8")
        block = re.search(
            r"TOKEN_VALUES: Record<string, string> = \{(.*?)\n\}", text, re.S
        )
        self.assertIsNotNone(block, "в гейте темы не найден TOKEN_VALUES")
        mirrored = {
            name.lower(): value.lower()
            for name, value in re.findall(
                r'["\'](--[a-z0-9-]+)["\']\s*:\s*["\']([^"\']+)["\']', block.group(1)
            )
        }
        opaque = self._colors(HEX)
        self.assertEqual(
            sorted(mirrored),
            sorted(opaque),
            "зеркало :root разошлось с самой темой: матрица контраста гейта "
            "не видит добавленный цвет или считает убранное",
        )
        mismatched = [
            f"{name}: гейт {mirrored[name]}, тема {opaque[name]}"
            for name in mirrored
            if opaque.get(name) != mirrored[name]
        ]
        self.assertEqual(mismatched, [], "зеркало и тема разошлись по значениям")

    def test_gate_tints_exist_in_the_theme(self):
        text = THEME_GATE.read_text(encoding="utf-8")
        block = re.search(
            r"TINT_VALUES: Record<string, string> = \{(.*?)\n\}", text, re.S
        )
        self.assertIsNotNone(block, "в гейте темы не найден TINT_VALUES")
        tints = {
            name.lower(): value.lower()
            for name, value in re.findall(
                r'["\'](--[a-z0-9-]+)["\']\s*:\s*["\']([^"\']+)["\']', block.group(1)
            )
        }
        translucent = self._colors(RGBA)
        self.assertTrue(tints, "список подложек в гейте пуст — проверять нечего")
        for name, value in tints.items():
            self.assertIn(name, translucent, f"{name} в зеркале, но не в теме")
            self.assertEqual(
                translucent[name],
                value,
                f"{name}: зеркало и тема разошлись по значению подложки",
            )


class TestGateListsAreThemeLists(TokenRegistry):
    """Списки самого гейта — тоже зеркало, и оно обязано совпадать с темой.

    `PANELS`, `TEXTS`, `FILLS`, `TINTED` и `FS_TOKENS` перечисляют токены
    руками. Vitest следит за тем, чтобы панели не печатали то, чего нет в этих
    списках, но не видит обратного: список, переживший удаление токена, тихо
    считает контраст по `undefined`, а `(NaN + 0.05) / (NaN + 0.05)` не меньше
    порога — он просто не равен числу, и проверка «weak пусто» остаётся зелёной.
    """

    def _gate_names(self, decl: str) -> list:
        block = re.search(NAME_LIST % decl, self.gate, re.S)
        self.assertIsNotNone(block, f"в гейте не найден список {decl}")
        return QUOTED_NAME.findall(block.group(1))

    def test_surfaces_are_exactly_the_theme_backgrounds(self):
        surfaces = sorted(self._gate_names("PANELS"))
        theme = sorted(
            name for name, value in self.root.items() if name.startswith("--bg-")
        )
        self.assertEqual(
            surfaces,
            theme,
            "матрица контраста считает не все поверхности панели: у нового "
            "background-токена нет ни строки в проверке, ни порога",
        )

    def test_scale_list_names_exactly_the_theme_scale(self):
        scale = sorted(self._gate_names("FS_TOKENS"))
        theme = sorted(
            name
            for name, value in self.root.items()
            if name.startswith("--fs-") and not name.startswith("--fs-legacy")
        )
        self.assertEqual(
            scale,
            theme,
            "шкала текста в гейте и в теме разошлась: удвоение `--fs-*` в e2e "
            "не тронет токен, которого в списке нет",
        )

    def test_every_token_the_contrast_matrix_names_exists_in_the_theme(self):
        named = set(self._gate_names("TEXTS")) | set(self._gate_names("FILLS"))
        for text_token, tint in TINTED_PAIR.findall(self.gate):
            named.add(text_token)
            named.add(tint)
        missing = sorted(name for name in named if name not in self.root)
        self.assertEqual(
            missing,
            [],
            "матрица контраста обращается к токену, которого в теме больше нет",
        )

    def test_tinted_pairs_use_a_tint_not_an_opaque_fill(self):
        """Подложка обязана быть прозрачной: `over()` умеет смешивать с панелью
        только rgba, а hex в этой паре означал бы, что «контраст на подложке»
        молча превратился в контраст на другой поверхности."""
        opaque = []
        for _text, tint in TINTED_PAIR.findall(self.gate):
            value = self.root.get(tint)
            if value is not None and HEX.match(value):
                opaque.append(f"{tint}={value}")
        self.assertEqual(opaque, [], "в паре «текст на подложке» подложка непрозрачна")


if __name__ == "__main__":
    unittest.main(verbosity=2)
