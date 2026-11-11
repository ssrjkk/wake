"""Разбор имени базы из строки подключения: по строке таблицы на каждую форму,
которая обходит сравнение «последний отрезок после слэша».

Повод: `testsupport.py` и `scripts/gate.sh` сверяли имя именно так, и на
строках вида `.../wake_test?sslmode=require`, `.../wake/` и `...@host/` это
не имя базы, а хвост строки. Первая форма — обычный вид строки от managed
Postgres, последние две — путь к базе `wake`, то есть к продакшну.

Значения в таблице — не рассуждение о том, «как вообще-то парсят URL», а срез
с того же диалекта, которым приложение открывается: `TestDriverIsTheOwner`
прогоняет каждую строку через `create_connect_args`. Расхождение между «как мы
читаем имя» и «какую базу реально открывают» — дыра в запрете продакшна, а не
косметика, и заметит её тест, а не прогон alembic.
"""

import unittest

from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
from sqlalchemy.engine.url import make_url

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
    # Якорь диалект от имени не отделяет: режет он строку только по первому `?`.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake#frag", "wake#frag"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake?a=1#frag", "wake"),
    # Хвостовые слэши: снимается один ведущий, остальные остаются в имени.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test/", "wake_test/"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test//", "wake_test//"),
    ("postgresql+asyncpg://wake:wake@localhost:5432//wake_test", "/wake_test"),
    # Второй сегмент пути — не схема и не каталог: он часть имени базы.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake/x_test", "wake/x_test"),
    # Пути нет вовсе — asyncpg откроет базу с именем пользователя.
    ("postgresql+asyncpg://wake:wake@localhost:5432/", "wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432", "wake"),
    ("postgresql+asyncpg://tester:pw@localhost:5432/", "tester"),
    # Хост, кончающийся на `_test`, именем базы не становится: наивный «последний
    # отрезок после слэша» выдаёт здесь `u:p@replica_host_test:5432`, то есть
    # userinfo вместе с портом, а драйвер открывает базу пользователя `u`. Без
    # порта в наивном разборе появлялся бы суффикс `_test` — проверка, которой
    # ничего не было видно в самой строке подключения.
    ("postgresql://u:p@replica_host_test:5432/", "u"),
    # IPv6-литерал: скобки относятся к хосту, а не к имени базы.
    ("postgresql+asyncpg://wake:wake@[::1]:5432/wake_test", "wake_test"),
    # Схемы без драйвера разбираются так же — config переписывает их до
    # подключения, а запрет имени работает на строке оператора.
    ("postgres://wake:wake@localhost:5432/wake", "wake"),
    # Password с кодированным `@`: userinfo кончается последним `@`.
    ("postgresql+asyncpg://u:p%40x@localhost:5432/", "u"),
    # Percent-форма — часть имени: драйвер раскодирует её до того, как открыть
    # базу, поэтому `/%77ake` и `%77ake` в userinfo — это база `wake`, а сверка
    # текста как есть читала из них строку «не про продакшн».
    ("postgresql+asyncpg://wake:wake@localhost:5432/%77ake", "wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/%77%61%6B%65", "wake"),
    ("postgresql+asyncpg://%77ake:pw@localhost:5432/", "wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%5Ftest", "wake_test"),
    # `%2F` раскодируется внутри уже взятого имени и не начинает новый путь.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%2Fx_test", "wake/x_test"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/%2Fwake", "/wake"),
    # Написание, которое раскодировать нельзя, остаётся как есть.
    ("postgresql+asyncpg://wake:wake@localhost:5432/%ZZwake", "%ZZwake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%", "wake%"),
    # Ни пути, ни пользователя: имени базы в строке нет, и пустая строка не
    # должна читаться как «подходит».
    ("postgresql+asyncpg://localhost:5432/", ""),
)


def _naive_tail(url: str) -> str:
    """Как разбирали имя до замера: последний отрезок после слэша."""
    return url.rstrip("/").split("/")[-1]


def _driver_name(url: str) -> str:
    """Имя, которое диалект отдаст драйверу; пустой путь — имя пользователя."""
    _, params = PGDialect_asyncpg().create_connect_args(make_url(url))
    return params.get("database") or params.get("user") or ""


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
