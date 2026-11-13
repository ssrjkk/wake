"""Контракт по полям: что обещает TypeScript против что лежит в ответе.

Первый контракт (test_api_contract.py) сверяет списки путей: маршрут, который
сайт зовёт, обязан существовать. Здесь — второй уровень: существующий маршрут
обязан вернуть те ключи, которые сайт читает. Расхождение по пути видно сразу
(404), расхождение по ключу не видно никогда: `row.learder_id` — это undefined,
панель рисует пустую строку, и статус-код при этом 200.

Метод: из `src/**` вытаскиваются объявления типов и места, где `backendJson<T>`
прилагает тип к пути, а ответ берётся настоящим HTTP-запросом к приложению на
посеянных данных. Описаний ответов руками в этом файле нет: переписанный в
тесте «эталон» устаревает ровно так же молча, как комментарий в роутере.

Обратная сторона не менее важна: ключ, который бэкенд отдаёт, а фронтенд нигде
его не объявил, — это либо мёртвый груз в каждом ответе, либо поле, которое
должно быть в типе и просто потерялось. Такие ключи перечислены явно и с
мотивировкой (SENT_BUT_UNREAD); молча добавить колонку в SELECT нельзя.

Разбор пути вызова и сопоставление сегментов берутся из test_api_contract.py:
два сканера одного и того же вызова разошлись бы в первый же день, и тогда
«путь есть» и «поля есть» проверяли бы разные вызовы.

Запуск: WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test \\
        python -m unittest test_field_contract -v
"""

import re
import unittest
from pathlib import Path

import testsupport  # задаёт env раньше app и config
import lighter_rest
from test_api_contract import (
    _normalize as ts_pattern,  # служебные имена: тот же разбор вызова, вторая сверка
    _read_literal as read_string,
    matches as path_matches,
)
import test_api_smoke

# Класс-посев берётся по имени, а сидящие рядом тесты — через модуль:
# `from test_api_smoke import TestMarketsOverview` привязал бы чужой класс к
# этому модулю, и unittest/pytest собрали бы его тесты второй раз под другим
# файлом. Два прогона одного теста — это не проверка, а удвоенное время и
# сбитая атрибуция падения.
CopyTradingSeeding = test_api_smoke.CopyTradingSeeding

SRC = Path(__file__).resolve().parent.parent / "src"
CLOSERS = {"}": "{", "]": "[", ")": "(", ">": "<"}


def _skip_space(text: str, i: int) -> int:
    while i < len(text) and text[i] in " \n\r\t":
        i += 1
    return i


