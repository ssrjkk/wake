"""Ссылка-источник: одна таблица написаний, две реализации.

Запуск: python3 -m unittest test_url_parity -v

Повод. Правило «это адрес, а не строка, похожая на адрес» было записано три
раз и каждый раз сравнением: `evidence_url` в бэкенде проверялся по схеме
(`urlparse(...).scheme`), подпись источника в боте — по префиксу
(`startswith("https://")`), ссылка в панели ставилась в href вообще без
проверки. У каждой формы был свой молчаливый ответ: `https://t.me@evil.com`
проходил и там, и там, и открывается по нему evil.com; `https://good.com\\nX`
проходил префикс, а разбирался в good.comx; `HTTPS://good.com` префикс терял, и
доказательство резолюции переставало показываться из-за регистра.

Теперь правило живёт в двух mirror-реализациях — `backend/source_url.py` и
`sourceHost` в `src/lib/url.ts` — и проверяется по одной таблице: она лежит в
`src/lib/url.test.ts`, читается отсюда как есть и прогоняется здесь через
Python. Разные языки, разные парсеры (`urlsplit` и WHATWG), один ответ на одну
форму — поэтому сверяется таблица, а не код: вторую копию правила на другой
язык этот тест не пишет и не терпит, когда реализации расходятся.

Расхождение, которого не было в первом наброске правила, — сам вывод парсера.
`urlsplit` отдаёт хост буквально, а WHATWG ведёт его по IPv4-ветке, если
последняя метка начинается с цифры: `https://0xA9.254.169.254` открывает
169.254.169.254, `https://1` — 0.0.0.1, `https://good.%63om` раскодируется в
`good.com`, а пустой userinfo (`https://@good.com`) у `urlsplit` — это строка,
а не отсутствие поля. Имя берут из написания, и из числовых форм оставляют
только канонический dotted-quad. На батарее из 125 форм (замер — Node 24 и
Python 3.12; она живёт отдельно от таблицы, чтобы правку правила нельзя было
подогнать под неё) прежние реализации расходились на 43 формах, нынешние — ни
на одной, и ни одна из 14 принятых строк таблицы не открывается другим именем.
Там же, в `src/lib/url.test.ts`, стоит и проверка самого обещания: для каждой
принятой строки таблицы `new URL(...).hostname` обязан быть тем самым именем,
которое показывается под ссылкой.

Отдельно закреплено, что таблица различает правило и догадку: зеркало прежнего
префиксного гейта (`_prefix_rule`) обязано расходиться с ней на конкретных
строках. Таблица, на которой префикс и разбор дают один ответ, ничего не
проверяет. И тем же гейтом проверяется, что потребители правда вызывают
правило, а не держат при себе старый сравнительный кусок.
"""

import re
import unittest
from pathlib import Path

from source_url import source_host

ROOT = Path(__file__).resolve().parent.parent
TS_TEST = ROOT / "src" / "lib" / "url.test.ts"
TS_RULE = ROOT / "src" / "lib" / "url.ts"
PY_RULE = ROOT / "backend" / "source_url.py"
BOT = ROOT / "backend" / "telegram_bot.py"
RESOLUTION = ROOT / "backend" / "predict_resolution.py"
PANEL = ROOT / "src" / "components" / "Predict.tsx"

# Строка таблицы пишется в одну линию и в одном порядке ключей (url, any,
# https) — это формат, а не стиль: regex ниже разбирает именно его.
SOURCE_ROW = re.compile(
    r'\{\s*url:\s*"(?P<url>[^"]*)",\s*any:\s*(?:"(?P<any>[^"]*)"|null),'
    r'\s*https:\s*(?:"(?P<https>[^"]*)"|null)\s*\}'
)


def _rows() -> list:
    """Разбор таблицы из TS-файла. Пустой результат — это не «тест пройден», а
    сломанный формат: молча сверять нечего было бы нельзя."""
    text = TS_TEST.read_text(encoding="utf-8")
    found = []
    for match in SOURCE_ROW.finditer(text):
        url = match.group("url")
        if "\\" in url:
            raise AssertionError(
                f"форма {url!r} написана с escape-последовательностью — Python читает "
                "таблицу как есть и заменил бы её другой строкой"
            )
        found.append(
            {
                "url": url,
                "any": match.group("any"),
                "https": match.group("https"),
            }
        )
    if not found:
        raise AssertionError(
            f"в {TS_TEST.name} не найдено ни одной строки таблицы — формат изменился, "
            "а сверка с ним здесь нет"
        )
    return found


def _prefix_rule(text: object) -> bool:
    """Зеркало прежнего гейта бота: `str(url or "").strip().startswith("https://")`.

    Ровно одна строка — иначе «прежняя реализация» стала бы второй копией
    нынешней и расхождение перестало бы быть измеримым.
    """
    return str(text or "").strip().startswith("https://")


