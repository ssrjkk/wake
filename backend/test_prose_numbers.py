"""Числа в прозе: строка не имеет права пересказывать то, чем владеет дерево.

Запуск: python -m unittest test_prose_numbers -v

Повод. Один и тот же объём живёт в двух местах — в коде (или в `MEASURED` из
`e2e/fixtures.ts`) и в предложении, которое его объясняет. Расходятся они молча:
правится потолок, комментарий остаётся, и ни один тест об этом не узнает, потому
что комментарию нечего проверять. Так в дереве и появились три разных «активных
перпа» — 211 в комментарии к `MAJOR_PERPS`, 214 в замере 2026-10-24 и 220 в
живом ответе книги, — и пара «18 свечных запросов», кочующая из README в
docstring роута, в комментарий фронта и в хелп бота.

Живая находка этой проверки: `README.md` обещал «18 perp markets, cached 60 s»,
`backend/api/funding.py` — «~200 перпов», `backend/lighter_rest.py` — «211
запросов», а потолок кэша в `backend/cache.py` назывался числом и в коде, и в
его же docstring. Ни одно из этих чисел не следует из строки, которая его
пишет.

Правило, наоборот, узкое и потому честное: проза не пересказывает объём. Она
называет владельца — `MAJOR_PERPS`, `MEASURED.orderBookRows`, срок кэша из
`cache.py` — или оставляет число при дате, которая говорит, когда его мерили.
Датированный замер историчен и врать не может; не датированное число может.

Разбираются только блоки прозы: абзацы markdown вне fenced-блоков, docstring'и
и прогоны строк комментариев в `.py`, `//`-прогоны и `/* */` в `.ts`/`.tsx`.
Строки кода под проверку не попадают намеренно: `getCandles(id, "1h",
CANDLE_COUNT)` — это и есть владелец, а не его пересказ.

Границы правила — тоже измеренные, а не «не дошли руки». Две пробные фразы
оказались дороже пользы и их нет в `OWNERS`: `потолок списка|ceiling` даёт на
дерева два ложняка про дефолты (`README.md` обязан назвать число retention —
это справка пользователя, а не пересказ живого объёма), а `ряд свеч|часовые
свечи` цепляет «24 часовые свечи» — число, которое следует не из кода, а из
суток. Не ловится число, записанное прописью («двести кнопок»): `NUMBER`
читает цифры, потому что расширять его на числительные — значит красить
«один», «два» и «три» в каждом втором предложении. Такие места правит ревью,
а не гейт.

Шесть проверок: проза чиста; синтетическое число с синтетической фразой
ловится, иначе пустой список на дереве ничего не значит; число при дате
пересказом не считается — дата говорит, когда его мерили, а не что оно верно
сегодня; каждая фраза-владелец встречается в дереве и не превратилась в
декорацию; и разбор не ослеп. Ослепление мерится двумя способами, потому что
ловят они разное: полы по пластам дерева (markdown, py, ts, tsx) — это
перемеренное число блоков, а форма каждой прозы проверяется своим образцом,
который обязан дойти до матчера — включая прогоны, перенесённые на новую
строку: там число и фраза сходятся только если прогон склеен в один блок.
"""

import ast
import io
import re
import tokenize
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Число и то, чем оно владеет. Фраза — не значение: значение в прозе запретить
# легче, чем выучить, и именно фраза переживает правку кода.
OWNERS = (
    (
        "MAJOR_PERPS в backend/lighter_rest.py и срок кэша в backend/cache.py",
        re.compile(
            r"свечн\w* запрос\w*|запрос\w* к ?Lighter|запрос\w* на обновление"
            r"|candle requests?|perp markets?|активн\w* перпов|перпов|\bperps\b",
            re.I,
        ),
    ),
    (
        "MEASURED.orderBookRows в e2e/fixtures.ts",
        re.compile(r"стр\w+ (?:живой )?книг\w*|book rows|rows in the book", re.I),
    ),
    (
        "MEASURED.orderBookActive в e2e/fixtures.ts",
        re.compile(r"активн\w+ рынк\w*|active markets?", re.I),
    ),
    (
        "MEASURED.fundingRows в e2e/fixtures.ts",
        re.compile(r"стр\w+ funding|funding rows", re.I),
    ),
    (
        "MEASURED.arcusMarkets в e2e/fixtures.ts",
        re.compile(r"рын\w+ Arcus|Arcus markets?", re.I),
    ),
    (
        "ttl у @cached в backend/lighter_rest.py и DEFAULT_TTL в backend/cache.py",
        re.compile(r"кэш\w*|кеш\w*|кэшир\w*|кешир\w*|cached|cache", re.I),
    ),
)

