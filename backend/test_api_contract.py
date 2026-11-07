"""Контракт фронтенда и бэкенда: каждый путь, который сайт зовёт, существует.

Вторая половина файла — тот же принцип на другом конце интерфейса: список
вкладок сверяется с ветками рендера в App.tsx, с диапазоном горячих клавиш и с
валидацией `?tab=` в deeplink.ts.

python3 -m unittest test_api_contract -v

Зачем этот файл появился. Прода-фронтенд ходил на `GET /leaders/hydrated`
против сервиса, задеплоенного до появления этого маршрута, и получал 404. Ни
один тест это не ловил: юнит-тесты знают свои строки путей, e2e работает на
заглушках, а смоук бэкенда проверяет роуты, которые знает бэкенд, — а не те,
которые просит фронтенд. Расхождение видно только когда сравнишь оба списка.

Здесь сравниваются именно списки: пути, которые фронтенд передаёт в
`backendJson` / `${BACKEND_URL}` / `${SIGNING_SERVICE_URL}`, против таблиц
маршрутов `backend/app.py` и `backend/signing_service.py`. Метод не
сверяется: фронтенд задаёт его параметром вызова, и путь, совпавший с чужим
методом, всё равно виден в `test_api_smoke.py`, где каждый роут прогоняется.

Тест не требует базы и сети: читаются только исходники и реестры маршрутов.
"""

import re
import unittest
from pathlib import Path

import testsupport  # noqa: F401,E402  (задаёт env раньше app и config)

import app as wake_app  # noqa: E402
import signing_service  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "src"

# префиксы, которыми фронтенд собирает URL.
BACKEND_PREFIX = "${BACKEND_URL}"
SIGNING_PREFIX = "${SIGNING_SERVICE_URL}"
PATH_SHAPE = re.compile(r"^/[A-Za-z0-9_/.*-]*$")


def _source_files():
    for path in sorted(SRC.rglob("*.ts*")):
        if ".test." in path.name:
            continue
        yield path


def _read_literal(text: str, i: int) -> tuple[str, int]:
    """Литерал, начинающийся с кавычки на позиции i, и индекс после него.

    Обычный `[^'"]+` здесь не годится: аргумент backendJson часто бывает
    шаблоном вида `/follows/${id}/${paused ? "resume" : "pause"}`, и поиск по
    первой кавычке обрывал строку на `${paused ? "` — тест получал мусор вместо
    пути и молча проверял не то.
    """
    quote = text[i]
    out: list[str] = []
    j = i + 1
    depth = 0
    while j < len(text):
        char = text[j]
        if char == "\\":
            out.append(text[j : j + 2])
            j += 2
            continue
        if quote == "`":
            if depth == 0 and char == "`":
                return "".join(out), j + 1
            if char == "$" and text[j + 1 : j + 2] == "{":
                depth += 1
                out.append("${")
                j += 2
                continue
            if char == "}":
                depth = max(0, depth - 1)
        elif char == quote:
            return "".join(out), j + 1
        out.append(char)
        j += 1
    raise ValueError(f"незакрытый литерал в {text[max(0, i - 40) : i + 40]!r}")


def _call_arguments(text: str):
    """Первые аргументы backendJson(...) и шаблоны с BASE_URL-префиксами."""
    for match in re.finditer(r"backendJson\s*(?:<[^()]*?>)?\s*\(", text):
        i = match.end()
        while i < len(text) and text[i] in " \n\r\t":
            i += 1
        if i < len(text) and text[i] in "\"'`":
            literal, _ = _read_literal(text, i)
            if literal.startswith("/"):
                yield "wake", literal
    for prefix, bucket in ((BACKEND_PREFIX, "wake"), (SIGNING_PREFIX, "signing")):
        for match in re.finditer(re.escape(prefix), text):
            start = text.rfind("`", 0, match.start())
            if start == -1 or text[start + 1] != "$":
                # префикс внутри фразы («… ${BACKEND_URL} не отвечает …») —
                # это текст сообщения об ошибке, а не адрес вызова
                continue
            literal, _ = _read_literal(text, start)
            remainder = literal[len(prefix) :] if literal.startswith(prefix) else ""
            # вызовом считается только шаблон с литеральным путём после
            # префикса: сам хелпер пишет `${BACKEND_URL}${path}`, и его путь
            # здесь неизвестен по построению
            if not remainder.startswith("/"):
                continue
            yield bucket, remainder


