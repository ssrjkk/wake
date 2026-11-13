"""Контракт фронтенда и бэкенда: каждый путь, который сайт зовёт, существует.

Треть файла — список вкладок против веток рендера в App.tsx, диапазона горячих
клавиш, валидации `?tab=` в deeplink.ts и того списка, которым ходят браузерные
гейты. Четвёртая — утверждения документов, которые код может опровергнуть: поле
схемы, формат ошибки, цифра маршрутов, число тестов и число панелей.
Поля ответов этого же контракта сверяет test_field_contract.py — там, где путь
нашёл ответ, но не посмотрел, что внутри.

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

Тест не требует базы и сети: читаются только исходники, конфиги и реестры
маршрутов.
"""

import json
import re
import unittest
from pathlib import Path

import testsupport  # noqa: F401  (задаёт env раньше app и config)

import app as wake_app
import signing_service

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
    видит пустой экран вместо нужной панели. Третий слой — браузерные гейты:
    они обходят интерфейс по подписям, переписанным в `e2e/design-audit.ts`, и
    если этот список отстанет, новая панель никогда не будет измерена, а прогон
    не заметит.
    """

    ROOT = Path(__file__).resolve().parent.parent / "src"

    def _text(self, relative: str) -> str:
        return (self.ROOT / relative).read_text(encoding="utf-8")

    def _repo_text(self, relative: str) -> str:
        return (self.ROOT.parent / relative).read_text(encoding="utf-8")

    def _tab_ids(self) -> list:
        text = self._text("lib/tabs.ts")
        block = text[text.index("export const TABS") :]
        return re.findall(r'\{\s*id:\s*"([a-z]+)"', block)

    def _tab_labels(self) -> list:
        text = self._text("lib/tabs.ts")
        block = text[text.index("export const TABS") :]
        return re.findall(r'\{\s*id:\s*"[a-z]+",\s*label:\s*"([^"]+)"', block)

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

    def test_e2e_walks_the_same_tabs_the_app_renders(self):
        """`e2e/design-audit.ts` обходит вкладки по подписям, и спеки кликают
        именно по этому списку. Список, отставший от `tabs.ts`, означает
        панель, которую никогда не проверяли, — прогон остаётся зелёным и
        ничего не замечает. Поэтому подписи сверяются с реестром, а вторая
        копия списка запрещена во всех файлах сразу: она появляется ровно
        тогда, когда новый спек начинает кликать по вкладкам, и живёт до
        первого переименования раздела.
        """
        ids = self._tab_ids()
        labels = self._tab_labels()
        self.assertEqual(len(labels), len(ids), "метка какой-то вкладки не разобралась")

        audit = self._repo_text("e2e/design-audit.ts")
        block = re.search(r"export const TABS\s*=\s*\[(.*?)\]", audit, re.S)
        self.assertIsNotNone(block, "список вкладок в e2e/design-audit.ts не найден")
        self.assertEqual(
            re.findall(r'"([^"]+)"', block.group(1)),
            labels,
            "гейт обходит не те вкладки, которые показывает навигация",
        )

        e2e = (self.ROOT.parent / "e2e").resolve()
        users = []
        for path in sorted(e2e.glob("*.ts")):
            if path.name == "design-audit.ts":
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"\bTABS\b", text) is None:
                continue
            users.append(path.name)
            self.assertNotIn(
                "const TABS",
                text,
                f"у {path.name} собственный список вкладок — он отстанет от tabs.ts молча",
            )
            self.assertIsNotNone(
                re.search(r'from\s+["\']\./design-audit["\']', text),
                f"{path.name} пользуется списком, который больше не берётся из общего реестра",
            )
        self.assertGreaterEqual(
            len(users),
            4,
            "список вкладок больше не кому обходить — гейт сверяет пустоту",
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


class TestDocsClaims(unittest.TestCase):
    """Утверждения документов, которые код может опровергнуть.

    README и SECURITY.md описывают не только замысел, но и поверхности: схему
    credentials в OpenAPI, формат ошибок, цену записи. Первая же цифра, которую
    док пересказывает из живых данных, устаревает в том же коммите, что её
    изменил, — в README стоило «38 путей» против 43 в openapi(), и проверить
    это глазами невозможно: обе строки выглядят правдоподобно.

    Поэтому здесь три запрета на счётчики — маршруты, размер набора тестов и
    число панелей — и отдельная сверка того, что док утверждает про содержимое
    схемы. Все три запрещены по одной причине: страница не пересобирает ни
    реестр роутов, ни набор, ни `tabs.ts`, чтобы узнать их размер, — и ровно
    поэтому в доке жил текст «704 теста», когда дерево собирало 729, и «38
    путей» против 43 в openapi(), и «девять разделов» там, где число вкладок
    держит горячие клавиши 1..9.
    """

    DOC_NAMES = (
        "README.md",
        "README.ru.md",
        "CONTRIBUTING.md",
        "SECURITY.md",
        "docs/RAILWAY_DEPLOY.md",
    )
    # Зеркальные формы («routes: 43», «тестов — 704») запрещаются так же, как
    # прямые: у числа, записанного после слова, та же судьба. Разделитель
    # обязателен — без него под запрет попала бы проза про коды ответов
    # («route 403», «endpoints = 401» уже про HTTP, а не про размер реестра).
    COUNT_SHAPE = re.compile(
        r"\b\d{1,4}\s*(?:paths?|путей|routes?|маршрутов|endpoints?|эндпоинтов)\b"
        r"|\b(?:paths?|routes?|endpoints?|маршрут(?:ы|а|ов|е|ах)?|эндпоинт(?:ы|а|ов|е|ах)?)"
        r"\s*[:=–—]\s*\d{1,4}\b",
        re.I,
    )
    TEST_COUNT_SHAPE = re.compile(
        r"\d+\s*(?:tests?\b|test\s+files?\b|specs?\b|passed\b|skipped\b"
        r"|тест(?:ы|ов|а|е)?\b|спецификаци\w*\b|спек\w*\b|прошли\b"
        r"|пропущен\w*\b|файлов\b|файл(?:ы|а|ов|ах)?\b)"
        r"|\b(?:tests?|specs?|files?|passed\b|skipped\b|тест(?:ы|ов|а|е|ах)?"
        r"|спецификаци\w*|файл(?:ы|а|ов|е|ах)?|прошли|пропущен\w*)"
        r"\s*[:=–—]\s*\d{1,4}\b",
        re.I,
    )
    # Число панелей принадлежит `src/lib/tabs.ts`, а не документу: строка
    # «девять разделов встали нижней панелью» описывала live-реестр и
    # постарела бы в тот же день, когда десятая вкладка осталась бы без
    # горячей клавиши. Литерой («nine», «девять») под запрет не берём — проза
    # вроде «two tabs» считает открытые вкладки браузера, а не размер
    # интерфейса, и ловить её означало бы научить гейт врать. Цифра же перед
    # таким словом — всегда счётчик, и её ловить можно.
    TAB_COUNT_SHAPE = re.compile(
        r"\b\d{1,2}\s*(?:tabs?|panels?|sections?|views?|screens?"
        r"|вклад(?:ки|ок|ам|ах)?|панел(?:и|ей|ам|ях)?|раздел(?:ы|ов|ам|ах)?)\b"
        r"|\b(?:tabs?|panels?|sections?|views?|screens?"
        r"|вклад(?:ки|ок|ам|ах)?|панел(?:и|ей|ам|ях)?|раздел(?:ы|ов|ам|ах)?)"
        r"\s*[:=–—]\s*\d{1,2}\b",
        re.I,
    )

    def _docs(self):
        root = Path(__file__).resolve().parent.parent
        for name in self.DOC_NAMES:
            path = root / name
            if path.exists():
                yield name, path.read_text(encoding="utf-8")

    def _quotes(self, shape):
        quoted = []
        for name, text in self._docs():
            for line_no, line in enumerate(text.splitlines(), start=1):
                for found in shape.finditer(line):
                    quoted.append(f"{name}:{line_no}: {found.group(0)!r}")
        return quoted

    def test_no_document_counts_the_routes(self):
        self.assertEqual(
            self._quotes(self.COUNT_SHAPE),
            [],
            "число маршрутов в доке устаревает с каждым роутером — описывать поверхность, а не счёт",
        )

    def test_no_document_counts_its_tests(self):
        """«704 теста (703 прошли)» переживает один коммит и врёт в следующих
        десяти: док не пересобирает набор, поэтому счётчик здесь — это
        обещание, которое никто не обновляет. Прогон печатает своё число, и
        читать надо его."""
        self.assertEqual(
            self._quotes(self.TEST_COUNT_SHAPE),
            [],
            "число тестов в доке устаревает с каждым добавленным тестом — "
            "описывать, что покрыто, а не сколько",
        )

    def test_no_document_counts_the_panels(self):
        self.assertEqual(
            self._quotes(self.TAB_COUNT_SHAPE),
            [],
            "число панелей в доке устаревает с каждой добавленной вкладкой — "
            "описывать навигацию, а не считать её",
        )

    def test_openapi_declares_both_credential_types(self):
        """Доки говорят, что эндпоинты сами объявляют, какие credentials нужны.

        Проверяется не наличие слова в тексте, а содержимое схемы: имя заголовка
        куратора и тип bearer. Иначе «видно без чтения исходников» — это
        обещание, которое никто не держит."""
        schemes = (
            wake_app.app.openapi().get("components", {}).get("securitySchemes", {})
        )
        self.assertIn("HTTPBearer", schemes, "сессонный bearer не объявлен в OpenAPI")
        self.assertEqual(schemes["HTTPBearer"]["type"], "http")
        self.assertEqual(schemes["HTTPBearer"]["scheme"], "bearer")
        self.assertIn("APIKeyHeader", schemes, "X-Curator-Token не объявлен в OpenAPI")
        self.assertEqual(schemes["APIKeyHeader"]["in"], "header")
        self.assertEqual(schemes["APIKeyHeader"]["name"], "X-Curator-Token")

    # Формат ошибки — {error: {code, message}} — SECURITY.md тоже обещает, но
    # проверяется он живыми запросами в test_api_smoke.py (класс
    # TestFailureResponseContract): поиск по исходнику app.py остаётся зелёным
    # и при сломанном конверте, потому что строка в тексте — не ответ.


class TestTypecheckScope(unittest.TestCase):
    """`npx tsc --noEmit` обязан видеть не только `src/`.

    Пока `e2e/` вне `include`, типы браузерных гейтов не проверяет никто: в
    render-budget.spec.ts четыре раза стоял текст ассерта вторым аргументом
    матчера, которого у матчера нет, — сообщения не печатались ровно там, где
    они нужны. Ошибка всплыла в ту секунду, когда каталог попал в `include`, и
    этот тест нужен затем, чтобы обратно он оттуда не уходил молча: под
    предлогом «сборка падает» конфиг откатывают, а вместе с ним пропадает
    единственная проверка типов для 2 435 строк браузерных проверок (замер
    `wc -l e2e/*.ts` 2026-11-09).
    """

    def test_e2e_is_covered_by_the_typecheck(self):
        cfg = json.loads(
            (Path(__file__).resolve().parent.parent / "tsconfig.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn(
            "e2e",
            cfg.get("include", []),
            "браузерные гейты не проходят проверку типов — их ошибки видны только "
            "внутри трёхминутного прогона, если прогон вообще до них дойдёт",
        )


class TestFrontendEnvKnobs(unittest.TestCase):
    """Три реестра одной настройки фронтенда: код, тип и `.env.example`.

    Бэкенд свою пару уже сверяет (`test_config.TestEnvExample`), а фронтенд —
    нет, хотя переменные у него ровно того же сорта: имя читает сборка, а не
    запуск. Переименовали `VITE_SIGNING_SERVICE_URL` в коде — пример продолжает
    советовать старое имя, локальная сборка остаётся без подписи, и ни один
    гейт не красный. Добавили переменную в пример («вот настройка, включите») —
    а `src/` её не читает никогда, и человек жмёт выключатель без проводки.
    Третьим списком стоит `src/vite-env.d.ts`: он же — единственное место, где
    имя имеет тип, и он же молча отстаёт, пока компилятор не заставят
    отказывать неизвестным именам.

    Последний тест про резерв `BACKEND_URL`: сборка без `VITE_*` обязана уходить
    на настоящий сервис. Резерв в `localhost:8000` выглядит безобидно ровно до
    того момента, когда бандл без env-переменных уезжает на хостинг и вся
    страница живёт на адресе машины разработчика.
    """

    ROOT = Path(__file__).resolve().parent.parent
    KNOB_IN_CODE = re.compile(r"import\.meta\.env\.(VITE_[A-Z0-9_]+)\b")
    KNOB_IN_TEXT = re.compile(r"\b(VITE_[A-Z0-9_]+)\b")

    def _code_knobs(self) -> set:
        names = set()
        for path in sorted((self.ROOT / "src").rglob("*.ts*")):
            if ".test." in path.name:
                continue
            names.update(
                self.KNOB_IN_CODE.findall(
                    path.read_text(encoding="utf-8", errors="replace")
                )
            )
        return names

    def _example_text(self) -> str:
        return (self.ROOT / ".env.example").read_text(encoding="utf-8")

    def _declared_knobs(self) -> set:
        text = (self.ROOT / "src" / "vite-env.d.ts").read_text(encoding="utf-8")
        return set(re.findall(r"readonly\s+(VITE_[A-Z0-9_]+)\??:", text))

    def _example_knobs(self) -> set:
        names = set()
        for line in self._example_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            match = re.match(r"^(VITE_[A-Z0-9_]+)=", stripped)
            if match:
                names.add(match.group(1))
        return names

    def test_the_scanners_found_the_knobs_they_claim_to_cover(self):
        """Позитивный контроль: сверка списков не должна выродиться в пустоту.

        Оба набора получаются разбором, и сломанный разбор даёт пустое множество
        — тогда первые два теста сравнивают два нуля и зелёны навсегда.
        """
        code = self._code_knobs()
        example = self._example_knobs()
        self.assertGreaterEqual(
            len(code),
            4,
            f"`src/` не читает почти ничего ({sorted(code)}) — регулярка разбора сломана",
        )
        self.assertGreaterEqual(
            len(example),
            4,
            f"в `.env.example` не разобралось ни одной переменной ({sorted(example)}) — формат строк поменялся",
        )

    def test_every_knob_the_app_reads_is_in_the_example(self):
        missing = sorted(self._code_knobs() - self._example_knobs())
        self.assertEqual(
            missing,
            [],
            f"код читает, а пример не объясняет: {missing} — локальный запуск гадает по исходникам",
        )

    def test_no_knob_is_advertised_that_the_app_ignores(self):
        extra = sorted(self._example_knobs() - self._code_knobs())
        self.assertEqual(
            extra,
            [],
            f"пример советует переменную, которую `src/` не читает: {extra} — это выключатель без проводки",
        )

    def test_declared_env_type_lists_exactly_the_read_knobs(self):
        """`src/vite-env.d.ts` — третья копия того же списка.

        Одно направление здесь уже сторожит компилятор: с `strictImportMetaEnv`
        (следующий тест) чтение необъявленного `VITE_*` даёт TS2339 на
        `npx tsc --noEmit`. Компилятору не видно двух других: объявленное имя,
        которое никто не читает, — это тип, обещающий настройки, которых нет, и
        `.env.example` для него чужой файл. Поэтому сверка полная, в обе стороны.
        """
        code = self._code_knobs()
        declared = self._declared_knobs()
        self.assertEqual(
            sorted(code - declared),
            [],
            "читается кодом, но не объявлено в `vite-env.d.ts`",
        )
        self.assertEqual(
            sorted(declared - code),
            [],
            "объявлено в `vite-env.d.ts`, но не читается никем — тип обещает настройку, которой нет",
        )

    def test_env_type_is_strict_about_unknown_keys(self):
        """`strictImportMetaEnv` обязан остаться включённым.

        Без него `ImportMetaEnv` дополняется `Record<string, any>` (см.
        `node_modules/vite/types/importMeta.d.ts`), и опечатка в имени
        переменной — `VITE_SIGNING_URL` вместо `VITE_SIGNING_SERVICE_URL` —
        компилируется в `any`, а на рантайме становится `undefined`: сборка
        красная быть не может, и локальная сборка молча теряет сервис подписи.
        Флаг убирают ровно по той же причине, по которой убирают `e2e` из
        `tsconfig`: «мешает сборке». Здесь он ничего не ломает — все шесть
        имён объявлены, — и ловит только то, чего быть не должно.
        """
        text = (self.ROOT / "src" / "vite-env.d.ts").read_text(encoding="utf-8")
        self.assertIsNotNone(
            re.search(r"(?m)^\s*strictImportMetaEnv\??\s*:", text),
            "в `vite-env.d.ts` нет активного участника `strictImportMetaEnv` — "
            "неизвестное имя переменной компилируется как any",
        )

    def test_docs_name_only_knobs_that_exist(self):
        real = self._code_knobs() | self._example_knobs()
        offenders = []
        for name in TestDocsClaims.DOC_NAMES:
            text = (self.ROOT / name).read_text(encoding="utf-8")
            offenders += [
                f"{name}: {found}"
                for found in sorted(set(self.KNOB_IN_TEXT.findall(text)) - real)
            ]
        self.assertEqual(
            offenders,
            [],
            f"доки обещают настройку, которой нет: {offenders}",
        )

    def test_backend_url_fallback_is_a_deployed_service(self):
        text = (self.ROOT / "src" / "lib" / "config.ts").read_text(encoding="utf-8")
        match = re.search(
            r"BACKEND_URL\s*=\s*import\.meta\.env\.VITE_BACKEND_URL\s*\|\|\s*[\"']([^\"']+)",
            text,
        )
        self.assertIsNotNone(
            match,
            "резерв BACKEND_URL больше не литерал сразу после VITE_BACKEND_URL — проверять нечего",
        )
        fallback = match.group(1)
        self.assertTrue(
            fallback.startswith("https://") and "localhost" not in fallback,
            f"сборка без VITE_BACKEND_URL уйдёт на {fallback!r} — бандл обязан "
            "говорить с развёрнутым сервисом",
        )

    def test_example_names_the_network_the_code_defaults_to(self):
        """Заголовок `.env.example` перечисляет дефолты — они обязаны совпасть.

        Сеть в этом перечислении единственная, где док называет значение словом,
        а не адресом: «mainnet Lighter». Переключить дефолт в `config.ts` и
        оставить эту строку — значит отправить человека на тестнет с котировками
        мейннета, и обе стороны будут выглядеть корректно.
        """
        code = (self.ROOT / "src" / "lib" / "config.ts").read_text(encoding="utf-8")
        match = re.search(
            r"LIGHTER_NETWORK[^=]*=\s*import\.meta\.env\.VITE_LIGHTER_NETWORK\s*\|\|\s*[\"']([a-z]+)",
            code,
        )
        self.assertIsNotNone(
            match, "дефолт сети больше не литерал после VITE_LIGHTER_NETWORK"
        )
        default = match.group(1)
        # Заголовок — всё до первой строки присваивания. Делить по «VITE_» нельзя:
        # первая строка примера пишет «Vite читает VITE_* переменные», и от
        # заголовка осталась бы половина фразы про Vite.
        first_assignment = re.search(r"(?m)^VITE_[A-Z0-9_]+=", self._example_text())
        self.assertIsNotNone(
            first_assignment,
            "в `.env.example` не осталось ни одной строки присваивания",
        )
        header = self._example_text()[: first_assignment.start()]
        named = set(re.findall(r"\b(?:mainnet|testnet)\b", header))
        self.assertTrue(
            named,
            "в заголовке `.env.example` не осталось ни одного имени сети — сверять не с чем",
        )
        self.assertEqual(
            named,
            {default},
            f"пример перечисляет {sorted(named)}, а `config.ts` по умолчанию {default!r}",
        )


if __name__ == "__main__":
    unittest.main()