DATE = re.compile(r"20\d\d-\d\d-\d\d")
NUMBER = re.compile(r"(?<![\w.%$_-])\d+(?: \d{3})*(?:[.,]\d+)?(?![\w%])")
FENCE = re.compile(r"^\s*(?:```|~~~)")

WINDOW = 14
# Дата приписывает число, если стоит не дальше одного предложения. 120 — не
# круглое число, а промежуток между двумя живыми случаями: в `lighter.test.ts`
# от конца «2026-10-24» до «0.000000» 86 символов (это один замер, и он не
# врёт), а в комментарии к `MAJOR_PERPS` от «2026-10-03» до «211» — 142 (дата
# про другое, и число остаётся без хозяина).
ATTRIBUTION = 120

MARKDOWN = (
    "README.md",
    "README.ru.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
)
SKIP = re.compile(
    r"(node_modules|dist|build|__pycache__|\.git|alembic|CHANGELOG|fixtures\.ts)"
)

# Полы по пластам дерева — перемеренное число блоков минус зазор: на этом
# дереве 450 markdown, 1279 py, 386 ts и 142 tsx. Для сравнения, чем
# оборачивалась настоящая поломка разбора: `//`-прогоны не матчились вовсе
# (регексп с `(?<=^)` без re.M) — ts 386→64, tsx 142→34, всего 2257→1827.
# Зазор оставлен такой, чтобы правка прозы на пару десятков блоков пол не
# сдвигала, а пропуск целого пласта — сдвигал. Тонкие случаи (пропал один
# вид комментария при живом другом) ловят не полы, а SHAPES ниже.
FLOORS = {"md": 400, "py": 1100, "ts": 300, "tsx": 100}
FILES_FLOOR = 120


def md_blocks(text: str):
    """Абзацы markdown как (start_line, текст). Пустые строки разрезают,
    fenced-блоки не читаются: там код, а код под этим правилом не спорит с
    деревом."""
    blocks, cur, start, fence = [], [], 0, False
    for no, line in enumerate(text.splitlines(), 1):
        if FENCE.match(line):
            if cur:
                blocks.append((start, "\n".join(cur)))
                cur = []
            fence = not fence
            continue
        if fence or not line.strip():
            if cur:
                blocks.append((start, "\n".join(cur)))
                cur = []
            continue
        if not cur:
            start = no
        cur.append(line.strip())
    if cur:
        blocks.append((start, "\n".join(cur)))
    return blocks


def _runs(items):
    """Соседние по строкам куски в один блок: перенос не прячет число от фразы."""
    blocks, cur, start, prev = [], [], 0, 0
    for lineno, first, last, payload in items:
        if cur and lineno > prev + 1:
            blocks.append((start, "\n".join(cur)))
            cur = []
        if not cur:
            start = lineno
        cur.append(payload)
        prev = last
    if cur:
        blocks.append((start, "\n".join(cur)))
    return blocks


def py_blocks(text: str):
    """docstring'и и прогоны `#`-комментариев. Строки кода — не проза."""
    out = []
    tree = ast.parse(text)
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
        ):
            continue
        body = list(node.body)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            doc = body[0].value.value.strip()
            if doc:
                out.append((body[0].lineno, doc))
    comments = []
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type != tokenize.COMMENT or tok.string.startswith("#!"):
            continue
        comments.append(
            (tok.start[0], tok.end[0], tok.end[0], tok.string.lstrip("#").strip())
        )
    out.extend(_runs(comments))
    return out


LINE_COMMENT = re.compile(r"(?:^|(?<=[\t ]))//(?![/:])[^\n]*", re.M)
BLOCK_COMMENT = re.compile(r"/\*(?:[^*]|\*(?!/))*?\*/", re.S)


def ts_blocks(text: str):
    """`/* */`-блоки и прогоны `//`. Строки кода в прозу не попадают: `//`
    обязан стоять в начале строки или после пробела, а `https://` отсекается
    отрицательным просмотром. Перед поиском построчных комментариев block-
    комментарии вытравлены пробелами, чтобы `//` внутри цитаты в `/* */` не
    породил второй блок на те же строки."""
    out = []
    masked = list(text)
    for m in BLOCK_COMMENT.finditer(text):
        line = text.count("\n", 0, m.start()) + 1
        body = "\n".join(
            part.strip().lstrip("*").strip() for part in m.group(0)[2:-2].splitlines()
        )
        if body.strip():
            out.append((line, body.strip()))
        for i in range(m.start(), m.end()):
            if text[i] != "\n":
                masked[i] = " "
    items = []
    for m in LINE_COMMENT.finditer("".join(masked)):
        line = text.count("\n", 0, m.start()) + 1
        items.append((line, line, line, m.group(0).lstrip("/").strip()))
    out.extend(_runs(items))
    return out


