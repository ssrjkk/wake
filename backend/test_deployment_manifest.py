"""Манифесты развёртывания против кода, который они обещают запустить.

Запуск: python -m pytest test_deployment_manifest.py -v

Повод. `docker-compose.yml`, `.github/workflows/ci.yml` и `Dockerfile` не
исполняются ни во время тестов, ни во время сборки фронта, но именно они
решают, что получит человек, поднявший стек. Расхождение в них не производит
ошибку в коде: оно производит процесс, стартующий с другой настройкой, либо не
стартующий вовсе. Классы, которые закрывает этот файл:

  * переменная, названная в compose или CI, но не читаемая кодом, — значение
    выставлено, поведение не меняется. Этим же был болен след `WAKE_DB_PATH`:
    инструкция про переменную осталась, а читающего её кода больше нет;
  * значение из манифеста, которое настоящий валидатор отверг бы, — контейнер
    падает при старте, и ни один тест об этом не узнает;
  * одна переменная, объявленная и в якоре, и в сервисе: compose применит
    сервисную, и расхождение между ними — это баг, а не настройка (об этом же
    говорит заголовок самого файла);
  * `command:`, ведущая на файл, которого нет в образе;
  * версии инфраструктуры в двух местах: CI поднимает один образ Redis, compose
    — другой, и зелёный прогон ничего не говорит про сервер у человека. К
    интерпретатору это относится в первую очередь: прод-образ и Python, на
    котором CI гоняет тесты, обязаны быть одной версией, иначе зелёный прогон
    ничего не знает о том, что реально запускается;
  * сузленный запуск тестов в CI (`pytest test_one.py` вместо `pytest .`) — job
    зелёный, половина дерева не проверена.

Список «что код читает» не переписывается руками: имена собираются из `ast` по
объявлению полей `Settings`, по прямым обращениям к `os.environ` и по вызовам
хелперов, которые получают имя переменной параметром (так устроен
`place_order_example.py`). Единственное, что задано списком, — переменные чужих
образов и knobs раннера: их читает не наш код по определению, и оба списка
сохнут под отдельными проверками.

Разбор YAML свой, без PyYAML: тот не входит в requirements.txt намеренно (файл
уходит в продакшн-образ), а тест не должен тянуть зависимость ради трёх
манифестов. Парсер поддерживает ровно те формы, которыми написаны файлы
проекта, и падает шумно на форме, которой не понимает, — молча пропущенный ключ
дал бы зелёный гейт на пустом разборе.
"""

import ast
import fnmatch
import json
import re
import unittest
from pathlib import Path

from config import Settings

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
COMPOSE = ROOT / "docker-compose.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"
DOCKERFILE = ROOT / "Dockerfile"
PACKAGE_JSON = ROOT / "package.json"

# Переменные чужих образов: их читает сам контейнер, а не код проекта.
# Ключ — имя образа из `image:` без тега.
IMAGE_KNOBS = {
    "postgres": {"POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"},
    "redis": set(),
    "node": set(),
}
# То, что читает не код проекта, а GitHub-раннер или библиотека клиента,
# которого зовёт шаг. Причина обязательна: без неё список превращается в
# свалку, ровно как список «Старые имена» в теме.
RUNNER_KNOBS = {
    "PGCONNECT_TIMEOUT": "её читает libpq, когда шаг вызывает psql",
    "PYTHON_VERSION": "env workflow, передаётся в setup-python",
    "NODE_VERSION": "env workflow, передаётся в setup-node",
}

# Значения, которые в манифесте заведомо не «настройка из кода», а адрес живой
# зависимости или секрет: проверять их валидатором бессмысленно (порт и хост
# контейнера не обязан проходить чужой healthcheck), но и молча пропускать
# нельзя — список участвует в проверке покрытия.
NOT_VALIDATED = {
    "WAKE_DATABASE_URL",
    "WAKE_REDIS_URL",
    "WAKE_BACKEND_URL",
    "WAKE_SIGNING_SERVICE_URL",
    "WAKE_KEYSTORE_PATH",
    "WAKE_SESSION_SECRET",
    "WAKE_CURATOR_TOKEN",
}

ENV_WORD = re.compile(r"^[A-Z][A-Z0-9_]*$")
IMPORT_META_ENV = re.compile(r"import\.meta\.env\.([A-Z][A-Z0-9_]*)")
PROCESS_ENV = re.compile(r"process\.env\.([A-Z][A-Z0-9_]*)")
ACTION_ENV_REF = re.compile(r"\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
MAPPING_ITEM = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)")
BLOCK_SCALAR = {"|", ">", "|-", ">-", "|+", ">+"}
INTERPOLATION = re.compile(r"^\$\{[A-Z_]+:-([^}]*)\}$")