def _strip_comments(text: str) -> str:
    """Выражения остаются, комментарии заменяются пробелом.

    Без этого разбор типов зависит от прозы: комментарий над полем
    `open_interest_base` — «в единицах актива, не в $», и запятая в нём
    разрезала объявление так, что поле исчезало из списка. То же с точкой с
    запятой в «без знака; кто платит — funding_payer». Литералы копируются
    целиком, поэтому `//` внутри строки или шаблона комментарием не считается.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char in "\"'`":
            out.append(char)
            i += 1
            while i < n:
                if text[i] == "\\":
                    out.append(text[i : i + 2])
                    i += 2
                    continue
                if text[i] == char:
                    out.append(char)
                    i += 1
                    break
                if char == "`" and text[i : i + 2] == "${":
                    depth = 0
                    while i < n:
                        if text[i] == "{":
                            depth += 1
                        elif text[i] == "}":
                            depth -= 1
                            if depth == 0:
                                out.append(text[i])
                                i += 1
                                break
                        out.append(text[i])
                        i += 1
                    continue
                out.append(text[i])
                i += 1
            continue
        if char == "/" and text[i + 1 : i + 2] == "/":
            while i < n and text[i] != "\n":
                i += 1
            out.append(" ")
            continue
        if char == "/" and text[i + 1 : i + 2] == "*":
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            out.append(" ")
            continue
        out.append(char)
        i += 1
    return "".join(out)


def _read_block(text: str, i: int) -> tuple[str, int]:
    """Содержимое фигурных скобок, начинающихся на позиции i, и индекс после них."""
    if text[i] != "{":
        raise AssertionError(f"ожидался '{{' на {i}, получено {text[i : i + 20]!r}")
    depth = 0
    out: list[str] = []
    j = i
    while j < len(text):
        char = text[j]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return "".join(out), j + 1
        # внешняя пара скобок в содержимое не входит
        if j != i:
            out.append(char)
        j += 1
    raise ValueError(f"несбалансированные скобки в {text[i : i + 60]!r}")


class _Depth:
    """Счётчик вложенности при разборе типов: скобки плюс generic-углы."""

    def __init__(self):
        self.pairs = {"{": 0, "[": 0, "(": 0}
        self.angle = 0

    def at_zero(self):
        return self.angle == 0 and not any(self.pairs.values())

    def track(self, text, j, char):
        if char in self.pairs:
            self.pairs[char] += 1
        elif char in ("}", "]", ")"):
            opener = CLOSERS[char]
            self.pairs[opener] = max(0, self.pairs[opener] - 1)
        elif char == "<":
            # `=>` в function-типе не открывает generic: без этой поправки
            # Record<string, () => void> закрылся бы на стрелке
            if text[j + 1 : j + 2] != "=":
                self.angle += 1
        elif char == ">" and self.angle and text[j - 1 : j] != "=":
            self.angle -= 1


def _split_top(expr: str, seps: tuple) -> list:
    """Части выражения по разделителям верхнего уровня; разделители теряются."""
    depth = _Depth()
    parts: list[str] = []
    current: list[str] = []
    j = 0
    while j < len(expr):
        char = expr[j]
        if depth.at_zero() and expr.startswith(seps, j):
            parts.append("".join(current))
            current = []
            j += len(seps)
            continue
        current.append(char)
        depth.track(expr, j, char)
        j += 1
    parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def _strip_parens(expr: str) -> str:
    """Снять.outer скобки типа, если они скобки именно вокруг всего типа."""
    expr = expr.strip()
    while expr.startswith("("):
        depth = _Depth()
        for j, char in enumerate(expr):
            depth.track(expr, j, char)
            if char == ")" and depth.at_zero() and j == len(expr) - 1:
                expr = expr[1:-1].strip()
                break
        else:
            break
    return expr


class Field:
    """Одно поле объявления: имя, тип-выражение, опциональность, индексная сигнатура."""

    __slots__ = ("name", "type", "optional", "open_ended")

    def __init__(self, name, type_, optional=False, open_ended=False):
        self.name = name
        self.type = type_
        self.optional = optional
        self.open_ended = open_ended


def _parse_fields(body: str) -> list:
    fields: list[Field] = []
    for segment in _split_top(body, (";", ",")):
        segment = segment.strip().rstrip(";").strip()
        if not segment:
            continue
        if segment.startswith("["):  # [key: string]: number
            fields.append(Field("", "", open_ended=True))
            continue
        head = _split_top(segment, (":",))
        if len(head) < 2:
            continue  # сигнатура метода, а не пара «ключ: тип»
        name = head[0].strip()
        type_ = ":".join(head[1:]).strip()
        if name.endswith("?"):
            fields.append(Field(name[:-1], type_, optional=True))
        elif re.fullmatch(r"[A-Za-z_$][\w$]*", name):
            fields.append(Field(name, type_))
    return fields


class Decl:
    __slots__ = ("name", "expr", "fields")

    def __init__(self, name, expr="", fields=None):
        self.name = name
        self.expr = expr
        self.fields = fields or []


DECLS: dict[str, Decl] = {}
CALLS: list[dict] = []
_scanned = False


def _source_files():
    for path in sorted(SRC.rglob("*.ts*")):
        if ".test." in path.name:
            continue
        yield path


def _read_generic(text: str, i: int) -> tuple[str, int]:
    """Аргумент `<...>` после `backendJson` и индекс после закрывающего `>`."""
    depth = 0
    out: list[str] = []
    j = i
    while j < len(text):
        char = text[j]
        arrow = text[j - 1 : j] == "="
        if char == "<" and not arrow:
            depth += 1
        elif char == ">" and not arrow:
            depth -= 1
            if depth == 0:
                return "".join(out).strip(), j + 1
        # сам открывающий `<` в аргумент не входит
        if depth and j != i:
            out.append(char)
        j += 1
    raise ValueError(f"незакрытый generic в {text[i : i + 60]!r}")


def _read_type_expr(text: str, i: int) -> tuple[str, int]:
    """Тип-выражение после `=`: блоки, `&`, `|` — до `;` или конца строки."""
    depth = _Depth()
    out: list[str] = []
    j = i
    while j < len(text):
        char = text[j]
        if depth.at_zero() and char == ";":
            break
        if depth.at_zero() and char == "\n":
            k = _skip_space(text, j + 1)
            if text[k : k + 1] not in ("&", "|"):
                break
        out.append(char)
        depth.track(text, j, char)
        j += 1
    return "".join(out).strip(), j


_DECL_SHAPE = re.compile(
    r"\b(?:export\s+)?(?:declare\s+)?(type|interface)\s+([A-Za-z_$][\w$]*)\s*"
    r"(?:<[^{};]*?>)?\s*(=|\{)"
)


def _scan_declarations(text: str):
    for match in _DECL_SHAPE.finditer(text):
        name, opener = match.group(2), match.group(3)
        i = match.end() - 1
        if opener == "{":
            body, _ = _read_block(text, i)
            DECLS.setdefault(name, Decl(name, fields=_parse_fields(body)))
            continue
        expr, _ = _read_type_expr(text, match.end())
        if expr.startswith("{"):
            DECLS.setdefault(name, Decl(name, expr, _parse_fields(expr[1:-1])))
        else:
            DECLS.setdefault(name, Decl(name, expr))


def _scan_calls(text: str, path: Path):
    for match in re.finditer(r"\bbackendJson\s*<", text):
        generic, i = _read_generic(text, match.end() - 1)
        i = _skip_space(text, i)
        if text[i : i + 1] != "(":
            continue
        i = _skip_space(text, i + 1)
        if text[i : i + 1] not in ('"', "'", "`"):
            # путь в переменной: какой именно — решается на месте, и его ловит
            # сверка списков путей, а не поля
            continue
        raw_path, i = read_string(text, i)
        if not raw_path.startswith("/"):
            continue
        method = "GET"
        comma = _skip_space(text, i)
        if text[comma : comma + 1] == ",":
            arg = _skip_space(text, comma + 1)
            if text[arg : arg + 1] == "{":
                body, _ = _read_block(text, arg)
                found = re.search(r'\bmethod:\s*"([A-Za-z]+)"', body)
                if found:
                    method = found.group(1).upper()
        CALLS.append(
            {
                "file": path.name,
                "generic": generic,
                "path": ts_pattern(raw_path),
                "raw_path": raw_path,
                "method": method,
            }
        )


def scan():
    global _scanned
    if _scanned:
        return
    for path in _source_files():
        text = _strip_comments(path.read_text(encoding="utf-8"))
        _scan_declarations(text)
        _scan_calls(text, path)
    _scanned = True


def element_type(expr: str):
    """Тип элемента для `T[]` / `Array<T>`; None, если выражение не массив."""
    expr = _strip_parens(expr)
    if expr.endswith("[]"):
        return expr[:-2]
    match = re.fullmatch(r"Array<(.+)>", expr, re.S)
    return match.group(1).strip() if match else None


def members(expr: str) -> tuple[list, bool]:
    """(члены объединения без null, бывает ли null)."""
    parts = _split_top(_strip_parens(expr), ("|",))
    real = [part for part in parts if part not in ("null", "undefined", "void")]
    return real, len(real) != len(parts)


def resolve_fields(expr: str, _seen=()) -> list | None:
    """Поля объекта для типа-выражения; None, если это не объект по объявлению."""
    expr = _strip_parens(expr)
    if not expr:
        return None
    inner = element_type(expr)
    if inner is not None:
        return resolve_fields(inner, _seen)
    if expr.startswith("{"):
        return _parse_fields(expr[1:-1])
    parts = _split_top(expr, ("&",))
    if len(parts) > 1:
        merged: list[Field] = []
        for part in parts:
            merged.extend(resolve_fields(part, _seen) or [])
        return merged or None
    name = parts[0].strip()
    if len(_seen) > 12 or name in _seen or name not in DECLS:
        return None
    decl = DECLS[name]
    if decl.fields:
        return decl.fields
    return resolve_fields(decl.expr, _seen + (name,))


def _literal_strings(members_list: list):
    """Значения, если все члены объединения — строковые литералы; иначе None."""
    values = []
    for member in members_list:
        match = re.fullmatch(r'"([^"]*)"|\'([^\']*)\'', member.strip())
        if not match:
            return None
        values.append(match.group(1) if match.group(1) is not None else match.group(2))
    return values


def _strip_indices(where: str) -> str:
    """`open_trades[0]` -> `open_trades[]`: таблица исключений одна на весь массив."""
    return re.sub(r"\[\d+\]", "[]", where)


class Diff:
    """Результат сверки одного ответа: пропущенные, лишние и неверные по форме поля."""

    def __init__(self):
        self.missing = []
        self.unread = []
        self.problems = []
        self.objects = 0

    @staticmethod
    def locator(path, where):
        return f"{path}#{_strip_indices(where)}" if where else path

    def compare(self, payload, expr, path, where):
        self.objects += 1
        fields = resolve_fields(expr)
        if not isinstance(payload, dict):
            self.problems.append(
                f"{self.locator(path, where)}: тип обещает объект, бэкенд прислал "
                f"{type(payload).__name__}"
            )
            return
        declared = {f.name for f in fields if f.name}
        required = {f.name for f in fields if f.name and not f.optional}
        actual = set(payload)
        for name in sorted(required - actual):
            self.missing.append(
                f"{self.locator(path, where)}: {name} — тип читает, ответа нет"
            )
        if not any(f.open_ended for f in fields):
            for name in sorted(actual - declared):
                self.unread.append(f"{self.locator(path, where)}|{name}")
        for field in fields:
            if field.name and field.name in payload:
                self.walk(
                    payload[field.name],
                    field.type,
                    path,
                    f"{where}.{field.name}" if where else field.name,
                )

    def check_value(self, payload, expr, path, where):
        real, nullable = members(expr)
        if payload is None:
            if not nullable and real:
                self.problems.append(
                    f"{self.locator(path, where)}: тип не объявляет null, "
                    "бэкенд прислал null"
                )
            return
        if not real:
            return
        inner = element_type(real[0])
        if inner is not None:
            if not isinstance(payload, list):
                self.problems.append(
                    f"{self.locator(path, where)}: тип обещает массив, бэкенд прислал "
                    f"{type(payload).__name__}"
                )
                return
            for index, item in enumerate(payload):
                self.check_value(item, inner, path, f"{where}[{index}]")
            return
        literals = _literal_strings(real)
        if literals is not None:
            if payload not in literals:
                self.problems.append(
                    f"{self.locator(path, where)}: {payload!r} вне значений, "
                    f"которые объявлены как {sorted(literals)}"
                )
            return
        kind = real[0].strip()
        shape = {
            "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
            "string": lambda v: isinstance(v, str),
            "boolean": lambda v: isinstance(v, bool),
        }.get(kind)
        if shape and not shape(payload):
            self.problems.append(
                f"{self.locator(path, where)}: тип обещает {kind}, "
                f"бэкенд прислал {payload!r}"
            )

    def walk(self, payload, expr, path, where):
        """Массив — поэлементно; объект — сверкой ключей; иначе — формой значения."""
        real, nullable = members(_strip_parens(expr.strip()))
        if payload is None:
            if not nullable and real:
                self.problems.append(
                    f"{self.locator(path, where)}: тип не объявляет null, "
                    "бэкенд прислал null"
                )
            return
        if not real:
            return
        inner = element_type(real[0])
        if inner is not None:
            if not isinstance(payload, list):
                self.problems.append(
                    f"{self.locator(path, where)}: тип обещает массив, бэкенд прислал "
                    f"{type(payload).__name__}"
                )
                return
            for index, item in enumerate(payload):
                self.walk(item, inner, path, f"{where}[{index}]")
            return
        if resolve_fields(real[0]) is not None:
            self.compare(payload, real[0], path, where)
            return
        if len(real) > 1 and any(resolve_fields(part) for part in real):
            return  # объединение объектов: какой именно в ответе — решает содержимое
        self.check_value(payload, expr, path, where)


def typed_calls(method: str):
    """(путь, тип-аргумент) для каждого типизированного вызова фронта данным
    методом.

    Отдельно от GET-вида это не косметика: фронт начал читать ответ
    `POST /subscription/trial` как данные, а не как «главное, что запрос дошёл»,
    и сверять поля такого ответа невозможно, пока у `check` есть только
    GET-список."""
    scan()
    return {
        (call["path"], call["generic"]) for call in CALLS if call["method"] == method
    }


def typed_get_calls():
    """(путь, тип-аргумент) для каждого типизированного GET-вызова фронта."""
    return typed_calls("GET")


# Ключи, которые бэкенд отдаёт, а тип их не объявляет. Локатор —
# `путь#поле`, ключ — то, что лежит рядом с объявленными полями строки.
SENT_BUT_UNREAD = {
    "/predict/markets#[]": (
        {"b", "max_subsidy"},
        "их читает Telegram-бот: /markets печатает «Пул LMSR: b=… · субсидия ≤ …» "
        "(telegram_bot.py), а карточка рынка показывает ceiling ликвидности",
    ),
    "/agent/memory#open_trades[]": (
        {"opened_at", "context_note", "exit_price", "closed_at"},
        "сделки отдаются как TradeRecord.__dict__: время входа, контекст решения "
        "и ещё пустые поля закрытия пишутся, а панель показывает сторону, вход и размер",
    ),
    "/agent/memory#closed_trades[]": (
        {"opened_at", "context_note", "closed_at"},
        "то же: момент закрытия и контекст в журнал пишутся, панель их не выводит",
    ),
}
ALLOWED_UNREAD = {locator: keys for locator, (keys, _reason) in SENT_BUT_UNREAD.items()}


class TestTsScanner(unittest.TestCase):
    """Сканер обязан находить то, что в исходниках есть, — иначе весь файл это
    зелёная проверка пустоты: пустой список путей сходится с пустым списком
    полей, и ни одного расхождения не видно никогда."""

    @classmethod
    def setUpClass(cls):
        scan()

    def test_declarations_are_parsed(self):
        self.assertGreaterEqual(
            len(DECLS), 40, f"объявлений найдено только {len(DECLS)}"
        )
        for name in (
            "MarketOverviewRow",
            "BackendFollow",
            "MirrorLogRow",
            "LeaderRow",
            "PredictMarket",
            "PredictPosition",
            "Subscription",
        ):
            self.assertIn(name, DECLS, f"{name} не разобралось")

    def test_field_lists_are_the_ones_in_the_source(self):
        cases = {
            # у этого объявления почти у каждого поля есть комментарий с запятой
            # или точкой с запятой: если проза не вырезана, поля теряются
            "MarketOverviewRow": [
                "market_id",
                "symbol",
                "base",
                "price",
                "change_24h",
                "quote_volume_24h",
                "open_interest_base",
                "min_base_amount",
                "size_decimals",
                "taker_fee",
                "maker_fee",
                "funding_hourly",
                "funding_annualized",
                "funding_payer",
            ],
            "LeaderRow": [
                "id",
                "lighter_account_index",
                "handle",
                "fee_bps",
                "created_at",
            ],
            "BackendFollow": [
                "id",
                "follower_id",
                "leader_id",
                "leader_handle",
                "allocation_usd",
                "max_leverage",
                "current_mirrored_size",
                "paused",
                "created_at",
            ],
            "Subscription": [
                "tier",
                "has_ai_agent",
                "has_copy_trading",
                "has_predict_markets",
                "days_left_in_trial",
            ],
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                got = [f.name for f in resolve_fields(name)]
                self.assertEqual(got, expected, f"{name}: разбор вернул {got}")

    def test_intersection_type_merges_both_sides(self):
        """HydratedLeaderRow = LeaderRow & {...}: без слияния витрина лидеров
        сверялась бы по четырём полям вместо одиннадцати."""
        got = {f.name for f in resolve_fields("HydratedLeaderRow")}
        self.assertTrue(
            {"id", "handle", "fee_bps", "follower_count", "total_aum_usd", "account"}
            <= got,
            got,
        )

    def test_nested_inline_types_are_readable(self):
        """account у витрины — объект внутри объекта: если вложенный блок не
        разобрался, его поля не сверяются ни с чем."""
        fields = {f.name: f for f in resolve_fields("HydratedLeaderRow")}
        account = resolve_fields(fields["account"].type)
        self.assertIsNotNone(
            account, f"account не разобрался: {fields['account'].type!r}"
        )
        self.assertEqual(
            [f.name for f in account], ["equity_usd", "realized_pnl_usd", "positions"]
        )

    def test_optional_marker_survives_parsing(self):
        fields = {f.name: f for f in resolve_fields("BackendFollow")}
        self.assertTrue(fields["leader_handle"].optional)
        self.assertFalse(fields["allocation_usd"].optional)

    def test_comments_are_cut_without_cutting_the_strings(self):
        """Комментарии мешают разбору, а `//` внутри строки — не комментарий:
        вырезание по символу съело бы и URL, и путь вызова."""
        source = 'const u = "https://example.com"; // путь, с запятой\nlet v = 1;'
        stripped = _strip_comments(source)
        self.assertIn("https://example.com", stripped)
        self.assertNotIn("путь", stripped)
        self.assertIn("let v = 1;", stripped)

    def test_typed_calls_are_found(self):
        calls = typed_get_calls()
        self.assertGreaterEqual(
            len(calls), 10, f"типизированных GET-вызовов: {sorted(calls)}"
        )
        self.assertIn(("/leaders/hydrated", "HydratedLeaderRow[]"), calls)
        self.assertIn(("/markets/overview", "MarketOverview"), calls)

    def test_method_is_read_from_the_call(self):
        by_raw = {(call["raw_path"], call["method"]) for call in CALLS}
        # POST с телом не должен попасть в сверку ответов GET
        self.assertIn(("/follows", "POST"), by_raw)
        self.assertIn(("/portfolio/risk", "POST"), by_raw)
        self.assertNotIn(("/portfolio/risk", "GET"), by_raw)

    def test_the_exception_table_itself_is_reasoned(self):
        """Исключение «этот ключ читаем не мы» без причины — тот же мёртвый груз,
        только помеченный: таблица не имеет права расти молча."""
        for locator, (keys, reason) in SENT_BUT_UNREAD.items():
            self.assertTrue(keys, f"{locator}: пустой список ключей")
            self.assertGreaterEqual(
                len(reason),
                40,
                f"{locator}: у пропуска ключей обязан быть текст причины",
            )
        for locator in ALLOWED_UNREAD:
            self.assertIn(
                "#", locator, f"{locator}: исключение верхнего уровня не нужно"
            )


class TestFieldContract(CopyTradingSeeding):
    """Каждый типизированный GET прогоняется на посеянных данных, и объявленные
    поля сравниваются с ключами ответа.

    Посев обязателен и проверяем: пустой список строк не опроверг бы ни одного
    объявления, поэтому каждая кончается «объектов сверено не ноль»."""

    CURATOR_JSON = {
        "X-Curator-Token": testsupport.CURATOR_TOKEN,
        "Content-Type": "application/json",
    }

    async def check(self, request_path: str, response, method: str = "GET"):
        """Сверка одного ответа со всеми типами, которыми фронт его объявил."""
        self.assertEqual(response.status_code, 200, response.text[:400])
        payload = response.json()
        declared = sorted(
            (route, generic)
            for route, generic in typed_calls(method)
            if path_matches(route, request_path)
        )
        self.assertTrue(
            declared,
            f"{method} {request_path}: фронт не объявляет этот ответ типом — сверка ничего не видит",
        )
        diff = Diff()
        for route, generic in declared:
            diff.walk(payload, generic, route, "")
        self.assertEqual(
            diff.missing,
            [],
            "тип читает поля, которых нет в ответе — интерфейс покажет undefined при HTTP 200",
        )
        unexpected = sorted(
            {
                locator
                for locator in diff.unread
                if (base := locator.rpartition("|")[0]) not in ALLOWED_UNREAD
                or locator.rpartition("|")[2] not in ALLOWED_UNREAD[base]
            }
        )
        self.assertEqual(
            unexpected,
            [],
            "бэкенд отдаёт ключи, которых фронт не объявил и не внёс в SENT_BUT_UNREAD: "
            + ", ".join(unexpected),
        )
        self.assertEqual(
            diff.problems, [], "форма значений не совпадает с объявленным типом"
        )
        self.assertGreaterEqual(
            diff.objects, 1, f"{request_path}: сверка не увидела ни одного объекта"
        )
        return payload

    async def seed_market_overview(self):
        """Фикстуры живого ответа mainnet из смока: второй копии формы Lighter
        в репозитории не место."""

        def overview(symbols=None, network=None):
            return {
                "network": network or "mainnet",
                "ranked_by": "quote_volume_24h",
                "count": len(test_api_smoke.TestMarketsOverview.ROWS),
                "rows": [dict(row) for row in test_api_smoke.TestMarketsOverview.ROWS],
                "no_market": ["TON"],
                "no_data": ["MATIC"],
            }

        originals = (lighter_rest.get_market_overview, lighter_rest.get_funding_rates)
        lighter_rest.get_market_overview = overview
        lighter_rest.get_funding_rates = lambda network=None: list(
            test_api_smoke.TestMarketsOverview.RATES
        )
        self.addCleanup(setattr, lighter_rest, "get_market_overview", originals[0])
        self.addCleanup(setattr, lighter_rest, "get_funding_rates", originals[1])

    async def test_markets_overview_fields(self):
        await self.seed_market_overview()
        await self.check(
            "/markets/overview", await self.client.get("/markets/overview")
        )

    async def test_follow_and_leader_surfaces(self):
        headers, leader_id = await self.publish(1501, "@fields")
        follower_headers, _ = await self.sign_in_wallet(1502)
        await self.follow(follower_headers, leader_id, 400)

        await self.check(
            "/follows", await self.client.get("/follows", headers=follower_headers)
        )
        await self.check(
            "/leaders/mine", await self.client.get("/leaders/mine", headers=headers)
        )
        await self.check("/leaders", await self.client.get("/leaders"))
        await self.check(
            "/leaders/*/followers",
            await self.client.get(f"/leaders/{leader_id}/followers", headers=headers),
        )
        await self.check(
            "/follows/by-leader/*",
            await self.client.get(f"/follows/by-leader/{leader_id}"),
        )
        await self.snapshot_stub()
        body = await self.check(
            "/leaders/hydrated", await self.client.get("/leaders/hydrated")
        )
        self.assertTrue(
            body[0]["account"], "без счёта вложенные поля карточки не сверяются"
        )

    async def test_mirror_log_fields(self):
        import db

        headers, leader_id = await self.publish(1503, "@journal")
        follower_headers, _ = await self.sign_in_wallet(1504)
        follow_id = await self.follow(follower_headers, leader_id, 250)
        for status, reason, tx_hash in (
            ("sent", None, "0x" + "a" * 64),
            ("skipped", "маржа не позволяет", None),
            ("dry_run", None, None),
            ("failed", "Lighter отклонил ордер", None),
            ("planned", None, None),
        ):
            await db.log_mirror_result(
                id_=f"ml-{status}",
                follow_id=follow_id,
                market_id=1,
                side="long",
                base_amount=0.01,
                reduce_only=False,
                status=status,
                reason=reason,
                tx_hash=tx_hash,
            )
        body = await self.check(
            "/mirror-log",
            await self.client.get("/mirror-log?limit=50", headers=follower_headers),
        )
        self.assertEqual(len(body), 5, "статусы журнала перебираются поштучно")

    async def test_predict_surfaces(self):
        r = await self.client.post(
            "/predict/markets/event",
            json={
                "question": "BTC выше 100k к 2027?",
                "resolve_at": 1999999999,
                "b": 100,
            },
            headers=self.CURATOR_JSON,
        )
        self.assertEqual(r.status_code, 200, r.text[:200])
        market_id = r.json()["market_id"]

        headers, _ = await self.sign_in_wallet(1505)
        r = await self.client.post(
            f"/predict/markets/{market_id}/trade",
            json={"outcome": "yes", "shares": 5, "limit_price": 1.0},
            headers=headers,
        )
        self.assertEqual(r.status_code, 200, r.text[:200])

        markets = await self.check(
            "/predict/markets", await self.client.get("/predict/markets")
        )
        self.assertTrue(markets, "без рынка список пуст, и поля рынка не сверяются")
        positions = await self.check(
            "/predict/positions",
            await self.client.get("/predict/positions", headers=headers),
        )
        self.assertTrue(positions, "без сделки поля позиции не сверяются")

    async def test_subscription_and_health_fields(self):
        headers, _ = await self.sign_in_wallet(1506)
        # Ответ трайла сверяется так же, как ответ GET: фронт читает его телом,
        # а не фактом «запрос дошёл» (App.tsx ставит в состояние именно его).
        trial = await self.check(
            "/subscription/trial",
            await self.client.post("/subscription/trial", headers=headers),
            method="POST",
        )
        self.assertEqual(trial["tier"], "free_trial")
        body = await self.check(
            "/subscription", await self.client.get("/subscription", headers=headers)
        )
        self.assertEqual(body["tier"], "free_trial")
        await self.check("/health", await self.client.get("/health"))

    async def test_agent_memory_fields(self):
        """Память агента: строки сделок приходят как TradeRecord.__dict__, и их
        ключи — ровно поля датакласса, поэтому панель читает только объявленное."""
        import agent_db

        headers, account = await self.sign_in_wallet(1507)
        memory = agent_db.PendingMemory(user_id=account.address)
        memory.record_open("fc-open", 1, "long", 99_000.0, 0.2)
        memory.record_open("fc-closed", 1, "short", 99_000.0, 0.1)
        memory.record_close("fc-closed", 98_000.0)
        await agent_db.flush_memory(memory, "dry_run")
        body = await self.check(
            "/agent/memory", await self.client.get("/agent/memory", headers=headers)
        )
        self.assertEqual(len(body["open_trades"]), 1, "одна открытая и одна закрытая")
        self.assertEqual(len(body["closed_trades"]), 1)

    async def test_every_typed_call_is_accounted_for(self):
        """Ни одна типизированная поверхность не имеет права выпасть из сверки
        молча: новый `backendJson<T>` обязан либо получить посев здесь, либо
        остаться в списке причин — с указанием, где его проверяют иначе."""
        covered = {
            ("GET", route)
            for route in (
                "/markets/overview",
                "/follows",
                "/leaders",
                "/leaders/mine",
                "/leaders/hydrated",
                "/leaders/*/followers",
                "/follows/by-leader/*",
                "/mirror-log",
                "/predict/markets",
                "/predict/positions",
                "/subscription",
                "/health",
                "/agent/memory",
            )
        }
        # Метод другой, а тело то же: _subscription_body собирает одним вызовом,
        # и посев над ним в test_subscription_and_health_fields сверяет ответ
        # трайла полем в поле, а не записывает его «для галочки».
        covered |= {("POST", "/subscription/trial")}
        reasons = {
            # POST отвечает на запрос тела, и его поля читаются в том тесте,
            # который этот запрос посылает: отдельный посев здесь удвоил бы
            # фикстуры, не добавив ни одного нового сравнения. Указание на
            # место проверки обязано существовать — причина «проверяется где-то
            # ещё» без адреса это не причина.
            ("POST", "/agent/step"): (
                "решение агента разбирается по полям там, где шаг и посылается",
                "test_subscription_trial_and_agent_step",
            ),
            ("POST", "/portfolio/risk"): (
                "волатильность сверяется по значениям в тесте, который считает тело запроса",
                "test_portfolio_risk",
            ),
            ("POST", "/portfolio/hedge"): (
                "хедж разбирается тем же тестом: suggestion читается по ключам",
                "test_portfolio_risk",
            ),
            ("POST", "/funding-arb/check"): (
                "арбитраж проверяется по annualized_yield, то есть поля ответа уже читаются",
                "test_funding_arb",
            ),
            ("POST", "/funding-arb/size"): (
                "там же: sizing читает position по ключам, а не по наличию ответа",
                "test_funding_arb",
            ),
            ("POST", "/follows"): (
                "follow_id берётся из ответа, и KeyError уронил бы каждую тестовую подписку",
                "def follow",
            ),
            ("POST", "/leaders"): (
                "leader_id берётся из ответа тем же посевом, что и подписки",
                "def publish",
            ),
            ("POST", "/auth/wallet/challenge"): (
                "message читается самим входом кошельком: без него не получить токен",
                "async def wallet_challenge",
            ),
            ("POST", "/auth/wallet/verify"): (
                "user_id, lighter_account_index и token сверяются живым входом",
                "async def sign_in_wallet",
            ),
            ("POST", "/auth/telegram"): (
                "конверт с токеном собирается входом виджета, а initData для отдельного "
                "посева требует подписи бота",
                "async def sign_in_telegram",
            ),
            ("POST", "/auth/telegram/init"): (
                "тот же конверт для мини-приложения проверяется живым запросом",
                "test_valid_init_data_creates_follower",
            ),
        }
        scan()
        found = {(call["method"], call["path"]) for call in CALLS}
        for method, route in sorted(found):
            with self.subTest(call=f"{method} {route}"):
                self.assertTrue(
                    (method, route) in covered or (method, route) in reasons,
                    f"{method} {route}: без посева и без причины",
                )
        stale = sorted((covered | set(reasons)) - found)
        self.assertEqual(
            stale, [], f"сверка описывает вызовы, которых во фронте больше нет: {stale}"
        )
        smoke = (
            Path(__file__).with_name("test_api_smoke.py").read_text(encoding="utf-8")
        )
        for (method, route), (reason, pointer) in reasons.items():
            self.assertGreaterEqual(
                len(reason),
                40,
                f"{method} {route}: у пропуска обязан быть текст причины",
            )
            self.assertIn(
                pointer,
                smoke,
                f"{method} {route}: причиной назван тест, которого в smoke нет — "
                f"{pointer} не найдено",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