# Каждый вид прозы проходит проверку своим образцом: во всех ловушках
# владетельная фраза стоит рядом с числом, поэтому ослепший на этом виде
# парсер даёт пустый `violations` — и проверка краснеет, хотя на дереве она
# осталась бы зелёной. `NOT_PROSE` — обратная сторона: код под правило не
# попадает намеренно, и если парсер начнёт его читать, ловушка сработает на
# строке, которой это не касается.
SHAPES = (
    ("markdown-абзац", md_blocks, "Обзор стоит 18 свечных запросов на обновление."),
    ("py docstring", py_blocks, '"""Обзор стоит 18 свечных запросов."""\n'),
    ("py #-прогон", py_blocks, "x = 1\n# обзор стоит\n# 18 свечных запросов\n"),
    (
        "ts //-прогон",
        ts_blocks,
        "const a = 1;\n// обзор стоит\n// 18 свечных запросов\n",
    ),
    (
        "ts /* */",
        ts_blocks,
        "const a = 1;\n/* обзор стоит 18 свечных\n   запросов */\n",
    ),
    # Перенос строки не прячет число от фразы: прогон комментариев — один блок.
    # Без `_runs` эти два образца распались бы на «фраза» и «число» отдельно и
    # матчер не увидел бы ничего, а полы по пластам такой поломки не замечают
    # (блоков от неё только больше).
    (
        "py #-прогон через перенос",
        py_blocks,
        "x = 1\n# обзор считает активные рынки книги\n# 225\n",
    ),
    (
        "ts //-прогон через перенос",
        ts_blocks,
        "const a = 1;\n// обзор считает активные рынки книги\n// 225\n",
    ),
)
NOT_PROSE = (
    ("markdown fenced", md_blocks, "```py\na = 18  # свечных запросов\n```\n"),
    ("py строка кода", py_blocks, 'LABEL = "обзор стоит 18 свечных запросов"\n'),
    ("ts URI", ts_blocks, "const u = 'https://example.com/a/200';\n"),
)


def prose_blocks(path: Path):
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".md":
        return md_blocks(text)
    if path.suffix == ".py":
        return py_blocks(text)
    return ts_blocks(text)


def code_files():
    for name in MARKDOWN:
        yield ROOT / name
    for base in ("src", "backend", "e2e"):
        for path in sorted((ROOT / base).rglob("*")):
            if not path.is_file() or SKIP.search(str(path)):
                continue
            if (
                path.suffix in (".ts", ".tsx", ".py")
                and path.name != Path(__file__).name
            ):
                yield path


def violations(blocks):
    """Каждое число, стоящее рядом с фразой-владельцем и не приписанное дате.

    Дата вытравлена из строки поиска, иначе сама дата («2026-10-24») давала бы
    нарушение; в исходной строке она остаётся — ею число и приписано. Число,
    обрезанное краем окна, не считается: «733 funding rows» в окне, начинающемся
    с середины числа, дало бы «3»."""
    found = {}
    for line, block in blocks:
        one = " ".join(part.strip() for part in block.splitlines() if part.strip())
        plain = DATE.sub(lambda m: " " * len(m.group(0)), one)
        marks = [m.end() for m in DATE.finditer(one)]
        for owner, rx in OWNERS:
            for match in rx.finditer(plain):
                lo = max(0, match.start() - WINDOW)
                hi = min(len(plain), match.end() + WINDOW)
                window = plain[lo:hi]
                for num in NUMBER.finditer(window):
                    clipped = (lo > 0 and num.start() == 0) or (
                        hi < len(plain) and num.end() == len(window)
                    )
                    if clipped:
                        continue
                    at = lo + num.start()
                    # Дата рядом — не срезанная пополам подстрока, а конец
                    # записи: иначе «2026-10-24» в 70 символах выше числа не
                    # спасала бы его, а «6-10-24» из окна спасала бы.
                    if any(at - ATTRIBUTION <= end <= at for end in marks):
                        continue
                    found.setdefault(
                        (line, window[num.start() : num.end()]),
                        (
                            owner,
                            line,
                            num.group(0),
                            one[max(0, at - 40) : at + 40].strip(),
                        ),
                    )
    return list(found.values())