class YamlError(Exception):
    pass


def _lines(text: str) -> list:
    """(отступ, содержимое, номер строки) для непустых строк без комментариев."""
    out = []
    for number, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        if raw.lstrip().startswith("#") or not raw.strip():
            continue
        out.append((len(raw) - len(raw.lstrip()), raw.strip(), number))
    return out


def _scalar(text: str) -> str:
    """Снять обрамляющие кавычки скаляра.

    YAML их не оставляет в значении, а ручной разбор оставил бы:
    `TELEGRAM_BOT_TOKEN: "123456:ci-only-bot-token"` ушёл бы в валидатор вместе
    с кавычками, и проверка манифеста проверяла бы парсер, а не настройку.
    """
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def _parse(entries: list, index: int, indent: int):
    if entries[index][0] != indent:
        raise YamlError(f"строка {entries[index][2]}: непонятный отступ")

    if entries[index][1].startswith("- "):
        items = []
        while (
            index < len(entries)
            and entries[index][0] == indent
            and entries[index][1].startswith("- ")
        ):
            body = entries[index][1][2:]
            if MAPPING_ITEM.match(body):
                # элемент — отображение (`- path: backend/.env`), продолжение
                # элемента идёт на отступе +2
                sub = [(indent + 2, body, entries[index][2])]
                index += 1
                while index < len(entries) and entries[index][0] > indent:
                    sub.append(entries[index])
                    index += 1
                value, _ = _parse(sub, 0, indent + 2)
                items.append(value)
            else:
                items.append(_scalar(body))
                index += 1
        return items, index

    mapping = {}
    while index < len(entries) and entries[index][0] == indent:
        key, sep, rest = entries[index][1].partition(":")
        if not sep:
            raise YamlError(f"строка {entries[index][2]}: не пара ключ-значение")
        key, rest = key.strip(), rest.strip()
        if key in mapping:
            # настоящий YAML на повторяющемся ключе падает, а не переписывает
            # значение молча: вырезанный сервис оставлял бы за собой сиротливые
            # строки, и `services` недосчитался бы имени, никого не предупредив
            raise YamlError(
                f"строка {entries[index][2]}: ключ {key} повторяется в одном блоке"
            )
        index += 1
        if rest in BLOCK_SCALAR:
            block = []
            while index < len(entries) and entries[index][0] > indent:
                block.append(entries[index][1])
                index += 1
            mapping[key] = "\n".join(block)
        elif rest == "" or rest.startswith("&"):
            # пустое значение — блок глубже; `&anchor` то же самое, якорь здесь
            # не разворачивается, его читают там, где он нужен
            if index < len(entries) and entries[index][0] > indent:
                value, index = _parse(entries, index, entries[index][0])
                mapping[key] = value
            elif rest.startswith("&"):
                raise YamlError(
                    f"строка {entries[index - 1][2]}: якорь {rest} без блока"
                )
            else:
                # ключ без значения и без блока — в YAML это null: так
                # объявляются безымянные тома (`volumes: postgres-data:`)
                mapping[key] = None
        else:
            mapping[key] = _scalar(rest)
    return mapping, index


def parse_yaml(text: str):
    entries = _lines(text)
    if not entries:
        raise YamlError("файл не разобрался ни по одной строке")
    value, index = _parse(entries, 0, entries[0][0])
    if index != len(entries):
        raise YamlError(f"разбор остановился на строке {entries[index][2]}")
    return value


# ── что читает код ────────────────────────────────────────────────────────────