def _normalize(raw: str) -> str:
    """Путь из шаблона TS к сравнению с маршрутом FastAPI.

    Любое `${...}`, включая вложенное (`${encodeURIComponent(id)}`,
    `${paused ? "resume" : "pause"}`), — один сегмент, поэтому сворачивается в
    `*` целиком, без разбора того, что внутри.
    """
    without_query = raw.split("?")[0].split("#")[0]
    out: list[str] = []
    i = 0
    while i < len(without_query):
        if without_query[i : i + 2] == "${":
            depth, j = 0, i + 1
            while j < len(without_query):
                if without_query[j] == "{":
                    depth += 1
                elif without_query[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            out.append("*")
            i = j + 1
            continue
        out.append(without_query[i])
        i += 1
    return "".join(out).rstrip("/") or "/"


def frontend_paths():
    """(wake-пути, пути сервиса подписи) — как их произносит фронтенд."""
    buckets: dict[str, set] = {"wake": set(), "signing": set()}
    for path in _source_files():
        text = path.read_text(encoding="utf-8")
        for bucket, raw in _call_arguments(text):
            normalized = _normalize(raw)
            if not PATH_SHAPE.match(normalized):
                raise AssertionError(
                    f"сканер вернул не путь из {path.name}: {raw!r} -> "
                    f"{normalized!r} — правка в способе вызывать API, а не "
                    "в бэкенде; тест обязан краснеть, а не проверять мусор"
                )
            buckets[bucket].add(normalized)
    return buckets["wake"], buckets["signing"]


def route_paths(routes_app) -> set:
    """Пути из OpenAPI-схемы приложения — как их объявил бэкенд.

    По `routes_app.routes` собирать нельзя: в fastapi 0.143 включённые роутеры
    лежат за объектами `_IncludedRouter`, у которых `.path` нет, и такой сбор
    вернул бы две служебные строчки на сорок с лишним маршрутов — то есть
    зелёный тест, который сверяет пустоту с пустотой. Схема — тот же реестр
    маршрутов, но полный, и она же кормит шпаргалку `/openapi.json`.
    """
    return set(routes_app.openapi().get("paths", {}))


def _segments(path: str) -> list:
    return [segment for segment in path.split("/") if segment]


def matches(frontend_path: str, route_path: str) -> bool:
    """Совпадает ли путь фронтенда с маршрутом бэкенда сегмент к сегменту.

    `*` слева — это `${...}` из шаблона (id подписки или тернарник
    `${paused ? "resume" : "pause"}`), `{param}` справа — часть пути в
    FastAPI. Оба значат «один любой сегмент», поэтому сравниваются одинаково:
    без этого `/follows/*/*` не совпал бы ни с `/follows/{id}/pause`, ни с
    `/follows/{id}/resume`, хотя фронтенд просит ровно их.
    """
    left, right = _segments(frontend_path), _segments(route_path)
    if len(left) != len(right):
        return False
    for front, route in zip(left, right):
        if front == "*" or (route.startswith("{") and route.endswith("}")):
            continue
        if front != route:
            return False
    return True


def missing_paths(frontend: set, routes: set) -> list:
    return sorted(p for p in frontend if not any(matches(p, r) for r in routes))


class TestFrontendBackendContract(unittest.TestCase):
    def test_scanner_actually_reads_the_sources(self):
        # Пустой список сделал бы весь файл зелёной проверкой ничего. Числа —
        # это нижняя граница: путей больше, и упасть тест должен, если сканер
        # перестал что-то находить (изменился способ вызывать API), а не если
        # бэкенд что-то добавил.
        wake, signing = frontend_paths()
        self.assertGreaterEqual(len(wake), 20, f"сканер нашёл только {sorted(wake)}")
        self.assertIn("/leaders/hydrated", wake)
        self.assertIn("/place-order", signing)
        # та же граница для второй стороны: пустой реестр маршрутов совпадает
        # с пустым списком вызовов, и проверка молча перестаёт что-либо значить
        self.assertGreaterEqual(len(route_paths(wake_app.app)), 30)

    def test_every_wake_path_the_frontend_calls_exists(self):
        wake, _ = frontend_paths()
        missing = missing_paths(wake, route_paths(wake_app.app))
        self.assertEqual(
            missing,
            [],
            "фронтенд зовёт маршруты, которых нет в бэкенде: "
            + ", ".join(missing)
            + " — сайт получит 404, и это ровно тот случай, из-за которого "
            "Discover сломался на проде (Pages новее задеплоенного Railway)",
        )

    def test_every_signing_service_path_exists(self):
        _, signing = frontend_paths()
        missing = missing_paths(signing, route_paths(signing_service.app))
        self.assertEqual(
            missing,
            [],
            "фронтенд зовёт сервис подписи по маршрутам, которых в нём нет: "
            + ", ".join(missing),
        )

    def test_health_and_ready_are_reachable_by_the_probe(self):
        # probeBackend опрашивает именно эти два пути, и по ним приложение
        # судит о всей связности: если их переименуют, баннер «бэкенд не готов»
        # появится на полностью рабочем сервисе.
        wake, _ = frontend_paths()
        self.assertTrue({"/health", "/ready"} <= wake, sorted(wake))


class TestTabRegistry(unittest.TestCase):
    """Вкладки: список, ветки рендера и горячие клавиши сверяются по исходникам.

    Здесь же живёт и проверка deeplink: ссылка из бота приходит как `?tab=…`, и
    валидация обязана принимать ровно те значения, которые знает навигация, —
    иначе бот отдаёт ссылку на раздел, которого оболочка не знает, и человек
    видит пустой экран вместо нужной панели.
    """

    ROOT = Path(__file__).resolve().parent.parent / "src"

    def _text(self, relative: str) -> str:
        return (self.ROOT / relative).read_text(encoding="utf-8")

    def _tab_ids(self) -> list:
        text = self._text("lib/tabs.ts")
        block = text[text.index("export const TABS") :]
        return re.findall(r'\{\s*id:\s*"([a-z]+)"', block)

    def test_ids_are_unique_and_fit_the_hotkey_range(self):
        ids = self._tab_ids()
        self.assertEqual(len(ids), len(set(ids)), f"повтор в TABS: {ids}")
        # Alt существует для 1..9: обработчик в App.tsx физически не может дать
        # десятую клавишу, и выросший молча список потерял бы хоткеи.
        self.assertLessEqual(len(ids), 9, f"вкладок {len(ids)} — клавиш не хватит")
        self.assertEqual(len(ids), 9, f"вкладок стало {len(ids)}: {ids}")

    def test_every_tab_has_a_render_branch(self):
        app = self._text("App.tsx")
        missing = [i for i in self._tab_ids() if f'tab === "{i}" &&' not in app]
        self.assertEqual(
            missing,
            [],
            f"вкладки без ветки рендера: {missing} — кнопка переключит экран в пустоту",
        )

    def test_hotkey_ceiling_matches_the_number_of_tabs(self):
        app = self._text("App.tsx")
        ceiling = re.search(r'e\.key\s*>=\s*"(\d)"\s*&&\s*e\.key\s*<=\s*"(\d)"', app)
        self.assertIsNotNone(ceiling, "обработчик Alt+цифра не найден в App.tsx")
        low, high = int(ceiling.group(1)), int(ceiling.group(2))
        ids = self._tab_ids()
        self.assertEqual(low, 1, "нумерация хоткеев должна начинаться с 1")
        self.assertGreaterEqual(
            high,
            len(ids),
            f"клавиш до {high}, а вкладок {len(ids)}: у последних нет хоткея",
        )

    def test_deeplink_accepts_exactly_the_known_tabs(self):
        deeplink = self._text("lib/deeplink.ts")
        self.assertIn("TAB_IDS", deeplink, "deeplink больше не сверяется со списком")
        self.assertRegex(
            deeplink,
            r"TAB_IDS as readonly string\[\]\)\.includes\(",
            "валидация ?tab= перестала использовать TAB_IDS",
        )


if __name__ == "__main__":
    unittest.main()