class TestProseVolumes(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.files = [p for p in code_files() if p.exists()]
        cls.blocks = {str(p.relative_to(ROOT)): prose_blocks(p) for p in cls.files}
        cls.hits = []
        for rel, blocks in cls.blocks.items():
            for owner, line, num, window in violations(blocks):
                cls.hits.append((rel, owner, line, num, window))

    def test_prose_does_not_restate_a_tree_volume(self):
        """Число рядом с фразой-владельцем — вторая копия первого. Исправление
        не «поменять цифру на актуальную», а назвать владельца или датировать
        замер."""
        self.assertEqual(
            sorted({(rel, line, num) for rel, _o, line, num, _w in self.hits}),
            [],
            "проза пересказывает объём:\n"
            + "\n".join(
                f"  {rel}:{line} «{num}» — {owner}\n     …{window}…"
                for rel, owner, line, num, window in sorted(self.hits)
            ),
        )

    def test_a_planted_number_is_caught(self):
        """Пустой список на дереве ничего не значит, если матчер умеет только
        молчать: ловушка ставится синтетическим текстом на обеих фразах и на
        обеих разметках."""
        planted = [
            "обзор стоит дорого (18 свечных запросов) и не успевает",
            "Market ranking by real quote volume (18 perp markets, cached)",
            "ключ есть у всех 225 активных рынков книги",
            "docs said 733 funding rows while MEASURED held the newer count",
            "в фикстурах значилось 81 рынков Arcus",
        ]
        for text in planted:
            self.assertTrue(
                violations([(1, text)]),
                f"матчер не увидел число во фразе: {text!r}",
            )

    def test_dated_measurement_is_not_a_restatement(self):
        """Замер с датой — история, а не обещание: он не утверждает, что число
        верно сегодня, поэтому дата рядом с цифрой снимает претензию."""
        self.assertEqual(
            violations(
                [(1, "замер 2026-10-24: те же 214 активных перпов в разном порядке")]
            ),
            [],
        )

    def test_owner_phrases_are_not_decorations(self):
        """Каждая фраза-владелец должна звучать в дереве. Фраза, которую
        перестали писать, — мёртвая строка правила, и её убирают из OWNERS
        осознанно, а не оставляют украшать список."""
        joined = "\n".join(
            block for blocks in self.blocks.values() for _l, block in blocks
        )
        for owner, rx in OWNERS:
            self.assertTrue(
                rx.search(joined),
                f"фраза владельца {owner!r} не встречается ни в одном блоке прозы",
            )

    def test_each_prose_shape_reaches_the_matcher(self):
        """Полы по пластам грубы по определению: пропажа одного вида
        комментария при живом другом в них тонет. Поэтому каждый вид прозы
        проверяется образцом отдельно, а `NOT_PROSE` не даёт парсеру начать
        читать код."""
        for name, parse, text in SHAPES:
            blocks = parse(text)
            self.assertTrue(blocks, f"парсер не прочитал форму {name!r}: {text!r}")
            self.assertTrue(
                violations(blocks),
                f"форма {name!r} дошла до матчера без нарушения: {text!r}",
            )
        for name, parse, text in NOT_PROSE:
            self.assertEqual(
                parse(text), [], f"код принят за прозу в форме {name!r}: {text!r}"
            )

    def test_the_gate_is_not_blind(self):
        """Разбор, который ничего не прочитал, сделал бы верхние проверки
        зелёными навсегда. Полы — перемеренная полнота текущего дерева по
        пластиам, а не по памяти автора теста; в сообщении лежит живое число,
        чтобы следующий поднял пол от замера, а не наугад."""
        by_ext = {}
        for rel, blocks in self.blocks.items():
            ext = rel.rsplit(".", 1)[-1]
            by_ext[ext] = by_ext.get(ext, 0) + len(blocks)
        measured = {k: by_ext.get(k, 0) for k in FLOORS}
        self.assertGreaterEqual(
            len(self.files),
            FILES_FLOOR,
            f"сканер не дошёл до части дерева: файлов {len(self.files)}",
        )
        for ext, floor in FLOORS.items():
            self.assertGreaterEqual(
                measured[ext],
                floor,
                f"пласт {ext} разобран не весь: блоков {measured[ext]}, пол {floor}",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