def _settings_fields() -> dict:
    """{ИМЯ ПЕРЕМЕННОЙ: имя поля} из объявления класса.

    Префикса у SettingsConfigDict нет, поэтому переменная — имя поля верхним
    регистром. Имена берутся из ast, а не из `Settings.model_fields`: так
    проверка видит ровно то объявление, из которого pydantic-settings выводит
    имя, и не зависит от того, что лежит в окружении прогона."""
    tree = ast.parse((BACKEND / "config.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Settings":
            return {
                statement.target.id.upper(): statement.target.id
                for statement in node.body
                if isinstance(statement, ast.AnnAssign)
                and isinstance(statement.target, ast.Name)
            }
    raise AssertionError("в config.py не найден класс Settings")


def _backend_env_reads() -> tuple:
    """Имена, которые backend читает из окружения, и имена хелперов-обёрток."""
    files = [
        path
        for path in sorted(BACKEND.rglob("*.py"))
        if not path.name.startswith("test_") and "alembic" not in path.parts
    ]
    trees = [ast.parse(path.read_text(encoding="utf-8")) for path in files]
    names = set()
    helpers = set()

    def literal(node):
        value = getattr(node, "value", None)
        return value if isinstance(value, str) else None

    def direct(node):
        if isinstance(node, ast.Call):
            called = ast.unparse(node.func)
            if called in ("os.environ.get", "os.getenv") and node.args:
                return literal(node.args[0])
            return None
        if isinstance(node, ast.Subscript) and ast.unparse(node.value) == "os.environ":
            return literal(node.slice)
        return None

    # проход 1: какие функции получают имя переменной параметром
    for tree in trees:
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            params = {arg.arg for arg in node.args.args}
            for inner in ast.walk(node):
                if (
                    isinstance(inner, ast.Call)
                    and ast.unparse(inner.func) in ("os.environ.get", "os.getenv")
                    and inner.args
                    and isinstance(inner.args[0], ast.Name)
                    and inner.args[0].id in params
                ):
                    helpers.add(node.name)

    # проход 2: прямые обращения и литералы, переданные хелперам
    for tree in trees:
        for node in ast.walk(tree):
            found = direct(node)
            if found:
                names.add(found)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id in helpers and node.args:
                    found = literal(node.args[0])
                    if found:
                        names.add(found)
    return names | set(_settings_fields()), helpers


def _frontend_env_reads() -> set:
    sources = (
        list((ROOT / "src").rglob("*.ts*"))
        + list(ROOT.glob("*.config.ts"))
        + list((ROOT / "scripts").glob("*.mjs"))
    )
    names = set()
    for path in sources:
        if ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        names |= set(IMPORT_META_ENV.findall(text))
        names |= set(PROCESS_ENV.findall(text))
    return names


# ── манифесты ─────────────────────────────────────────────────────────────────


def _env_names(node) -> set:
    """Имена из `environment:` в обеих формах: `- NAME=value` и `NAME: value`.

    Разбор имён берётся из `_env_assignments`, а не пишется вторым экземпляром:
    проверка «что названо» и проверка «что дошло до валидатора» обязаны видеть
    один и тот же набор, иначе переменная в незнакомой форме исчезнет из одной
    из них."""
    return {name for name, _value in _env_assignments(node, "environment")}


def _env_assignments(listing, origin: str) -> list:
    """Пары (имя, значение) из `environment:` в обеих формах.

    Скаляр обязано вернуть значение, а не строку разбора: `PGCONNECT_TIMEOUT:
    "10"` уйдёт в валидатор как 10, а не как «"10"`. Неизвестная форма —
    `NAME:` без значения или `NAME:` с отображением — поднимает YamlError:
    молча пропущенный ключ означал бы «переменная проверена», хотя не проверено
    ничего.
    """
    out = []
    if isinstance(listing, dict):
        for name, value in listing.items():
            if not ENV_WORD.match(name):
                continue
            if isinstance(value, dict):
                raise YamlError(f"{origin}: {name} задан отображением")
            if value is None:
                raise YamlError(f"{origin}: {name} без значения")
            out.append((name, str(value)))
    elif isinstance(listing, list):
        for item in listing:
            if isinstance(item, str) and "=" in item:
                name, _, value = item.partition("=")
                out.append((name.strip(), value.strip()))
            elif isinstance(item, dict):
                out.extend(_env_assignments(item, origin))
    return out


def _ci_env_blocks(ci: dict) -> list:
    """Env-блоки, которые видит наш код или раннер: workflow, job и шаг.

    Env у container services — другая поверхность: его читает образ, а не код
    проекта, и проверяется он тем же IMAGE_KNOBS, что и в compose. Смешать их
    значило бы требовать от Settings поля для POSTGRES_USER.
    """
    out = [ci.get("env") or {}]
    for body in (ci.get("jobs") or {}).values():
        if not isinstance(body, dict):
            continue
        out.extend(
            _ci_blocks({key: value for key, value in body.items() if key != "services"})
        )
    return [block for block in out if isinstance(block, dict)]


def _ci_containers(ci: dict) -> list:
    """Контейнерные сервисы job'ов: (образ, env, где объявлено).

    Сервис без env тоже возвращается: список должен отражать, сколько
    контейнеров разобралось, иначе пропажа env-блока выглядела бы как «лишнего
    никто не задаёт».
    """
    out = []
    for job, body in (ci.get("jobs") or {}).items():
        services = body.get("services") if isinstance(body, dict) else None
        for name, spec in (services or {}).items():
            if not isinstance(spec, dict):
                continue
            out.append(
                (spec.get("image", ""), spec.get("env") or {}, f"CI {job}: {name}")
            )
    return out


def _ci_env_assignments(ci: dict) -> list:
    """Пары (имя, значение) из env-блоков, адресованных коду проекта."""
    return [
        pair
        for block in _ci_env_blocks(ci)
        for pair in _env_assignments(block, "CI env")
    ]


def _anchor(compose: dict) -> dict:
    anchor = compose.get("x-backend")
    if not isinstance(anchor, dict):
        raise YamlError("в compose не разобран блок x-backend")
    return anchor


def _services(compose: dict) -> dict:
    """Сервисы compose с развёрнутым якорем `x-backend`.

    Compose применяет `<<: *backend` сам; ручной разбор обязан сделать то же,
    иначе окружение пяти сервисов выглядело бы пустым и проверка «compose не
    задаёт лишнего» молчала бы.
    """
    inherited_env = _env_names(_anchor(compose).get("environment"))
    out = {}
    for name, body in (compose.get("services") or {}).items():
        # копия: якорь разворачивается в ней, а разобранный документ остаётся
        # нетронутым — иначе «что названо в самом сервисе» читало бы якорь
        # вместе с сервисом и проверка дубляжа всегда была бы зелёной.
        body = dict(body) if isinstance(body, dict) else {}
        env_names = _env_names(body.get("environment"))
        declared_anchor = "<<" in body
        if declared_anchor:
            env_names |= inherited_env
            for key, value in _anchor(compose).items():
                body.setdefault(key, value)
        out[name] = {"env": env_names, "raw": body, "anchored": declared_anchor}
    return out


def _env_assignment_lists(compose: dict) -> list:
    """Списки `environment:` якоря и сервисов — для проверки дублей и значений."""
    out = [_anchor(compose).get("environment") or []]
    for body in _services(compose).values():
        out.append(body["raw"].get("environment") or [])
    return out


def _ci_values(node, key: str, out: list):
    if isinstance(node, dict):
        for name, value in node.items():
            if name == key:
                out.append(value)
            _ci_values(value, key, out)
    elif isinstance(node, list):
        for item in node:
            _ci_values(item, key, out)


def _ci_env_names(ci: dict) -> set:
    """Имена env, которые CI передаёт нашему коду.

    Берутся из того же разбора, что и значения в проверке валидаторами: блок,
    понятный одному месту и непонятный другому, не превращал бы «имя найдено» в
    «значение проверено» автоматически."""
    return {name for name, _value in _ci_env_assignments(ci)}


def _ci_blocks(body) -> list:
    out = []
    _ci_values(body, "env", out)
    return [block for block in out if isinstance(block, dict)]


def _ci_runs(ci: dict) -> list:
    out = []
    _ci_values(ci.get("jobs"), "run", out)
    return [value for value in out if isinstance(value, str)]


def _package_scripts() -> set:
    return set(json.loads(PACKAGE_JSON.read_text(encoding="utf-8")).get("scripts", {}))


def _tokens(command) -> list:
    if isinstance(command, list):
        return [str(item) for item in command]
    text = str(command).strip()
    if text.startswith("["):
        return re.findall(r'"([^"]*)"', text)
    return text.split()


def _command_texts(compose: dict) -> list:
    """Команды старта: сервисы compose плюс CMD и ENTRYPOINT образа — дефолтный
    контейнер запускают именно оттуда."""
    out = []
    for service, body in _services(compose).items():
        command = body["raw"].get("command")
        if command is not None:
            out.append((f"compose:{service}", _tokens(command)))
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    for key in ("CMD", "ENTRYPOINT"):
        for line in re.findall(rf"^{key}\s+(.*)$", dockerfile, re.M):
            out.append((f"Dockerfile {key}", _tokens(line)))
    return out


def _python_targets(tokens: list) -> list:
    return re.findall(r"python3?\s+([A-Za-z0-9_./-]+\.py)", " ".join(tokens))


def _uvicorn_targets(tokens: list) -> list:
    joined = " ".join(tokens)
    if "uvicorn" not in joined:
        return []
    return re.findall(r"\b([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)\b", joined)


def _npm_run_targets(tokens: list) -> set:
    return set(re.findall(r"npm run ([a-zA-Z0-9_:]+)", " ".join(tokens)))


def _defines(path: Path, attribute: str) -> bool:
    if not path.is_file():
        return False
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == attribute
            for target in node.targets
        ):
            return True
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id == attribute:
                return True
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if node.name == attribute:
                return True
    return False


def _copy_sources() -> list:
    """Истоки COPY из Dockerfile. Форма поддерживают ровно три — точный путь,
    каталог и `каталог/*.расширение`; четвёртая заставила бы гейт молчать."""
    out = []
    for line in re.findall(
        r"^COPY\s+(.*)$", DOCKERFILE.read_text(encoding="utf-8"), re.M
    ):
        parts = [part for part in line.split() if not part.startswith("--")]
        if len(parts) < 2:
            raise YamlError(f"COPY разобралась не полностью: {line!r}")
        out.extend(parts[:-1])
    return out


def _is_copied(relative: str) -> bool:
    """Подпадает ли `backend/<relative>` под COPY из Dockerfile.

    Ответ строится по фактическим маскам, а не по «мы же копируем backend»:
    файл в подкаталоге, которого нет ни в одной COPY-строке, в образ не
    попадёт, и `python predict_resolver.py` упадёт там, где все тесты зелёные.
    """
    directory, _, name = relative.rpartition("/")
    for source in _copy_sources():
        if source in {"backend", "backend/"}:
            return True
        if source == f"backend/{relative}":
            return True
        if source.endswith("/") and source == f"backend/{directory}/":
            return True
        stem, sep, tail = source.partition("/")
        if sep and stem == "backend" and not directory and tail.startswith("*"):
            if fnmatch.fnmatchcase(name, tail):
                return True
    return False


class Manifest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compose = parse_yaml(COMPOSE.read_text(encoding="utf-8"))
        cls.ci_text = CI.read_text(encoding="utf-8")
        cls.ci = parse_yaml(cls.ci_text)
        cls.backend_reads, cls.helpers = _backend_env_reads()
        cls.frontend_reads = _frontend_env_reads()
        cls.services = _services(cls.compose)
        cls.ci_env = _ci_env_names(cls.ci)
        cls.package_scripts = _package_scripts()
        cls.commands = _command_texts(cls.compose)
        cls.fields = _settings_fields()
        # Подставляются только кодовые дефолты. Обязательное поле имело бы
        # значение PydanticUndefined, и Settings() падал бы на нём, а не на
        # значении из манифеста — проверка показывала бы разбор, а не настройку.
        cls.defaults = {
            name: spec.default
            for name, spec in Settings.model_fields.items()
            if not spec.is_required()
        }
        cls.ci_containers = _ci_containers(cls.ci)


class TestScannersAreNotBlind(Manifest):
    def test_everything_the_gate_counts_is_actually_found(self):
        """Пустой разбор сделал бы все проверки ниже зелёными навсегда. Это
        единственная проверка, которая обязана краснеть от удаления строк из
        манифестов, а не от их правки."""
        self.assertGreaterEqual(len(self.services), 7, "compose не разобран")
        self.assertGreaterEqual(
            len(self.backend_reads),
            30,
            f"backend читает только {len(self.backend_reads)} имён",
        )
        self.assertGreaterEqual(
            len(self.frontend_reads), 6, "VITE-переменные не найдены"
        )
        self.assertGreaterEqual(len(self.ci_env), 6, "CI-переменные не найдены")
        self.assertGreaterEqual(
            len(self.ci_containers), 2, "container services CI не разобраны"
        )
        self.assertGreaterEqual(len(self.package_scripts), 8, "scripts не прочитаны")
        self.assertGreaterEqual(len(self.commands), 6, "команды старта не найдены")
        for name in (
            "WAKE_DATABASE_URL",
            "TELEGRAM_BOT_TOKEN",
            "LIGHTER_ACCOUNT_INDEX",
        ):
            self.assertIn(name, self.backend_reads, f"{name} не найден сканером")
        self.assertIn("VITE_BACKEND_URL", self.frontend_reads)
        self.assertIn("_env_number", self.helpers, "хелпер имён окружения не найден")

    def test_compose_parsing_reaches_the_keys_the_gate_reads(self):
        """`command:` и `image:` обязаны доходить до разбора, иначе проверки
        «цель команды существует» и «версии совпадают» молчат."""
        for service, key in (
            ("postgres", "image"),
            ("telegram-bot", "command"),
            ("app", "environment"),
            ("migrate", "command"),
            ("signing", "ports"),
        ):
            self.assertIn(key, self.services[service]["raw"], f"{service}: {key}")
        self.assertTrue(
            self.services["telegram-bot"]["env"],
            "якорь x-backend не развернулся в окружение сервиса",
        )


class TestEnvironmentIsRead(Manifest):
    def _unattributed(self, names, image=None):
        allowed = self.backend_reads | self.frontend_reads
        if image:
            allowed |= IMAGE_KNOBS.get(image.split(":")[0], set())
        return sorted(name for name in names if name not in allowed)

    def test_compose_sets_nothing_the_stack_ignores(self):
        silent = {}
        for service, body in self.services.items():
            bad = self._unattributed(body["env"], image=body["raw"].get("image"))
            if bad:
                silent[service] = bad
        self.assertEqual(
            silent,
            {},
            "compose задаёт переменные, которые никто не читает: значение "
            "выставлено, поведение не меняется",
        )

    def test_ci_sets_nothing_the_stack_ignores(self):
        allowed = (
            self.backend_reads
            | self.frontend_reads
            | set(RUNNER_KNOBS)
            | {name.upper() for name in ACTION_ENV_REF.findall(self.ci_text)}
        )
        bad = sorted(name for name in self.ci_env if name not in allowed)
        self.assertEqual(
            bad,
            [],
            "CI объявляет переменные, которые не читает ни код проекта, ни раннер",
        )

    def test_no_variable_is_set_both_in_the_anchor_and_in_a_service(self):
        """Якорь и сервис с одним именем: compose берёт сервисный, и у одного
        backend-процесса оказывается своя настройка. Заголовок docker-compose
        называет это багом — здесь он становится падающим тестом."""
        anchor_names = _env_names(_anchor(self.compose).get("environment"))
        overlap = {}
        for service, body in self.services.items():
            if not body["anchored"]:
                continue
            repeated = sorted(anchor_names & _own_env_names(self.compose, service))
            if repeated:
                overlap[service] = repeated
        self.assertEqual(overlap, {}, "переменная продублирована из якоря в сервис")

    def test_manifest_values_pass_the_real_validators(self):
        """Значения compose и CI прогоняются через валидаторы Settings.

        Проверяется не «переменная существует», а «то, что написано в
        манифесте, приложение принимает». Подстановка `${X:-дефолт}` берётся
        своим дефолтом — на ней стартует свежий клон. Остальные поля фиксируются
        кодовыми значениями по умолчанию, чтобы исход проверки не зависел от
        окружения прогона. Выражения раннера (`${{ … }}`) пропускаются: их
        статически не вычислить, и имя такого env проверяется отдельно.
        """
        values = {}
        origins = {}
        for listing in _env_assignment_lists(self.compose):
            for name, value in _env_assignments(listing, "compose"):
                values.setdefault(name, value)
                origins.setdefault(name, "compose")
        for name, value in _ci_env_assignments(self.ci):
            values.setdefault(name, value)
            origins.setdefault(name, "CI")

        problems = []
        checked = set()
        for name, value in sorted(values.items()):
            field = self.fields.get(name)
            if field is None or name in NOT_VALIDATED:
                continue
            if "${{" in value:
                continue
            match = INTERPOLATION.match(value)
            literal = match.group(1) if match else value
            try:
                kwargs = dict(self.defaults)
                kwargs[field] = literal
                Settings(_env_file=None, **kwargs)
            except Exception as error:  # форма отказа не важна, важен сам факт
                problems.append(
                    f"{name}={literal!r} из {origins[name]}: "
                    f"{type(error).__name__}: {error}"
                )
            checked.add(name)
        self.assertEqual(
            problems, [], "манифест задаёт значение, которое код отвергает"
        )
        # Сеть — единственная настройка compose со списком допустимых значений,
        # токен — единственная строка CI, доходящая до поля Settings. Если
        # который-то из них пропадёт из `checked`, значит один из манифестов
        # перестал разбираться, а не то, что значений стало меньше.
        self.assertTrue(
            {"WAKE_LIGHTER_NETWORK", "TELEGRAM_BOT_TOKEN"} <= checked,
            f"до валидаторов дошло только {sorted(checked)} — разбор манифеста не тот",
        )

    def test_ci_service_containers_set_only_image_knobs(self):
        """Env контейнерных сервисов CI читает образ, а не наш код: POSTGRES_DB
        для postgres и POSTGRES_* для mysql — это разные вселенные, и проверка
        обязана знать, чей это knob."""
        silent = []
        for image, listing, label in self.ci_containers:
            allowed = IMAGE_KNOBS.get(image.split(":")[0], set())
            silent += [
                f"{label}: {name}"
                for name, _value in _env_assignments(listing, label)
                if name not in allowed
            ]
        self.assertEqual(
            silent,
            [],
            "CI задаёт контейнеру переменную, которую его образ не читает",
        )

    def test_image_knobs_are_exhausted_by_the_services_that_use_them(self):
        used = set()
        for body in self.services.values():
            repo = body["raw"].get("image", "").split(":")[0]
            used |= IMAGE_KNOBS.get(repo, set()) & body["env"]
        for image, listing, _label in self.ci_containers:
            allowed = IMAGE_KNOBS.get(image.split(":")[0], set())
            used |= allowed & {name for name, _value in _env_assignments(listing, "ci")}
        for repo, knobs in IMAGE_KNOBS.items():
            for name in knobs:
                self.assertIn(
                    name,
                    used,
                    f"{name} в списке переменных образа {repo}, но её никто не задаёт",
                )

    def test_runner_exceptions_are_few_and_each_explained(self):
        for name, reason in RUNNER_KNOBS.items():
            self.assertTrue(reason.strip(), f"{name} исключён без причины")
            if name not in self.ci_env:
                self.assertNotIn(
                    name, self.ci_text, f"{name} в списке knobs, но в CI её давно нет"
                )


def _own_env_names(compose: dict, service: str) -> set:
    """Имена, названные в самом сервисе, без наследования от якоря."""
    body = (compose.get("services") or {}).get(service) or {}
    return _env_names(body.get("environment"))


class TestCommandsResolve(Manifest):
    def test_start_files_exist_and_are_shipped(self):
        missing = []
        for origin, tokens in self.commands:
            for path in _python_targets(tokens):
                if not (BACKEND / path).is_file():
                    missing.append(f"{origin}: backend/{path}")
                elif not _is_copied(path):
                    missing.append(f"{origin}: backend/{path} не попадает в образ")
        self.assertEqual(
            missing,
            [],
            "контейнер зовёт файл, которого нет — или которого нет в образе",
        )

    def test_uvicorn_targets_name_a_real_app_object(self):
        bad = []
        for _origin, tokens in self.commands:
            for module, attribute in _uvicorn_targets(tokens):
                path = BACKEND / f"{module}.py"
                if not path.is_file():
                    bad.append(f"{module}:{attribute} — модуля нет")
                elif not _defines(path, attribute):
                    bad.append(f"{module}:{attribute} — attr не объявлен")
        self.assertEqual(bad, [], "uvicorn зовёт attr, которого модуль не объявляет")

    def test_alembic_runs_where_its_config_lives(self):
        self.assertTrue(
            any("alembic" in tokens for _origin, tokens in self.commands),
            "ни один сервис не запускает alembic — схему поднимает кто-то другой",
        )
        self.assertTrue((BACKEND / "alembic.ini").is_file())
        self.assertTrue((BACKEND / "alembic" / "versions").is_dir())
        self.assertTrue(
            _is_copied("alembic.ini"), "alembic.ini не попадает в образ миграций"
        )

    def test_npm_scripts_named_by_the_stack_exist(self):
        referenced = set()
        for _origin, tokens in self.commands:
            referenced |= _npm_run_targets(tokens)
        referenced |= set(re.findall(r"npm run ([a-zA-Z0-9_:]+)", self.ci_text))
        self.assertTrue(referenced, "ни одного `npm run` не найдено — разбор сломался")
        unknown = sorted(
            name for name in referenced if name not in self.package_scripts
        )
        self.assertEqual(
            unknown, [], "манифест зовёт npm-скрипт, которого нет в package.json"
        )

    def test_dependencies_name_services_that_exist(self):
        names = set(self.services)
        broken = []
        for service, body in self.services.items():
            depends = body["raw"].get("depends_on")
            targets = (
                depends
                if isinstance(depends, list)
                else list(depends)
                if isinstance(depends, dict)
                else []
            )
            broken += [f"{service} -> {t}" for t in targets if t not in names]
        self.assertEqual(broken, [], "depends_on ссылается на несуществующий сервис")

    def test_ci_runs_the_whole_backend_suite(self):
        """`pytest test_chosen.py` оставил бы job зелёным на части дерева; шаг
        обязан запускать каталог."""
        lines = [
            line.strip()
            for run in _ci_runs(self.ci)
            for line in run.splitlines()
            if "pytest" in line
        ]
        self.assertTrue(lines, "в CI не найдено запуска pytest")
        narrowed = [
            line for line in lines if re.search(r"pytest\s+\S*test_[a-z_]+\.py", line)
        ]
        self.assertEqual(narrowed, [], "CI сужает прогон до отдельных файлов")
        self.assertTrue(
            any(re.search(r"pytest\s+\.", line) for line in lines),
            "CI не запускает каталог тестов целиком",
        )


class TestVersionsMatch(Manifest):
    def _image(self, service: str) -> str:
        return self.services[service]["raw"].get("image", "")

    def test_infrastructure_images_are_the_same_in_compose_and_ci(self):
        ci_images = set(re.findall(r"image:\s*([A-Za-z0-9_.:/-]+)", self.ci_text))
        drift = []
        for service in ("postgres", "redis"):
            here = self._image(service)
            self.assertTrue(here, f"у сервиса {service} нет image:")
            repo = here.split(":")[0]
            remote = [image for image in ci_images if image.split(":")[0] == repo]
            self.assertEqual(
                len(remote),
                1,
                f"в CI образ {repo} встречается {len(remote)} раз — сверять нечего",
            )
            if remote[0] != here:
                drift.append(f"{repo}: compose {here}, CI {remote[0]}")
        self.assertEqual(
            drift,
            [],
            "тесты гоняются против другой версии инфраструктуры, чем та, что "
            "поднимает docker compose up",
        )

    def test_node_of_the_dev_stack_is_the_node_ci_builds_with(self):
        declared = re.findall(r'NODE_VERSION:\s*"?(\d+)"?', self.ci_text)
        self.assertEqual(len(declared), 1, "версия Node в CI объявлена не один раз")
        image = self._image("frontend")
        self.assertTrue(image.startswith("node:"), f"frontend собрался из {image!r}")
        major = image.split(":")[1].split("-")[0]
        self.assertEqual(
            major,
            declared[0],
            "compose поднимает dev-сервер на другом мажоре Node, чем CI собирает бандл",
        )

    def test_dockerfile_interpreter_is_the_one_ci_tests_on(self):
        """Прод-образ обязан крутиться на том же Python, на котором CI гоняет
        тесты.

        Прежняя проверка требовала меньшего: она сверяла, что обе версии
        названы в таблице окружения CONTRIBUTING, — то есть легитимировала
        расхождение, а не запрещала его. Класс от этого не исчез: dependabot
        поднял базу образа на минор, на котором не выполнялся ни один тест
        (b0f70da — 3.12-slim → 3.14-slim), и CI остался зелёным, потому что
        `docker-build` собирает образ и делает в нём только `import app` плюс
        `alembic heads`. Расхождение в интерпретаторе не производит ошибку в
        коде — оно производит прод, о котором зелёный прогон ничего не знает."""
        tags = sorted(
            set(
                re.findall(
                    r"^FROM\s+python:([0-9.]+)-slim",
                    DOCKERFILE.read_text(encoding="utf-8"),
                    re.M,
                )
            )
        )
        self.assertEqual(len(tags), 1, f"стадии Dockerfile разошлись по Python: {tags}")
        ci_python = re.findall(r'PYTHON_VERSION:\s*"?([0-9.]+)"?', self.ci_text)
        self.assertEqual(len(ci_python), 1, "версия Python в CI объявлена не один раз")
        self.assertEqual(
            tags[0],
            ci_python[0],
            f"прод идёт на Python {tags[0]}, а тесты — на {ci_python[0]}: "
            "зелёный CI про этот образ ничего не утверждает",
        )
        manual = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
        # Номер остаётся названным и в таблице: человек ставит интерпретатор
        # руками, и он должен совпадать с тем, что собирается в прод.
        self.assertIn(
            f"python:{tags[0]}-slim", manual, "в таблице окружения нет runtime-тега"
        )
        self.assertIn(
            ci_python[0],
            manual,
            "в таблице окружения нет версии Python, на которой CI гоняет pytest",
        )


class TestComposeShape(Manifest):
    def test_env_file_target_has_a_copyable_example(self):
        """compose читает `backend/.env`, которого в репозитории нет, и обязан
        помечать его необязательным — и держать рядом пример, который копируют."""
        entries = _anchor(self.compose).get("env_file")
        self.assertTrue(entries, "у backend-сервисов нет env_file")
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            path = ROOT / entry.get("path", "")
            self.assertIn(
                str(entry.get("required", "false")).lower(),
                {"false", "optional"},
                f"{entry.get('path')} помечен обязательным, а файла в репозитории нет",
            )
            example = path.with_name(f"{path.stem}.example")
            self.assertTrue(
                example.is_file(),
                f"compose ждёт {path}, а образца {example} нет — скопировать нечего",
            )

    def test_session_secret_is_not_a_plain_literal_in_the_stack(self):
        values = re.findall(
            r"WAKE_SESSION_SECRET=([^\n]+)", COMPOSE.read_text(encoding="utf-8")
        )
        self.assertTrue(values, "compose не задаёт WAKE_SESSION_SECRET")
        for value in values:
            self.assertTrue(
                value.startswith("${WAKE_SESSION_SECRET"),
                f"секрет сессии задан литералом: {value!r}",
            )
            self.assertIn(
                ":-", value, "подстановка без дефолта упрётся в пустую строку"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