class TestSourceTableIsReadable(unittest.TestCase):
    def setUp(self):
        self.rows = _rows()

    def test_table_is_big_enough_to_be_a_check(self):
        self.assertGreaterEqual(len(self.rows), 30, str(len(self.rows)))

    def test_table_has_forms_on_both_sides_of_the_rule(self):
        accepted = [r for r in self.rows if r["any"] is not None]
        rejected = [r for r in self.rows if r["any"] is None]
        # Отказ отказу рознь: одна форма — не адрес вовсе, другая — адрес, но
        # не https. Если одна из групп усохнет, правка соответствующей ветки
        # правила пройдёт незамеченной.
        self.assertGreaterEqual(len(accepted), 8)
        self.assertGreaterEqual(len(rejected), 20)
        https_only = [
            r for r in self.rows if r["any"] is not None and r["https"] is None
        ]
        self.assertGreaterEqual(
            len(https_only), 2, "разница записи и показана в двух строках"
        )

    def test_https_column_never_widens_the_record_column(self):
        wider = [
            r["url"]
            for r in self.rows
            if r["https"] is not None and r["https"] != r["any"]
        ]
        self.assertEqual(wider, [])


class TestBackendAnswersTheTable(unittest.TestCase):
    def setUp(self):
        self.rows = _rows()

    def test_backend_answers_the_table(self):
        for row in self.rows:
            with self.subTest(url=row["url"]):
                # Пустая строка у Python и null у TS — один и тот же отказ.
                self.assertEqual(source_host(row["url"]), row["any"] or "")
                self.assertEqual(
                    source_host(row["url"], https_only=True), row["https"] or ""
                )

    def test_table_distinguishes_the_rule_from_the_prefix(self):
        """Строки, на которых прежний префиксный гейт отвечает иначе, чем
        правило, — измеримая часть таблицы. Числа закреплены: новая строка,
        которая ничего не различает, в таблицу попасть может, а её вклад — ноль,
        и незаметно, что проверка выродилась."""
        too_kind = [
            r["url"] for r in self.rows if _prefix_rule(r["url"]) and not r["https"]
        ]
        too_strict = [
            r["url"] for r in self.rows if not _prefix_rule(r["url"]) and r["https"]
        ]
        # MEASURED по текущей таблице: столько её форм префикс считал ссылкой.
        self.assertEqual(len(too_kind), 37, str(too_kind))
        self.assertEqual(too_strict, ["HTTPS://Wake.Example.COM"])
        for form in (
            "https://t.me@evil.com/invite",
            "https://good.com:443x",
            "https://",
            "https://good.com x",
            # Класс, которого в прежней таблице не было: префикс принимает их
            # как https, а открывается по ним не то, что написано.
            "https://0x7f000001",
            "https://@good.com",
            "https://good.%63om",
        ):
            self.assertIn(form, too_kind, form)

    def test_the_two_parsers_agree_on_the_forms_urlsplit_invents(self):
        """Формы, которые Python читает иначе, чем WHATWG, и потому не стоят в
        общей таблице: `\\n` внутри адреса WHATWG вырезает (хост good.comx), а
        управляющий bidir-символ в исходнике TS быть не должен. Обе ветки
        должны отвечать отказом и здесь."""
        for form in (
            "https://good.com\nX",
            "https://good.com\r\nX",
            "https://good.com\u200e.evil.com",
        ):
            with self.subTest(form=repr(form)):
                self.assertEqual(source_host(form), "")
                self.assertEqual(source_host(form, https_only=True), "")


class TestConsumersCallTheRule(unittest.TestCase):
    """Правило в модуле ещё не значит, что его спрашивают: панель могла остаться
    при своём href, а бот — при своём префиксе, и расхождение не показали бы
    ничьи тесты. Поэтому проверяется исходник потребителя."""

    def test_backend_consumers_import_the_rule(self):
        for path in (BOT, RESOLUTION):
            with self.subTest(path=path.name):
                self.assertIn(
                    "from source_url import source_host", path.read_text("utf-8")
                )

    def test_no_https_prefix_compare_survives_in_code(self):
        code = re.compile(r"^\s*(?:if|return|elif)\b.*startswith\([\"']https?://")
        for path in (BOT, RESOLUTION):
            hits = [
                line
                for line in path.read_text("utf-8").splitlines()
                if code.match(line)
            ]
            with self.subTest(path=path.name):
                self.assertEqual(hits, [])

    def test_the_panel_links_the_parsed_url_not_the_raw_field(self):
        source = PANEL.read_text(encoding="utf-8")
        self.assertIn('from "../lib/url"', source)
        self.assertIn("sourceHost(", source)
        self.assertNotIn("href={m.evidence_url}", source)

    def test_the_rule_is_owned_by_two_files(self):
        """Владелец правила — пара зеркальных модулей. Если в панели или в боте
        заведётся свой разбор (`new URL(` / `urlsplit(` вне этих двух файлов),
        расхождение вернётся, и таблица его не увидит."""
        for path, needle in ((TS_RULE, "new URL("), (PY_RULE, "urlsplit(")):
            with self.subTest(path=path.name):
                self.assertIn(needle, path.read_text("utf-8"))
        for path in (BOT, RESOLUTION, PANEL):
            with self.subTest(path=path.name):
                self.assertNotIn("urlsplit(", path.read_text("utf-8"))
                self.assertNotIn("new URL(", path.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
