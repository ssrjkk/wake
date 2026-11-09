"""Цепочка миграций: то, что живая база показывает только поломкой.

python3 -m unittest test_migrations -v

CI уже прогоняет `alembic upgrade head` и `alembic check` — они ловят дрейф
схемы против моделей. Свойства самой цепочки ими не проверяются, потому что
цепочка ломает вход в эти шаги, и по логу тогда не понять, что произошло:

* Идентификатор длиннее ширины `alembic_version.version_num` проходит
  `alembic history` и не проходит INSERT: `upgrade head` применит миграции до
  него, упадёт на его собственной записи и оставит базу на полумиграции.
* Голова не одна — `upgrade head` отказывается выбирать между ветками. Отдельно
  от этого две миграции могут объявлять один идентификатор: alembic отвечает
  «Revision … is present more than once», одну из них не применяет никогда, и
  по двум гологам в логе это не отличить от честного ветвления.
* Шапка файла и объявления `revision` / `down_revision` расходятся: первую
  читают глазами при ревью цепочки, вторые читает alembic.

Ширину колонки гейт берёт не из литерала, а из самого alembic: таблица версий
— его конструкция, и при смене alembic проверка должна начать мерить новое
значение, а не спорить со старым. Ни базы, ни сети здесь не нужно: читается
реестр миграций.
"""

import re
import unittest
import warnings
from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

BACKEND = Path(__file__).resolve().parent
VERSIONS = BACKEND / "alembic" / "versions"

# Продакшн ездит на PostgreSQL через asyncpg, и версия пишется в ту же базу, из
# которой читается, поэтому диалект здесь не декорация, а тот же путь.
_DIALECT = "postgresql"

NUM_PREFIX = re.compile(r"^(\d+)_")
REVISION_DECL = re.compile(
    r'^revision(?::\s*[^=]+)?\s*=\s*["\']([^"\']+)["\']', re.MULTILINE
)


def _config() -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    return cfg


def _script_directory() -> ScriptDirectory:
    return ScriptDirectory.from_config(_config())


def _chain() -> list:
    """Миграции от головы к основанию — тот же обход, что делает `upgrade head`."""
    return list(_script_directory().walk_revisions())


def _version_num_width() -> int:
    mc = MigrationContext.configure(dialect_name=_DIALECT)
    return mc._version.c.version_num.type.length


class TestMigrationChain(unittest.TestCase):
    def test_registry_loads_without_deprecated_config(self):
        """Без `path_separator` alembic режет `prepend_sys_path` по пробелам,
        запятым и двоеточиям и печатает DeprecationWarning. Предупреждение
        молчит ровно до того дня, когда разбор станет ошибкой, а путь с
        двоеточием — это любой абсолютный windows-путь."""
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            _script_directory()
        noisy = [
            str(item.message)
            for item in caught
            if "path_separator" in str(item.message)
            or "prepend_sys_path" in str(item.message)
        ]
        self.assertEqual(noisy, [])

    def test_version_column_width_is_measured_not_assumed(self):
        """Нижняя проверка держится за это число, поэтому оно проверяется здесь
        же: назовёт alembic колонку иначе или изменит ширину — падает этот
        тест, а не молча ослабевает проверка идентификаторов."""
        mc = MigrationContext.configure(dialect_name=_DIALECT)
        self.assertEqual(mc._version.name, "alembic_version")
        self.assertLessEqual(_version_num_width(), 64)

    def test_revision_ids_fit_the_version_table(self):
        """Запись в `alembic_version` — последнее, что делает применённая
        миграция: её собственный DDL уже подействовал, поэтому красный прогон
        оставляет базу между двумя схемами, а не до начала работы."""
        width = _version_num_width()
        too_long = [rev.revision for rev in _chain() if len(rev.revision) > width]
        self.assertEqual(
            too_long,
            [],
            f"идентификаторы длиннее {width} символов не влезут в "
            "alembic_version.version_num: "
            + ", ".join(f"{r} ({len(r)})" for r in too_long),
        )

    def test_single_head(self):
        """Пока голов больше одной, `upgrade head` не запускается вообще, и прод
        залипает на предыдущей схеме — доверять здесь «в проде точно одна»
        нельзя, голова появляется из одного файла и обнаруживается при деплое."""
        heads = _script_directory().get_heads()
        self.assertEqual(len(heads), 1, f"голов больше одной: {heads}")

    def test_revision_ids_are_unique(self):
        """Файл, скопированный под новую миграцию с неизменным `revision`,
        не применяется никогда: alembic регистрирует id один раз и на этом
        молчит о том, что чья-та таблица не появится. Обход ScriptDirectory
        этого не видит — он идёт по id, — поэтому читаются сами файлы."""
        declared = {}
        for path in sorted(VERSIONS.glob("*.py")):
            match = REVISION_DECL.search(path.read_text(encoding="utf-8"))
            self.assertIsNotNone(match, f"{path.name}: нет объявления revision")
            declared.setdefault(match.group(1), []).append(path.name)
        clashes = {rid: names for rid, names in declared.items() if len(names) > 1}
        self.assertEqual(
            clashes,
            {},
            "один идентификатор объявлен в нескольких файлах: "
            + "; ".join(f"{rid} -> {names}" for rid, names in clashes.items()),
        )

    def test_header_lines_match_the_declared_fields(self):
        """«Revision ID» и «Revises» в шапке — то, по чему цепочку читают
        руками. Расхождение с `revision` / `down_revision` не мешает alembic и
        уводит ревьюера: правку навесит не туда."""
        for rev in _chain():
            text = Path(rev.module.__file__).read_text(encoding="utf-8")
            declared = re.search(r"^Revision ID: (.+)$", text, re.MULTILINE)
            revises = re.search(r"^Revises: ?(.*)$", text, re.MULTILINE)
            self.assertIsNotNone(declared, rev.module.__file__)
            self.assertEqual(declared.group(1).strip(), rev.revision)
            self.assertIsNotNone(revises, rev.module.__file__)
            self.assertEqual(revises.group(1).strip(), rev.down_revision or "")

    def test_numbering_follows_the_chain_order(self):
        """Префиксы `NNN_` — то, по чему цепочку читают в списке файлов. Если
        они расходятся с порядком применения, соседние миграции выглядят
        перевёрнутыми."""
        prefixes = []
        for rev in reversed(_chain()):
            stem = Path(rev.module.__file__).stem
            match = NUM_PREFIX.match(stem)
            self.assertIsNotNone(match, stem)
            prefixes.append(int(match.group(1)))
        self.assertEqual(
            prefixes, sorted(prefixes), f"нумерация не по порядку: {prefixes}"
        )
        self.assertEqual(
            len(prefixes), len(set(prefixes)), f"повтор префикса: {prefixes}"
        )


if __name__ == "__main__":
    unittest.main()
