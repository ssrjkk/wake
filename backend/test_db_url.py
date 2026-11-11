"""Разбор имени базы из строки подключения: по строке таблицы на каждую форму,
которая обходит сравнение «последний отрезок после слэша».

Повод: `testsupport.py` и `scripts/gate.sh` сверяли имя именно так, и на
строках вида `.../wake_test?sslmode=require`, `.../wake/` и `...@host/` это
не имя базы, а хвост строки. Первая форма — обычный вид строки от managed
Postgres, последние две — путь к базе `wake`, то есть к продакшну.
"""

import unittest

from db_url import database_name

MEASURED = (
    # (строка подключения, имя, которое откроет драйвер)
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test", "wake_test"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_migrate", "wake_migrate"),
    # Так отдают строку Railway, Supabase и Neon: параметр приклеен к имени.
    (
        "postgresql+asyncpg://wake:wake@localhost:5432/wake_test?sslmode=require",
        "wake_test",
    ),
    ("postgresql://dbuser:pw@example.host:5432/wake?sslmode=require", "wake"),
    # Парамет не один: разбивает всё, что стоит после первого `?`.
    (
        "postgresql+asyncpg://u:p@h.example:5432/wake_test?ssl=require&opt=1",
        "wake_test",
    ),
    # Якорь — не часть адреса.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake#frag", "wake"),
    # Хвостовые слэши.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test/", "wake_test"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test//", "wake_test"),
    # Пути нет вовсе — asyncpg откроет базу с именем пользователя.
    ("postgresql+asyncpg://wake:wake@localhost:5432/", "wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432", "wake"),
    ("postgresql+asyncpg://tester:pw@localhost:5432/", "tester"),
    # Хост, кончающийся на `_test`, именем базы не становится: старый разбор
    # видел в этой строке «host_test» и пропускал проверку суффикса, тогда как
    # драйвер открывал там базу пользователя.
    ("postgresql://u:p@replica_host_test:5432/", "u"),
    # IPv6-литерал: скобки относятся к хосту, а не к имени базы.
    ("postgresql+asyncpg://wake:wake@[::1]:5432/wake_test", "wake_test"),
    # Схемы без драйвера разбираются так же — config переписывает их до
    # подключения, а запрет имени работает на строке оператора.
    ("postgres://wake:wake@localhost:5432/wake", "wake"),
    # Ни пути, ни пользователя: имени базы в строке нет, и пустая строка не
    # должна читаться как «подходит».
    ("postgresql+asyncpg://localhost:5432/", ""),
)


def _naive_tail(url: str) -> str:
    """Как разбирали имя до замера: последний отрезок после слэша."""
    return url.rstrip("/").split("/")[-1]


class TestDatabaseName(unittest.TestCase):
    def test_measured_forms(self):
        for url, name in MEASURED:
            with self.subTest(url=url):
                self.assertEqual(database_name(url), name)

    def test_table_actually_separates_the_two_parsings(self):
        """Таблица сводится не к одной форме: иначе набор ничего не различает.

        Различаются именно те написания, где «последний отрезок после слэша» —
        не имя базы, а хвост строки.
        """
        differs = [url for url, name in MEASURED if _naive_tail(url) != name]
        self.assertGreaterEqual(
            len(differs),
            6,
            f"формы таблицы перестали расходиться со старым разбором: {differs}",
        )

    def test_empty_name_is_distinguishable_from_a_real_one(self):
        """Пустая строка возвращается пустой, а не «wake» и не именем хоста."""
        self.assertEqual(database_name("postgresql+asyncpg://localhost:5432/"), "")
        self.assertFalse(database_name("postgresql+asyncpg://localhost:5432"))
