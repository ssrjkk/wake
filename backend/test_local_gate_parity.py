"""Локальный гейт против шагов CI: «я прогнал полный гейт» обязано значить то же, что зелёный прогон.

Запуск: python -m pytest test_local_gate_parity.py -v

Повод. CI на bfeb048 покраснел на шаге `ruff format --check`, которого не было
в локальном прогоне: локально были `ruff check` и весь pytest-набор, и оба
зелёные. Шаг формата стоит в CI отдельным шагом, и пока «полный гейт» был
списком в голове и абзацем в CONTRIBUTING, голова могла этот список сократить.
Дополнительно `needs: [backend-lint]` унесла в пропуск и backend-tests, и
docker-build, так что локальный «всё зелёное» описывал коммит, которого CI не
проверял вовсе.

`scripts/gate.sh` закрывает это: каждый его шаг помечен строкой
`# ci: <job> / <name>` с дословным именем шага из workflow, и этот файл сверяет
метки с workflow. Классы, которые здесь проверяются:

  * шаг добавлен в CI и не зеркален локально — локальный гейт молча прогоняет
    меньше, чем принимает релиз;
  * шаг CI переименован или удалён, а метка осталась — метка становится
    украшением, и проверка перестаёт что-либо требовать;
  * метка есть, а команды за ней нет (или команда — `echo ok`): формальное
    присутствие шага, ничего не проверяющее;
  * команда та же, а область меньше: `pytest test_config.py` вместо `pytest .`
    даёт идентичный набор инструментов и зелёный локальный прогон там, где CI
    краснеет на другом файле;
  * команда та же, а требований меньше: из smoke-шага съеден один адрес или
    одна ожидаемая копия ошибки — `curl` и `grep` на месте, проверок меньше;
  * значение, живущее в CI, продублировано в скрипте числом — пин уедет вперёд,
    а локальный прогон останется требовать старого;
  * allowlist «это окружение, а не проверка» протух: запись ведёт на шага,
    которого в workflow уже нет, и следующий такой же шаг пройдёт по инерции;
  * список `--ignore-vuln` и таблицы исключений в SECURITY.md разошлись:
    снятое исключение продолжает читаться как действующий риск, а новое
    появляется в красном логе без объяснения;
  * документ парный, и значение из CI процитировано только в одной половине:
    по файлу целиком расхождение не видно, а решение принимает читатель одной
    из половин;
  * перечень кодов выхода разошёлся со сводкой скрипта: «проверено не всё,
    остальное смотрит CI» и «всё, что умеет эта машина, зелёное» различаются
    одним числом в последней строке, и подменить его — значит получить
    ложнозелёный гейт при полностью исправных шагах;
  * страж окружения сверяет не имя, а хвост строки: `?sslmode=require` и
    пустой путь обходят запрет продакшной базы, и проверить это чтением файла
    нельзя — скрипт запускают.

Разбор YAML общий с test_deployment_manifest.py: свой, без PyYAML (тот не в
requirements.txt и не должен попадать в продакшн-образ), и ровно для тех форм,
которыми написан workflow.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from db_url import database_name
from test_deployment_manifest import parse_yaml

ROOT = Path(__file__).resolve().parent.parent
CI_FILE = ROOT / ".github" / "workflows" / "ci.yml"
GATE_FILE = ROOT / "scripts" / "gate.sh"
CONTRIBUTING_FILE = ROOT / "CONTRIBUTING.md"
SECURITY_FILE = ROOT / "SECURITY.md"
GITATTRIBUTES_FILE = ROOT / ".gitattributes"

# Сколько шагов с `run:` обязан видеть разбор. Без пола опустевший workflow или
# опустевший скрипт давали бы зелёный гейт на пустом множестве.
RUN_STEPS_FLOOR = 20
MIRRORED_FLOOR = 12
# Причина в allowlist обязана быть текстом, а не заглушкой: список без причин
# превращается в то же самое, чем был список «Старые имена» в теме.
REASON_MIN = 30

# Шаги, которые ничего не проверяют, а готовят окружение прогону, плюс один,
# собирающий артефакт. Каждый — с причиной: allowlist без причин превращается в
# то же самое, чем был список «Старые имена» в теме, — место, куда прячут то,
# что не хочется разбирать.
SETUP_STEPS = {
    ("backend-lint", "Install Ruff"): (
        "ставит инструмент; его версию gate.sh берёт из пина этого же workflow и "
        "отказывается считать прогон, если локальный ruff другой"
    ),
    ("backend-security", "Install pip-audit"): (
        "ставит сканер; сама проверка — следующий шаг, и он зеркален"
    ),
    ("backend-tests", "Install dependencies"): (
        "ставит пакеты из requirements.txt; проверка содержимого этого файла "
        "живёт в test_deployment_manifest.py и в шаге аудита"
    ),
    ("backend-tests", "Create the pytest database"): (
        "создаёт базу wake_test через psql; на машине без psql это делает "
        "ops-путь, а гейт требует WAKE_TEST_DATABASE_URL и проверяет имя базы"
    ),
    ("backend-tests", "Generate Allure report"): (
        "собирает html-отчёт из уже полученного результата тестов; ни один "
        "контракт проекта от его сборки не зависит"
    ),
    ("frontend-check", "npm ci"): (
        "разворачивает node_modules из package-lock.json; совпадение замка и "
        "манифеста проверяют шаги аудита и сборки"
    ),
    ("frontend-tests", "npm ci"): (
        "тот же установитель в другом job: артефакты джобов не пересекаются, и "
        "в каждом он окружение, а не проверка"
    ),
    ("e2e-tests", "npm ci"): ("тот же установитель в job прогона Playwright"),
    ("e2e-tests", "npx playwright install --with-deps chromium"): (
        "ставит браузер и системные зависимости; версия браузера закреплена в "
        "package-lock.json, а не в этом списке"
    ),
}

# Управление оболочкой: после этих слов команда ещё не названа, поэтому поиск
# продолжается со следующим словом.
CONTROL = frozenset(
    {
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "in",
        "break",
        "continue",
        "eval",
        "exec",
    }
)
# Оформление, а не проверка: вывод в лог, подготовка окружения и убийтие
# процесса. Здесь поиск обрывается, а не продолжается: аргумент `echo` — это
# текст в логе, а не инструмент, которым шаг что-то сверяет (`echo "$ready"`
# дал бы «готовность проверяет команда ready»).
DISPLAY = frozenset(
    {
        "echo",
        "printf",
        "exit",
        "return",
        "true",
        "false",
        "set",
        "local",
        "export",
        "sleep",
        "seq",
        "tail",
        "head",
        "cat",
        "trap",
        "cd",
        "mkdir",
        "kill",
        "wait",
        "rm",
        "ps",
    }
)

MARKER = re.compile(r"^\s*#\s*ci:\s*(?P<job>[a-z0-9-]+)\s*/\s*(?P<name>.+?)\s*$")
CALL = re.compile(
    r'^\s*(?P<kind>step|unavailable)\s+"(?P<job>[^"]+)"\s+"(?P<name>[^"]+)"'
)
# Имя шага — метаданные, а не команда: без снятия префикса `ruff format`
# находил бы `format` в самом имени и прощал локальному шагу `ruff check`.
CALL_LABELS = re.compile(r'^\s*(?:step|unavailable)\s+"[^"]*"\s+"[^"]*"\s*')
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=(?P<rest>.*)$")
SUBSTITUTION = re.compile(r"^\$\((?P<rest>.*)$")
SPLIT = re.compile(r"&&|\|\||;|\||\n")


def run_steps(ci: dict) -> dict:
    """{(job, имя_или_команда): текст команды} для всех шагов с `run:`.

    Безымянный шаг получает своим ключом текст команды: `npm ci` в трёх job — три
    разных шага, и все три обязаны быть названы в allowlist, если не зеркалятся.
    """
    out = {}
    for job, body in ci["jobs"].items():
        for step in body.get("steps") or []:
            if not isinstance(step, dict) or "run" not in step:
                continue
            name = step.get("name") or " ".join(str(step["run"]).split())
            out[(job, name)] = str(step["run"])
    return out


def _bound_call(lines: list, index: int):
    """Вызов, к которому привязана метка на строке index.

    Пустые строки и комментарии между меткой и вызовом разрешены: метка
    обычно стоит над абзацем, объясняющим, почему шаг зеркалится именно так.
    Поиск обрывается на второй метке — иначе метка одного шага привязалась бы к
    чужому вызову и притворилась зеркалом.
    """
    bound = index + 1
    while bound < len(lines):
        stripped = lines[bound].strip()
        if not stripped:
            bound += 1
            continue
        if MARKER.match(lines[bound]):
            return None
        if stripped.startswith("#"):
            bound += 1
            continue
        return CALL.match(lines[bound])
    return None


def gate_markers(text: str) -> dict:
    """{шаг: текст вызова}, где шаг — метка `# ci: <job> / <name>`.

    Область вызова — от строки с `step …`/`unavailable …` до следующей метки.
    Метка без такого вызова за ней в словарь не попадает: её видно из
    `unbound_markers`.
    """
    lines = text.splitlines()
    marks = [
        (i, m.group("job"), m.group("name"))
        for i, line in enumerate(lines)
        if (m := MARKER.match(line))
    ]
    out = {}
    for index, job, name in marks:
        match = _bound_call(lines, index)
        if not match or match.group("job") != job or match.group("name") != name:
            continue
        bound = next(i for i in range(index + 1, len(lines)) if CALL.match(lines[i]))
        end = len(lines)
        for later in marks:
            if later[0] > bound:
                end = min(end, later[0])
        region = "\n".join(
            CALL_LABELS.sub("", line) if i == bound else line
            for i, line in enumerate(lines[bound:end], start=bound)
            if line.strip() and not line.strip().startswith("#")
        )
        out[(job, name)] = region
    return out


def doc_table(markdown: str, heading: str) -> dict:
    """{первая_колонка: вторая_колонка} таблицы под заголовком, `{}` — таблицы нет.

    Разбираются только те две колонки, которые здесь значат: имена джобов с их
    содержанием и имена инструментов с их пином. Разделитель и строку заголовка
    markdown даёт те же `|`, поэтому первая строка таблицы отбрасывается, а не
    угадывается по содержимому.
    """
    lines = markdown.splitlines()
    starts = [
        index
        for index, line in enumerate(lines)
        if line.strip() == heading and line.startswith("## ")
    ]
    if not starts:
        return {}
    rows = []
    for line in lines[starts[0] + 1 :]:
        if line.startswith("## "):
            break
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if all(set(cell) <= set("-: ") for cell in cells):
            continue
        rows.append(cells)
    return {cells[0]: cells[1] for cells in rows[1:] if len(cells) > 1}


# Таблицы исключений pip-audit в SECURITY.md: по одной на язык. Разделы уровня
# `###`, а не `##`, поэтому doc_table здесь не годится — он ищет ровно `## `.
AUDIT_HEADINGS = ("### Dependency auditing", "### Проверка зависимостей")
ADVISORY_ID = re.compile(r"(?:CVE|PYSEC)-[0-9]{4}-[0-9]+")


def advisory_rows(markdown: str, heading: str) -> list:
    """Строки таблицы под заголовком как [(первый_ид, второй_ид, описание)].

    Берутся только трёхколоночные строки: таблица, из которой убрали колонку с
    PYSEC, — это ровно тот случай, который нужно заметить, а не разобрать.
    """
    lines = markdown.splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() == heading]
    if not starts:
        return []
    rows = []
    for line in lines[starts[0] + 1 :]:
        if line.startswith("#"):
            break
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if all(set(cell) <= set("-: ") for cell in cells):
            continue
        rows.append(cells)
    return [row for row in rows[1:] if len(row) == 3]


def advisory_findings(markdown: str, excluded: set) -> list:
    """Чем таблицы исключений в SECURITY.md расходятся со списком из ci.yml.

    Проверяются обе половины документа: решение «это уже снято, можно убирать
    --ignore-vuln» принимается по той из них, которую человек читает, и
    устаревшая половина опасна ровно как отсутствующая.
    """
    found = []
    for heading in AUDIT_HEADINGS:
        rows = advisory_rows(markdown, heading)
        if not rows:
            found.append(
                f"{heading}: таблица исключений не читается, "
                f"а в ci.yml их {len(excluded)}"
            )
            continue
        for row in rows:
            if not (ADVISORY_ID.fullmatch(row[0]) and ADVISORY_ID.fullmatch(row[1])):
                found.append(
                    f"{heading}: строка «{row[0]}» — идентификаторы не в двух первых колонках"
                )
            if not row[2]:
                found.append(f"{heading}: {row[0]} без описания затронутого пути")
        named = {cell for row in rows for cell in row[:2]}
        if len(named) != 2 * len(rows):
            found.append(
                f"{heading}: {len(rows)} строк, уникальных идентификаторов меньше — "
                "одно исключение названо дважды"
            )
        for missing in sorted(excluded - named):
            found.append(f"{heading}: {missing} исключена в CI, но в таблице её нет")
        for extra in sorted(named - excluded):
            found.append(
                f"{heading}: {extra} названа в таблице, но ci.yml её не исключает"
            )
    return found


def eol_rules(attributes: str) -> dict:
    """{шаблон: текст правила} из .gitattributes; комментарии и пустые строки — вне."""
    rules = {}
    for line in attributes.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        head, _, rest = line.partition(" ")
        rules[head] = rest.strip()
    return rules


def bash_path(path: Path) -> str:
    """Путь, который Git Bash понимает как абсолютный.

    `as_posix` даёт «C:/…», а для bash это относительный путь: подставленный в
    TMPDIR он заставил бы `mktemp` создать дерево «C:/…» внутри репозитория.
    """
    text = path.as_posix()
    if re.match(r"^[A-Za-z]:/", text):
        return "/" + text[0].lower() + text[2:]
    return text


def language_halves(markdown: str) -> dict:
    """{заголовок верхнего уровня: текст раздела} — по одной половине на язык.

    Строки внутри ``` во внимание не берутся: в этих документах в блоках кода
    стоят shell-комментарии, и каждый такой `# ` открыл бы половину, которой нет.
    Сверка по половинам нужна потому, что документ парный: проверка всего файла
    сразу прошла бы, если бы одна половина устарела, — а решает человек ту,
    которую читает.
    """
    halves = {}
    title = None
    buffer = []
    fence = False
    for line in markdown.splitlines():
        if line.startswith("```"):
            fence = not fence
        if not fence and line.startswith("# "):
            if title is not None:
                halves[title] = "\n".join(buffer)
            title, buffer = line[2:].strip(), [line]
            continue
        buffer.append(line)
    if title is not None:
        halves[title] = "\n".join(buffer)
    return halves


def shell_function(text: str, name: str) -> str:
    """Исходник одной функции gate.sh — чтобы проверять разбор, не запуская прогон.

    Это не пересказ правила регуляркой: извлечённое тело исполняется оболочкой
    ровно так, как оно исполняется внутри скрипта. Заголовок ищется дословно, и
    если функцию переименовали или перенесли, разбор отдаёт пустую строку —
    тест краснеет на проверке «тело найдено», а не молча сравнивает пустое с
    пустым.
    """
    lines = text.splitlines()
    head = f"{name}() {{"
    try:
        start = next(i for i, line in enumerate(lines) if line == head)
    except StopIteration:
        return ""
    for index in range(start + 1, len(lines)):
        if lines[index] == "}":
            return "\n".join(lines[start : index + 1])
    return ""


def unbound_markers(text: str) -> list:
    """Метки, за которыми нет вызова с тем же job и именем."""
    lines = text.splitlines()
    loose = []
    for index, line in enumerate(lines):
        marker = MARKER.match(line)
        if not marker:
            continue
        call = _bound_call(lines, index)
        if (
            not call
            or call.group("job") != marker.group("job")
            or call.group("name") != marker.group("name")
        ):
            loose.append((marker.group("job"), marker.group("name")))
    return loose


def _word(raw: str) -> str:
    """Слово в командной позиции: раскрыты присваивание и подставление, сняты кавычки.

    `ready=$(curl …)` остаётся `curl`, `"$code"` — `code`, `$(seq 1 40)` — `seq`.
    """
    word = raw.strip("\"'`(){}")
    assignment = ASSIGNMENT.match(word)
    if assignment:
        word = assignment.group("rest")
    substitution = SUBSTITUTION.match(word)
    if substitution:
        word = substitution.group("rest")
    return word.strip("\"'`(){}").replace("$", "").lower()


def command_heads(run_text: str) -> set:
    """Команды шага и их подкоманды — минус оболочечный шум.

    Позиция команды — начало любой строки и всё после `&&`, `||`, `;`, `|`.
    Ведущие ключевые слова (`if`, `for`, `then`) и присваивания сдвигают поиск
    до первого настоящего инструмента: `if pip install …` проверяет `pip`, а
    `ready=$(curl …)` — `curl`, иначе подставление маскировало бы то, чем шаг
    что-то сверяет.

    За именем команды добавляется первое «голое» слово: `ruff check` и
    `ruff format` — один инструмент, и без подкоманды локальный гейт мог бы
    зеркалить шаг формата его же линтером и называть это зелёным. Берётся
    ровно одно слово, а не весь хвост: он определяет, что именно делает
    команда, а `docker tag` после `docker build` — книговодство CI по тегам,
    которого локальный прогон требовать не должен. Пути, адреса и числа в
    подкоманду не попадают, поэтому локальный шаг сохраняет право на свой порт
    и свой тег образа.
    """
    heads = set()
    for chunk in SPLIT.split(run_text):
        words = chunk.split()
        for position, raw in enumerate(words):
            word = _word(raw)
            if not word:
                continue
            if word.startswith("-"):
                # Флаг продолжает команду предыдущей строки: `--ignore-vuln
                # CVE-…` не второй инструмент шага, а его аргумент.
                break
            if word in CONTROL:
                continue
            if word in DISPLAY:
                break
            if not re.fullmatch(r"[a-z0-9_.@/-]{2,}", word):
                break
            heads.add(word)
            for following in words[position + 1 :]:
                token = _word(following)
                if (
                    not token
                    or token.startswith("-")
                    or token in CONTROL
                    or token in DISPLAY
                ):
                    continue
                if re.fullmatch(r"[a-z][a-z0-9_-]{2,}", token):
                    heads.add(token)
                break
            break
    return heads


# Аргумент-мишень pytest: путь, каталог, глоб или имя модуля — в том числе
# относительный (`../`). Флаг (`-q`), шум переноса (`\`) и редирект (`2>&1`)
# мишенью быть не могут: первый символ класса намеренно без дефиса, иначе `-q`
# превратился бы в мишень и однострочный локальный шаг перестал бы совпадать с
# многострочным CI-шагом, где флаг уезжает в другую строку.
PATHISH = re.compile(r"^[A-Za-z0-9_.*][A-Za-z0-9_.*/-]*$")
TEST_FILE = re.compile(r"test_[A-Za-z0-9_]+\.py$")


def pytest_targets(run_text: str) -> set:
    """Что именно прогоняет pytest в этом тексте — только аргументы-мишени.

    Флаги пропускаются, а не обрывают разбор: в CI путь стоит до `--alluredir`,
    а в локальном шаге — после `-m`.
    """
    targets = set()
    for chunk in SPLIT.split(run_text):
        words = chunk.split()
        for position, raw in enumerate(words):
            if _word(raw) != "pytest":
                continue
            for following in words[position + 1 :]:
                token = _word(following)
                if token and PATHISH.match(token):
                    targets.add(token)
    return targets


def suite_scope_mismatch(ci_text: str, local_text: str) -> list:
    """Область прогона обязана совпадать, а не казаться совпадающей.

    `pytest .` и `pytest test_config.py` дают одинаковый набор команд (`python`,
    `pytest`), поэтому проверка голов здесь бессильна, а разница — роковая:
    локальный гейт остаётся зелёным, когда в CI падает любой другой файл. Это
    тот же класс, что и CI-шаг, читающий выборку тестов: см.
    `test_ci_runs_the_whole_backend_suite`.
    """
    ci_targets = pytest_targets(ci_text)
    local_targets = pytest_targets(local_text)
    if not ci_targets or not local_targets:
        return []
    found = []
    for target in sorted(local_targets - ci_targets):
        extra = "файл вместо набора" if TEST_FILE.search(target) else "чужая мишень"
        found.append(
            f"локальный гейт прогоняет pytest-мишень {target} ({extra}), "
            f"а CI прогоняет {' '.join(sorted(ci_targets))}"
        )
    for target in sorted(ci_targets - local_targets):
        found.append(
            f"CI прогоняет pytest-мишень {target}, а локальный гейт её не запускает"
        )
    return found


def _lit(raw: str) -> str:
    """Литерал шага без оформления shell: кавычки и экранирование не значат ничего."""
    return raw.replace("\\", "").replace('"', "").replace("'", "").strip()


# То, чем шаг что-то сверяет, а не только запускает: адрес запроса, образец
# `grep -q` и ожидаемое значение сравнения. Пока сверка идёт на уровне команд
# (`curl` есть, `grep` есть), шаг мог тихо потерять ровно одну проверку.
URL_PATH = re.compile(r"https?://[^/\s'\"]+(?P<path>/[^\s'\")]*)?")
CONTRACT_PATTERNS = {
    "образец": re.compile(r"\bgrep\b(?:\s+-\w+)*\s+-q\s+(\S+)"),
    "ожидание": re.compile(r"\btest\b\s+\S+\s+(?:=|-eq)\s+(\S+)"),
}
# Литерал-оформление, а не контракт: переменная прогона, выражение workflow,
# подстановка формата curl.
NOT_A_CONTRACT = re.compile(r"^[$({%]|TMPDIR")


def step_contracts(run_text: str) -> set:
    """Контракты шага: куда стучится и что именно требует от ответа."""
    out = set()
    for match in URL_PATH.finditer(run_text):
        path = match.group("path")
        if path and path != "/":
            out.add(f"адрес:{path}")
    for label, pattern in CONTRACT_PATTERNS.items():
        for match in pattern.finditer(run_text):
            value = _lit(match.group(1))
            if value and not NOT_A_CONTRACT.match(value):
                out.add(f"{label}:{value}")
    return out


def drift(steps: dict, mirrored: dict, setup: dict) -> list:
    """Расхождения между шагами CI и тем, что прогоняет локальный гейт.

    Три уровня строгости, потому что классы подмены разные: шаг отсутствует,
    шаг присутствует, но зовёт не то (головная команда), и шаг зовёт то же, но
    требует меньше (мишень прогона и контракты сверки).
    """
    found = []
    required = {key for key in steps if key not in setup}
    for key in sorted(required - set(mirrored)):
        found.append(f"шаг CI {key[0]} / {key[1]} не зеркален в scripts/gate.sh")
    for key in sorted(set(mirrored) - set(steps)):
        found.append(f"метка {key[0]} / {key[1]} ведёт на шаг, которого в CI нет")
    for key in sorted(setup):
        if key not in steps:
            found.append(
                f"allowlist называет шаг {key[0]} / {key[1]}, которого в CI нет"
            )
        if len(setup[key]) < REASON_MIN:
            found.append(f"у {key[0]} / {key[1]} причина короче {REASON_MIN} символов")
    for key, region in sorted(mirrored.items()):
        if key not in steps:
            continue
        lowered = region.lower()
        for head in sorted(command_heads(steps[key])):
            if head not in lowered:
                found.append(
                    f"метка {key[0]} / {key[1]} есть, а `{head}` в её области нет"
                )
        found.extend(
            f"{key[0]} / {key[1]}: {line}"
            for line in suite_scope_mismatch(steps[key], region)
        )
        for contract in sorted(step_contracts(steps[key]) - step_contracts(region)):
            found.append(
                f"{key[0]} / {key[1]}: CI сверяет {contract}, а локальная копия — нет"
            )
    return found


# Каждый незавершённый прогон гейт кончает своим кодом, и коды эти — не
# оформление лога: «проверено не всё, остальное смотрит CI» отличается от
# «всё, что умеет эта машина, зелёное» одним числом в последней строке.
GATE_COUNTERS = (
    ("FAILED", 1),
    ("ENV_MISSING", 2),
    ("UNAVAILABLE", 3),
)

# Запись перечня кодов: цифра, за которой сразу разделитель. `(?<![\d.])` не
# даёт поймать восьмёрку из «0.15.8».
EXIT_ENTRY = re.compile(r"(?<![\d.])(\d)\s*[:—]")
EXIT_ANCHOR = re.compile(r"[Ee]xit code|Код выхода")


def gate_exit_map(script: str) -> dict:
    """{счётчик: код} — чем гейт заканчивает учёт каждого вида неудачи.

    Код берётся первым `exit N` после строки `if [ "$СЧЁТЧИК" … ]`: блоки учёта
    идут подряд, и переставить их — отдельный вид поломки, когда «на этой машине
    нечем было прогнать» отдаёт кодом упавшего шага.
    """
    out = {}
    for counter, _ in GATE_COUNTERS:
        head = re.search(rf'^ *if \[\s*"\${counter}"', script, re.M)
        if not head:
            continue
        tail = re.search(r"^ *exit (\d+)", script[head.end() :], re.M)
        if tail:
            out[counter] = int(tail.group(1))
    return out


def documented_exit_codes(text: str) -> list:
    """Коды из перечня в абзаце про код выхода, отсортированные; [] — абзаца нет.

    Ищется одна строка с якорной фразой, а не все цифры документа: чисел в
    CONTRIBUTING достаточно, и «в файле встречается тройка» не значит, что код 3
    обещан. Перенос строки внутри абзаца здесь — не косметика, а находка:
    перечень перестаёт читаться, и тест краснеет, а не сравнивает пустое
    множество с пустым.
    """
    for line in text.splitlines():
        if EXIT_ANCHOR.search(line):
            codes = sorted({int(code) for code in EXIT_ENTRY.findall(line)})
            if codes:
                return codes
    return []


def header_exit_codes(script: str) -> list:
    """Коды из шапки самого gate.sh — блок «Коды выхода:» до первой пустой строки комментария.

    Шапка обязана совпадать с поведением по той же причине, что и документ: её
    читают перед запуском, и обещанный в ней код, которого скрипт не возвращает,
    ровно так же вводит в заблуждение.
    """
    lines = script.splitlines()
    try:
        start = next(
            i for i, line in enumerate(lines) if line.startswith("# Коды выхода:")
        )
    except StopIteration:
        return []
    body = []
    for line in lines[start + 1 :]:
        if not line.startswith("#") or line.strip() == "#":
            break
        body.append(line)
    return sorted({int(code) for code in EXIT_ENTRY.findall("\n".join(body))})


class TestGateMirrorsCi(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.steps = run_steps(parse_yaml(CI_FILE.read_text(encoding="utf-8")))
        cls.gate_text = GATE_FILE.read_text(encoding="utf-8")
        cls.mirrored = gate_markers(cls.gate_text)

    def test_run_steps_are_seen(self):
        self.assertGreaterEqual(
            len(self.steps),
            RUN_STEPS_FLOOR,
            f"разбор увидел только {len(self.steps)} шагов с run: — workflow прочитан не весь",
        )

    def test_markers_are_seen(self):
        self.assertGreaterEqual(
            len(self.mirrored),
            MIRRORED_FLOOR,
            "локальный гейт зеркалит слишком мало шагов, сравнивать нечего",
        )

    def test_nothing_the_ci_checks_is_missing_locally(self):
        self.assertEqual(drift(self.steps, self.mirrored, SETUP_STEPS), [])

    def test_no_marker_without_a_call(self):
        self.assertEqual(
            unbound_markers(self.gate_text),
            [],
            "метка `# ci:` без вызова step/unavailable за ней ничего не зеркалит",
        )

    def test_gate_does_not_restate_ci_values(self):
        for pattern, label in (
            (r"ruff\s*==\s*[0-9]", "пин ruff"),
            (r"(CVE|PYSEC)-", "идентификатор уязвимости из списка исключений"),
            (r"allure-commandline@[0-9]", "версия allure"),
        ):
            self.assertIsNone(
                re.search(pattern, self.gate_text),
                f"scripts/gate.sh пересказывает {label}: значение должно читаться из ci.yml",
            )

    def test_gate_does_not_narrow_the_test_suite(self):
        key = ("backend-tests", "Run tests with Allure")
        self.assertIn(key, self.steps, "CI-шаг с прогоном тестов переименован")
        self.assertIn(key, self.mirrored, "локальный гейт не зеркалит прогон тестов")
        self.assertEqual(suite_scope_mismatch(self.steps[key], self.mirrored[key]), [])

    def test_registry_mode_prints_exactly_the_mirrored_steps(self):
        """`--list` обязан печатать тот же реестр, что читают метки.

        Иначе о том, что прогоняет гейт, есть два источника правды — список в
        файле и вывод скрипта, — а расхождение между ними и есть тот класс, из-
        за которого CI покраснел: локальный прогон значил меньше, чем в нём
        было написано.
        """
        if not shutil.which("bash"):
            self.fail("без bash scripts/gate.sh не прогоняется, реестр нечем проверить")
        proc = subprocess.run(
            # as_posix: в Git Bash обратный слэш — экранирование, и путь из
            # Windows-разделителей он бы не нашёл.
            ["bash", GATE_FILE.as_posix(), "--list"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        printed = [line for line in proc.stdout.splitlines() if line.strip()]
        self.assertEqual(
            sorted(printed),
            sorted(f"{job} / {name}" for job, name in self.mirrored),
        )
        self.assertEqual(len(printed), len(set(printed)), "реестр печатает шаг дважды")

    def test_every_setup_reason_names_what_it_replaces(self):
        for key, reason in SETUP_STEPS.items():
            self.assertIn(
                key,
                self.steps,
                f"allowlist называет несуществующий шаг {key}",
            )
            self.assertGreaterEqual(len(reason), REASON_MIN)


# Два рукописных списка про CI в CONTRIBUTING — по одному на язык. Второй опаснее
# первого: он выглядит авторитетнее, потому что в той же строке, где пересказан
# пин, написано, что другой пин с CI расходится.
DOC_TABLES = {
    "en": {"jobs": "## What CI runs", "tools": "## Prerequisites"},
    "ru": {"jobs": "## Что прогоняет CI", "tools": "## Требования"},
}
# Как проверяется версия из документа: подставить её в цитату ci.yml и найти
# строку целиком. Сравнение чисел здесь означало бы, что документ имеет право
# на своё число, — а права у него нет, есть только пересказ.
TOOL_PINS = {
    "Node.js": 'NODE_VERSION: "{version}"',
    "Python": 'PYTHON_VERSION: "{version}"',
    "PostgreSQL": "image: postgres:{version}-",
    "Redis": "image: redis:{version}-",
    "Ruff": 'install "ruff=={version}"',
}


class TestCiTablesMatchDocs(unittest.TestCase):
    """Таблицы CONTRIBUTING обязаны говорить то же, что workflow."""

    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.markdown = CONTRIBUTING_FILE.read_text(encoding="utf-8")
        cls.ci_text = CI_FILE.read_text(encoding="utf-8")
        cls.steps = run_steps(parse_yaml(cls.ci_text))
        cls.jobs = sorted({job for job, _ in cls.steps})

    def test_tables_name_exactly_the_ci_jobs(self):
        for lang, headings in DOC_TABLES.items():
            with self.subTest(lang=lang):
                rows = doc_table(self.markdown, headings["jobs"])
                self.assertEqual(sorted(rows), self.jobs)

    def test_every_row_names_a_command_its_job_runs(self):
        for lang, headings in DOC_TABLES.items():
            for job, text in doc_table(self.markdown, headings["jobs"]).items():
                run_tools: set = set()
                for step_job, run in self.steps.items():
                    if step_job[0] == job:
                        run_tools |= command_heads(run)
                named = set(re.findall(r"[a-z0-9_.@/-]{2,}", text.lower()))
                self.assertTrue(
                    run_tools & named,
                    f"{lang}: строка {job} не называет ни одной команды, "
                    "которую этот джоб реально запускает",
                )

    def test_documented_versions_are_the_ones_ci_pins(self):
        for lang, headings in DOC_TABLES.items():
            rows = doc_table(self.markdown, headings["tools"])
            with self.subTest(lang=lang):
                self.assertEqual(sorted(rows), sorted(TOOL_PINS))
                for tool, version in rows.items():
                    self.assertIn(
                        TOOL_PINS[tool].format(version=version),
                        self.ci_text,
                        f"{lang}: {tool} {version} не найдено в ci.yml — "
                        "документ пересказывает не тот пин",
                    )


class TestAdvisoryExceptionsAreDocumented(unittest.TestCase):
    """Список `--ignore-vuln` и две таблицы SECURITY.md обязаны называть одно и то же.

    Повод: абзац про риски читается чаще, чем workflow, и «это уже снято»
    решают по документу. Пока совпадение списка с таблицей — память человека,
    снятое в CI исключение живёт в доке ещё один релиз, а новое исключение
    появляется в логе без объяснения.
    """

    @classmethod
    def setUpClass(cls):
        ci_text = CI_FILE.read_text(encoding="utf-8")
        cls.raw = re.findall(r"--ignore-vuln\s+([A-Za-z0-9._-]+)", ci_text)
        cls.excluded = set(cls.raw)
        cls.security = SECURITY_FILE.read_text(encoding="utf-8")

    def test_the_exclusion_list_is_seen(self):
        self.assertGreaterEqual(
            len(self.excluded),
            8,
            f"разбор увидел только {len(self.excluded)} исключений — ci.yml прочитан не весь",
        )

    def test_ci_does_not_ignore_the_same_advisory_twice(self):
        self.assertEqual(
            len(self.raw),
            len(self.excluded),
            "в ci.yml один идентификатор исключён дважды: вторая строка ничего не добавляет "
            "и переживёт снятие первого исключения",
        )

    def test_documented_advisories_are_the_excluded_ones(self):
        self.assertEqual(advisory_findings(self.security, self.excluded), [])


class TestGateEnvIsQuotedFromCi(unittest.TestCase):
    """Строки подключения для гейта в CONTRIBUTING — дословная цитата env-блока ci.yml.

    Повод: у гейта свой страж против базы с именем `wake`, и документ, который
    советует экспортировать `.../wake`, советует отказаться от прогона бэкэнда.
    Имя базы живёт в workflow, поэтому цитата, а не пересказ: переименование
    базы в CI обязано краснить документ, а не молча разойтись с ним.
    """

    @classmethod
    def setUpClass(cls):
        ci_text = CI_FILE.read_text(encoding="utf-8")
        cls.urls = dict(
            re.findall(r"^ *(WAKE_(?:TEST_)?DATABASE_URL): (\S+)$", ci_text, re.M)
        )
        cls.halves = language_halves(CONTRIBUTING_FILE.read_text(encoding="utf-8"))

    def test_ci_names_both_databases(self):
        self.assertEqual(
            sorted(self.urls),
            ["WAKE_DATABASE_URL", "WAKE_TEST_DATABASE_URL"],
            "env-блок workflow прочитан не весь — сверять имена баз нечем",
        )

    def test_document_has_two_language_halves(self):
        self.assertEqual(len(self.halves), 2, list(self.halves))

    def test_each_half_quotes_both_urls(self):
        for title, text in self.halves.items():
            for name, value in self.urls.items():
                self.assertIn(
                    f"export {name}={value}",
                    text,
                    f"«{title}»: гейт запускают без {name} — в ci.yml это {value}",
                )

    def test_ci_urls_satisfy_the_database_name_guards(self):
        # pytest при импорте testsupport отказывается запускать TRUNCATE, если
        # имя базы из WAKE_TEST_DATABASE_URL не кончается на _test, а гейт
        # отказывается мигрировать базу по URL с именем wake. Оба читают имя
        # одной и той же функцией — значит, тот же разбор честен и к env-блоку
        # workflow: переименование базы в CI здесь же краснит проверку, а не
        # превращается в «прогон упал на ровном месте» через полдесятка джобов.
        migrate = database_name(self.urls["WAKE_DATABASE_URL"])
        test = database_name(self.urls["WAKE_TEST_DATABASE_URL"])
        self.assertTrue(
            test.endswith("_test"),
            f"pytest откажется чистить базу {test!r} — суффикс _test обязателен",
        )
        self.assertNotEqual(migrate, "wake", f"alembic пойдёт в базу {migrate!r}")
        self.assertNotEqual(test, "wake", f"TRUNCATE пойдёт по базе {test!r}")
        # Разделение баз — не местный вкус: у alembic и у pytest разные базы,
        # потому что общие таблицы означали бы, что тесты затирают ту же базу,
        # которую только что мигрировали, и create_all скрыл бы дрейф между
        # моделями и миграциями.
        self.assertNotEqual(
            migrate,
            test,
            f"alembic и pytest идут в одну базу {migrate!r}: create_all из тестов "
            "замаскирует дрейф между моделями и миграциями",
        )


# Формы строки подключения, в которых база называется `wake`. Первая — та, что
# заметна глазами; остальные обходили страж, пока он сверял текст после
# последнего слэша: параметр `?sslmode=require` приклеивается к имени, пустой
# путь без имени базы означает для asyncpg «возьми имя пользователя», а
# percent-написание страж читал буквально и не узнавал продакшн в имени,
# которое драйвер раскодирует перед открытием базы.
PROD_NAME_FORMS = (
    "postgresql+asyncpg://wake:wake@localhost:5432/wake",
    "postgresql+asyncpg://wake:wake@localhost:5432/wake?sslmode=require",
    "postgresql+asyncpg://wake:wake@localhost:5432/",
    "postgresql://dbuser:pw@example.host:5432/wake?sslmode=require",
    # Percent-форма: драйвер раскодирует имя до того, как открыть базу, и
    # получает `wake` — страж, сверяющий текст как есть, читал «%77ake».
    "postgresql+asyncpg://wake:wake@localhost:5432/%77ake",
    "postgresql+asyncpg://wake:wake@localhost:5432/%77%61%6B%65",
    "postgresql+asyncpg://wake:wake@localhost:5432/%77ake?sslmode=require",
    # То же имя в userinfo при пустом пути: базу драйвер берёт из пользователя.
    "postgresql+asyncpg://%77ake:pw@localhost:5432/",
)

# Формы, в которых драйвер открывает НЕ продакшн, и что именно он называет.
# Значения сняты с диалекта, а не из головы: «wake/x_test» и «/wake» — имена,
# которых нет ни в одном пересказе правила, и сверять разбор с догадкой
# автора — значит закрепить именно её (замер — в TestDriverIsTheOwner из
# test_db_url.py).
OTHER_NAME_FORMS = (
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake/x_test", "wake/x_test"),
    ("postgresql+asyncpg://wake:wake@localhost:5432//wake", "/wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/%2Fwake", "/wake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%5Ftest", "wake_test"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%2F", "wake/"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/%25wake", "%wake"),
    # Хвостовой слэш — символ имени, а не оформление URL: базы `wake/` нет, и
    # прогон в неё упирается в «база не найдена», а не в миграцию продакшна.
    # Старый страж срезал один хвостовой слэш и читал здесь `wake` — отказ
    # полезный, но по неверной причине, и на `wake//` он повторял его тем же
    # способом, хотя драйвер открыл бы базу `wake//`. Перебор отказа — не
    # безопасность: под него нечего подстроить, а живой прогон он только
    # останавливает.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake/", "wake/"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake//", "wake//"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake_test/", "wake_test/"),
    # Якорь диалект от имени не отделяет: режет строку только по первому `?`.
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake#frag", "wake#frag"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake?a=1#frag", "wake"),
    ("postgresql+asyncpg://tester:pw@localhost:5432/", "tester"),
    ("postgresql+asyncpg://u:p%40x@localhost:5432/", "u"),
    # Ни пути, ни пользователя: имени нет, и пустая строка — честный ответ.
    ("postgresql+asyncpg://localhost:5432/", ""),
    # Кривые написания раскодированию не поддаются — обе реализации оставляют
    # их как есть, и «wake» среди них оказаться не может.
    ("postgresql+asyncpg://wake:wake@localhost:5432/%ZZwake", "%ZZwake"),
    ("postgresql+asyncpg://wake:wake@localhost:5432/wake%", "wake%"),
)

# Формы, из которых проб живости достаёт хост и порт: (URL, порт по умолчанию,
# хост, порт). IPv6 здесь не экзотика, а единственный вид записи, где во хосте
# есть двоеточие — «[::1]:6379», — и простой разбор «до первого двоеточия»
# отдаёт одну «[«. Последняя строка проверяет, что пароль с двоеточием не
# переезжает в порт.
HOSTPORT_FORMS = (
    (
        "postgresql+asyncpg://wake:wake@localhost:5432/wake_migrate",
        "5432",
        "localhost",
        "5432",
    ),
    (
        "postgresql+asyncpg://wake:wake@localhost/wake_migrate",
        "5432",
        "localhost",
        "5432",
    ),
    ("redis://localhost:6379/0", "6379", "localhost", "6379"),
    ("redis://127.0.0.1/0", "6379", "127.0.0.1", "6379"),
    ("redis://[::1]:6379/0", "6379", "::1", "6379"),
    ("redis://[::1]/0", "6379", "::1", "6379"),
    ("postgresql+asyncpg://u:p@[::1]:5432/db?sslmode=require", "5432", "::1", "5432"),
    ("redis://user:pa:ss@cache.example:6380/1", "6379", "cache.example", "6380"),
)


class TestDatabaseNameGuard(unittest.TestCase):
    """Запрет продакшной базы проверяется прогоном скрипта, а не чтением его текста.

    Повод: у `db_env_ready` была одна работа — не дать проверочному скрипту
    открыть базу `wake`. Сверялось имя, стоящее после последнего слэша, и
    замер 2026-11-11 показал три вида строк, где это не имя базы, а хвост URL:
    `.../wake?sslmode=require` (так отдают строку Railway, Supabase и Neon),
    `.../wake/` и `.../` без пути — в последнем случае драйвер берёт имя базы из
    имени пользователя. Все три проходили страж и уводили `alembic upgrade head`
    в живую базу. Тест потому и запускает скрипт: пересказ правила в regex над
    файлом ловил бы ровно то написание, которое автор уже выбрал, — а ловить
    нужно поведение.
    """

    @classmethod
    def setUpClass(cls):
        ci_text = CI_FILE.read_text(encoding="utf-8")
        cls.urls = dict(
            re.findall(r"^ *(WAKE_(?:TEST_)?DATABASE_URL): (\S+)$", ci_text, re.M)
        )

    def _check(self, migrate=None, test=None, drop=(), extra=None):
        if not shutil.which("bash"):
            self.fail("без bash scripts/gate.sh не прогоняется, страж нечем проверить")
        env = os.environ.copy()
        # Все четыре переменные ставятся явно: окружение разработчика могло
        # их уже содержать, а тест на «не задано» обязан проверять именно
        # отсутствие, а не случайное совпадение с тем, что было в shell.
        env["WAKE_DATABASE_URL"] = migrate or self.urls["WAKE_DATABASE_URL"]
        env["WAKE_TEST_DATABASE_URL"] = test or self.urls["WAKE_TEST_DATABASE_URL"]
        env["WAKE_REDIS_URL"] = "redis://localhost:6379/0"
        env["WAKE_SESSION_SECRET"] = "check-env-test-value"
        env.update(extra or {})
        for name in drop:
            env.pop(name, None)
        return subprocess.run(
            ["bash", GATE_FILE.as_posix(), "--check-env"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_ci_urls_pass_the_guard(self):
        """Строки, которые документ велит экспортировать, страж не отвергает.

        Иначе отказ и совет в CONTRIBUTING расходятся, а оператор узнаёт об
        этом на красном прогоне.
        """
        proc = self._check()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_production_name_is_refused_in_every_url_form(self):
        for url in PROD_NAME_FORMS:
            with self.subTest(url=url):
                proc = self._check(migrate=url)
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn("WAKE_DATABASE_URL", proc.stdout)

    def test_production_name_is_refused_in_the_test_database_too(self):
        # pytest делает TRUNCATE: база с именем продакшна здесь опасна не
        # миграцией, а чисткой данных.
        for url in PROD_NAME_FORMS:
            with self.subTest(url=url):
                proc = self._check(test=url)
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn("WAKE_TEST_DATABASE_URL", proc.stdout)

    def test_refusal_quotes_the_urls_from_ci(self):
        proc = self._check(migrate=PROD_NAME_FORMS[1])
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        for name in ("WAKE_DATABASE_URL", "WAKE_TEST_DATABASE_URL"):
            self.assertIn(
                f"{name}={self.urls[name]}",
                proc.stdout,
                f"отказ не называет {name} из ci.yml — оператор чинит вслепую",
            )

    def test_missing_variable_is_not_reported_as_green(self):
        for name in (
            "WAKE_DATABASE_URL",
            "WAKE_TEST_DATABASE_URL",
            "WAKE_REDIS_URL",
            "WAKE_SESSION_SECRET",
        ):
            with self.subTest(var=name):
                proc = self._check(drop=(name,))
                self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
                self.assertIn(name, proc.stdout)

    def test_check_env_needs_no_scratch_directory(self):
        """Чернового каталога у режима нет — и это проверяемо.

        Прямая проверка («посмотреть, что каталог не создан») невозможна: trap
        стирает его до того, как тест успевает его увидеть. Ловится другое — на
        несуществующем TMPDIR `mktemp -d` отвечает кодом 1, значит прогон с таким
        TMPDIR даёт 0 ровно тогда, когда mktemp вообще не вызывался.
        """
        proc = self._check(extra={"TMPDIR": "/tmp/wake-check-env-no-such-dir"})
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_check_env_installs_nothing(self):
        """До установки ruff режим не доходит: черновой кэш остаётся несозданным.

        Иначе «проверка окружения» требовала бы сети и краснела бы без неё не
        по той причине, которую объясняет.
        """
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "wake-gate"
            proc = self._check(extra={"WAKE_GATE_CACHE": bash_path(cache)})
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertFalse(cache.exists(), "--check-env ставит ruff в черновой кэш")

    def test_python_and_bash_name_the_same_database(self):
        """Разбор из db_url.py на этих же формах называет базу `wake`.

        Реализации две — bash не вызывает python, python не вызывает bash, —
        а таблица одна: две редакции одного правила расходятся молча, и видно
        это только когда обе сверяются с одним списком написаний.
        """
        for url in PROD_NAME_FORMS:
            with self.subTest(url=url):
                self.assertEqual(database_name(url), "wake")

    def test_unknown_argument_is_an_error_not_a_run(self):
        if not shutil.which("bash"):
            self.fail(
                "без bash scripts/gate.sh не прогоняется, разбор аргументов нечем проверить"
            )
        proc = subprocess.run(
            ["bash", GATE_FILE.as_posix(), "--cheek-env"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn("--check-env", proc.stdout, "подсказка не называет новый режим")


class TestBothParsersNameTheSameDatabase(unittest.TestCase):
    """`_db_name` из gate.sh и `database_name` из db_url.py называют базу
    одно и то же на всех написаниях из общей таблицы.

    Повод: правило живёт в двух реализациях — bash не вызывает python, python
    не вызывает bash, — и расходятся они молча. Замер 2026-11-12 добавил в
    разбор percent-раскодирование: без него строка `/%77ake` обошла бы запрет
    продакшна с обеих сторон, а `.../%77ake:p@host/` открыл бы базу `wake` там,
    где обе проверки читали «%77ake». Оставить раскодирование в одной из двух
    реализаций значило бы получить пару, которая на живых строках отвечает
    по-разному, — и это ровно та тишина, из-за которой таблицы сверяются.

    Функция извлекается из скрипта и исполняется оболочкой, а не пересказывается
    регуляркой: пересказ ловит только те написания, о которых подумал автор
    пересказа.
    """

    @classmethod
    def setUpClass(cls):
        text = GATE_FILE.read_text(encoding="utf-8")
        cls.names = ("_unquote", "_db_name")
        cls.bodies = {name: shell_function(text, name) for name in cls.names}
        cls.source = "\n".join(cls.bodies[name] for name in cls.names)

    def _call(self, url: str) -> str:
        if not shutil.which("bash"):
            self.fail("без bash разбор строки подключения нечем проверить")
        proc = subprocess.run(
            ["bash", "-c", f'{self.source}\n_db_name "$0"', url],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.stderr, "", f"разбор жалобно молчит на {url}")
        return proc.stdout.strip()

    def test_function_bodies_are_found(self):
        for name in self.names:
            with self.subTest(name=name):
                self.assertTrue(
                    self.bodies[name].startswith(f"{name}() {{"),
                    f"разбор не нашёл {name} в gate.sh: функция переименована "
                    "или перенесена, и сравнение двух реализаций ничего не сверяет",
                )

    def test_production_forms_are_named_wake_by_both(self):
        for url in PROD_NAME_FORMS:
            with self.subTest(url=url):
                self.assertEqual(self._call(url), "wake")
                self.assertEqual(database_name(url), "wake")

    def test_other_forms_are_named_alike(self):
        for url, name in OTHER_NAME_FORMS:
            with self.subTest(url=url):
                self.assertEqual(self._call(url), name)
                self.assertEqual(database_name(url), name)

    def test_percent_form_is_not_a_rarity_in_the_table(self):
        """Ветвление `_unquote` должно доставаться таблицей, а не одним
        написанием: иначе сводная проверка имён проверяет один слэш."""
        encoded = [url for url in PROD_NAME_FORMS if "%" in url] + [
            url for url, _ in OTHER_NAME_FORMS if "%" in url
        ]
        self.assertGreaterEqual(
            len(encoded), 5, f"форм с percent-именами осталось {len(encoded)}"
        )


class TestEndpointIsNamedForTheProbe(unittest.TestCase):
    """Проб живости смотрит ровно в тот хост и порт, что названы в URL.

    Повод: `_hostport` решает, жив ли сервис. Ошибка в разборе не делает гейт
    ложнозелёным — провал проба читается как «машине нечем прогнать», — но
    напротив живой базы она печатает «нет WAKE_* или база не отвечает», и
    оператор идёт искать переменные, которые уже заданы. Функция проверяется
    исполнением её собственного тела: таблица написаний, сверенная с пересказом
    правила, ловит только те написания, о которых думал автор пересказа.
    """

    @classmethod
    def setUpClass(cls):
        cls.body = shell_function(GATE_FILE.read_text(encoding="utf-8"), "_hostport")

    def _call(self, body: str, url: str, default: str) -> str:
        if not shutil.which("bash"):
            self.fail("без bash разбор строки подключения нечем проверить")
        proc = subprocess.run(
            ["bash", "-c", body + '\n_hostport "$0" "$1"', url, default],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return proc.stdout.strip()

    def test_function_body_is_found(self):
        self.assertTrue(
            self.body.startswith("_hostport() {"),
            "разбор не нашёл `_hostport` в gate.sh: функция переименована или перенесена",
        )

    def test_every_form_names_the_host_and_port_to_probe(self):
        for url, default, host, port in HOSTPORT_FORMS:
            with self.subTest(url=url):
                self.assertEqual(self._call(self.body, url, default), f"{host} {port}")


class TestGateExitCodesAreQuoted(unittest.TestCase):
    """Документ, шапка скрипта и учёт в скрипте обещают одни и те же коды.

    Повод: код 0 и код 3 различают «проверено всё, что эта машина умеет» и
    «половины проверок не было» — и различают только числом в последней строке
    лога. Если скрипт начнёт отдавать 3 кодом 0 (или документ перестанет
    упоминать 2), ложнозелёным станет не шаг, а весь гейт, и ни одна проверка
    шага это не заметит: шаги-то действительно зелёные.

    Проверяется сверкой трёх списков, а не прогоном: вызвать 1 и 3 можно, либо
    сломав шаг, либо убрав с машины инструмент, и то и другое на конкретной
    машине — свой вкус окружения. Коды 0 и 2 при этом проверяются живым прогоном
    в TestDatabaseNameGuard.
    """

    @classmethod
    def setUpClass(cls):
        cls.script = GATE_FILE.read_text(encoding="utf-8")
        cls.mapped = gate_exit_map(cls.script)
        cls.promised = {0} | set(cls.mapped.values())
        cls.halves = language_halves(CONTRIBUTING_FILE.read_text(encoding="utf-8"))

    def test_accounting_blocks_are_seen(self):
        self.assertEqual(
            sorted(self.mapped),
            sorted(name for name, _ in GATE_COUNTERS),
            "блок учёта найден не для каждого счётчика — разбор читает скрипт не весь",
        )

    def test_each_failure_kind_keeps_its_own_code(self):
        for name, code in GATE_COUNTERS:
            with self.subTest(counter=name):
                self.assertEqual(
                    self.mapped.get(name),
                    code,
                    f"{name} заканчивается кодом {self.mapped.get(name)} вместо {code}",
                )

    def test_document_promise_is_the_script_promise(self):
        for title, text in self.halves.items():
            with self.subTest(half=title):
                codes = documented_exit_codes(text)
                self.assertTrue(
                    codes,
                    f"«{title}»: абзац с перечнем кодов не найден — сверять нечего",
                )
                self.assertEqual(
                    codes,
                    sorted(self.promised),
                    f"«{title}»: перечень кодов разошёлся с учётом в gate.sh",
                )

    def test_script_header_promise_is_the_script_promise(self):
        codes = header_exit_codes(self.script)
        self.assertTrue(codes, "шапка gate.sh с перечнем кодов не найдена")
        self.assertEqual(codes, sorted(self.promised), "шапка скрипта обещает другое")


class TestGateScriptIsPortable(unittest.TestCase):
    """gate.sh обязан пережить checkout на Windows, а не краснеть из-за `\\r`.

    Повод: скрипт запускается оболочкой, и bash читает `\\r` как часть команды —
    с `core.autocrlf=true` на Windows checkout отдаёт файл, в котором не
    исполняется ни одна строка, а причина выглядит как поломка кода. Поэтому
    конец строки закреплён в .gitattributes, и проверяются обе стороны: правило
    и то, что лежащий в репозитории файл ему соответствует.
    """

    @classmethod
    def setUpClass(cls):
        cls.script = GATE_FILE
        cls.rules = eol_rules(GITATTRIBUTES_FILE.read_text(encoding="utf-8"))

    def test_script_bytes_have_no_carriage_returns(self):
        # newline="": иначе open сам транслирует концы строк, и проверка
        # превратится в сравнение того, что уже починила библиотека.
        with open(self.script, encoding="utf-8", newline="") as handle:
            self.assertNotIn("\r", handle.read())

    def test_shell_scripts_are_pinned_to_lf(self):
        self.assertIn("*.sh", self.rules, ".gitattributes не закрепляет *.sh")
        self.assertIn(
            "eol=lf",
            self.rules["*.sh"],
            f"правило `*.sh` закрепляет не конец строки: {self.rules['*.sh']}",
        )


class TestScannerIsNotBlind(unittest.TestCase):
    """Каждый класс находок должен достигаться матчером, а не только рассказом в docstring."""

    def test_eol_rule_without_a_pin_is_not_a_pin(self):
        """`*.sh text` — правило, которое ничего не закрепляет."""
        self.assertNotIn("eol=lf", eol_rules("# комментарий\n*.sh text\n")["*.sh"])
        self.assertIn("eol=lf", eol_rules("*.sh text eol=lf\n")["*.sh"])

    def test_naive_last_segment_would_pass_most_production_urls(self):
        """Таблица форм не сводится к одной: иначе набор проверяет одно и то же.

        Сравнение «последний сегмент URL равен wake» ловит первую строку и
        пропускает остальные пять — ровно тот страж, который стоял в gate.sh до
        замера 2026-11-11.
        """
        naive_caught = [u for u in PROD_NAME_FORMS if u.split("/")[-1] == "wake"]
        self.assertEqual(len(naive_caught), 1, naive_caught)

    def ci(self, run_text: str, name: str = "Some check", job: str = "backend-lint"):
        return {(job, name): run_text}

    def test_missing_mirror_is_found(self):
        found = drift(self.ci("ruff format --check ."), {}, {})
        self.assertEqual(
            found, ["шаг CI backend-lint / Some check не зеркален в scripts/gate.sh"]
        )

    def test_dead_marker_is_found(self):
        gate = '# ci: backend-lint / Removed step\nstep "backend-lint" "Removed step" "ruff check ."\n'
        found = drift(self.ci("ruff check ."), gate_markers(gate), {})
        self.assertEqual(
            set(found),
            {
                "шаг CI backend-lint / Some check не зеркален в scripts/gate.sh",
                "метка backend-lint / Removed step ведёт на шаг, которого в CI нет",
            },
        )

    def test_stale_allowlist_entry_is_found(self):
        setup = {
            (
                "backend-lint",
                "Some check",
            ): "эта причина достаточно длинная, чтобы пройти пол"
        }
        found = drift({}, gate_markers(""), setup)
        self.assertEqual(
            found,
            ["allowlist называет шаг backend-lint / Some check, которого в CI нет"],
        )

    def test_reasonless_allowlist_entry_is_found(self):
        steps = self.ci("ruff check .")
        found = drift(steps, {}, {("backend-lint", "Some check"): "ок"})
        self.assertTrue(any("короче" in line for line in found), found)

    def test_hollow_step_body_is_found(self):
        steps = self.ci("ruff format --check .")
        gate = '# ci: backend-lint / Some check\nstep "backend-lint" "Some check" "echo готово"\n'
        found = drift(steps, gate_markers(gate), {})
        self.assertTrue(any("`ruff`" in line for line in found), found)

    def test_marker_without_call_is_found(self):
        gate = '# ci: backend-lint / Some check\n\necho "ничего не прогоняем"\n'
        self.assertEqual(unbound_markers(gate), [("backend-lint", "Some check")])

    def test_block_scalar_head_commands_are_read(self):
        heads = command_heads(
            'if pip install --dry-run "urllib3>=2.1.0" >/dev/null; then\n'
            '  echo "::error::кап снят"\n  exit 1\nfi\n'
            "ready=$(curl --silent --fail http://127.0.0.1:8000/ready)\n"
            'echo "$ready" | grep -q \'"status":"ready"\'\n'
        )
        # `if` и `echo` — не команды; `ready=$(curl …)` — это curl; адрес в
        # подкоманду не попадает.
        self.assertEqual(heads, {"pip", "install", "curl", "grep"})

    def test_narrowed_suite_is_found(self):
        """Файл вместо каталога — те же команды, ловится только по мишени."""
        steps = self.ci("python -m pytest . --tb=short -q", name="Run tests")
        gate = (
            "# ci: backend-lint / Run tests\n"
            'step "backend-lint" "Run tests" "python -m pytest test_config.py"\n'
        )
        self.assertEqual(
            command_heads(steps[("backend-lint", "Run tests")]), {"python", "pytest"}
        )
        found = drift(steps, gate_markers(gate), {})
        scope = [line for line in found if "мишень" in line]
        self.assertEqual(len(scope), 2, found)
        self.assertIn("файл вместо набора", scope[0])
        self.assertIn("её не запускает", scope[1])

    def test_suite_scope_split_from_ci_is_found(self):
        """Обратная сторона: локальный шаг шире CI — тоже расхождение."""
        steps = self.ci("python -m pytest .", name="Run tests")
        gate = '# ci: backend-lint / Run tests\nstep "backend-lint" "Run tests" "python -m pytest ../"\n'
        found = drift(steps, gate_markers(gate), {})
        scope = [line for line in found if "мишень" in line]
        self.assertEqual(len(scope), 2, found)
        self.assertIn("чужая мишень", scope[0])

    def test_pytest_targets_ignore_flags_and_line_continuations(self):
        targets = pytest_targets(
            "python -m pytest . \\\n  --alluredir=allure-results \\\n  --tb=short -q\n"
        )
        self.assertEqual(targets, {"."})

    def test_contracts_ignore_host_and_quotes(self):
        """Свой порт и своё экранирование не мешают сравнить, что именно сверяется."""
        ci = step_contracts(
            "ready=$(curl --silent --fail http://127.0.0.1:8000/ready)\n"
            'echo "$ready" | grep -q \'"status":"ready"\'\n'
            'test "$code" = "401"\n'
        )
        local = step_contracts(
            "ready=$(curl --silent --max-time 10 http://127.0.0.1:8137/ready)\n"
            'echo "$ready" | grep -q "\\"status\\":\\"ready\\""\n'
            'test "$code" = "401"\n'
        )
        self.assertEqual(ci, {"адрес:/ready", "образец:status:ready", "ожидание:401"})
        self.assertEqual(ci, local)

    def test_dropped_endpoint_check_is_found(self):
        """Тот же curl, та же grep — и съеденный адрес: головы не отличат."""
        steps = self.ci("curl http://127.0.0.1:8000/ready | grep -q ok")
        gate = (
            "# ci: backend-lint / Some check\n"
            'step "backend-lint" "Some check" "curl http://127.0.0.1:8137/health | grep -q ok"\n'
        )
        self.assertEqual(
            command_heads(steps[("backend-lint", "Some check")]),
            command_heads(gate_markers(gate)[("backend-lint", "Some check")]),
        )
        found = drift(steps, gate_markers(gate), {})
        self.assertEqual(len(found), 1, found)
        self.assertIn("адрес:/ready", found[0])

    def test_doc_table_reader_drops_header_and_separator(self):
        markdown = (
            "## What CI runs\n\n"
            "| Job | What it checks |\n"
            "| --- | --- |\n"
            "| backend-lint | `ruff check .` |\n"
            "| backend-tests | `pytest` |\n\n"
            "## Code style\n"
        )
        self.assertEqual(
            doc_table(markdown, "## What CI runs"),
            {"backend-lint": "`ruff check .`", "backend-tests": "`pytest`"},
        )

    def test_renamed_heading_is_not_an_empty_agreement(self):
        """Пустая таблица обязана краснеть, а не сходиться с пустым множеством."""
        self.assertEqual(
            doc_table("## Что прогоняет CI\n| a | b |\n", "## What CI runs"), {}
        )

    # Две строки вместо одной: исчезнувшую половину таблицы надо видеть как
    # расхождение множеств, а не как «таблица не читается».
    ADVISORY_IDS = {
        "CVE-2024-37891",
        "PYSEC-2026-1995",
        "CVE-2025-50181",
        "PYSEC-2026-1999",
    }
    EN_ROWS = (
        "| CVE-2024-37891 | PYSEC-2026-1995 | Proxy auth header across origins |\n"
        "| CVE-2025-50181 | PYSEC-2026-1999 | Pool redirect limits ignored |"
    )
    RU_ROWS = (
        "| CVE-2024-37891 | PYSEC-2026-1995 | Прокси-заголовок |\n"
        "| CVE-2025-50181 | PYSEC-2026-1999 | Пул не слушает запрет редиректов |"
    )

    def advisory_doc(self, en: str = EN_ROWS, ru: str = RU_ROWS) -> str:
        return (
            "### Dependency auditing\n\n"
            "| Advisory | Also | Path |\n| --- | --- | --- |\n"
            f"{en}\n\n"
            "### Проверка зависимостей\n\n"
            "| Уязвимость | Также | Путь |\n| --- | --- | --- |\n"
            f"{ru}\n"
        )

    def test_advisory_matcher_agrees_with_a_complete_table(self):
        """Чистая таблица на синтетике даёт пустой список, иначе ниже всё пусто."""
        self.assertEqual(advisory_findings(self.advisory_doc(), self.ADVISORY_IDS), [])

    def test_advisory_columns_collapsed_is_found(self):
        """Возврат к двухколоночной таблице — потерянный столбец, а не «всё сходно»."""
        found = advisory_findings(
            self.advisory_doc(
                en="| CVE-2024-37891 | Proxy auth header across origins |\n"
                "| CVE-2025-50181 | Pool redirect limits ignored |",
                ru="| CVE-2024-37891 | Прокси-заголовок |\n"
                "| CVE-2025-50181 | Пул не слушает запрет редиректов |",
            ),
            self.ADVISORY_IDS,
        )
        self.assertEqual(len(found), 2, found)
        self.assertTrue(all("не читается" in line for line in found), found)

    def test_stale_second_language_is_found(self):
        """Английская половина свежая, русская — нет: находка обязана называть русскую."""
        found = advisory_findings(
            self.advisory_doc(ru=self.RU_ROWS.split("\n")[0]), self.ADVISORY_IDS
        )
        self.assertEqual(len(found), 2, found)
        for line in found:
            self.assertIn("### Проверка зависимостей", line)
            self.assertIn("исключена в CI", line)

    def test_advisory_named_but_not_excluded_is_found(self):
        """Строка «снято, больше не исключается», оставленная в доке, — находка."""
        found = advisory_findings(
            self.advisory_doc(), self.ADVISORY_IDS - {"PYSEC-2026-1995"}
        )
        self.assertEqual(len(found), 2, found)
        self.assertTrue(all("не исключает" in line for line in found), found)

    def test_duplicated_advisory_row_is_found(self):
        found = advisory_findings(
            self.advisory_doc(en=f"{self.EN_ROWS}\n{self.EN_ROWS.splitlines()[0]}"),
            self.ADVISORY_IDS,
        )
        self.assertTrue(any("дважды" in line for line in found), found)

    def test_advisory_row_without_description_is_found(self):
        found = advisory_findings(
            self.advisory_doc(
                en=f"{self.EN_ROWS.splitlines()[0]}\n"
                "| CVE-2025-50181 | PYSEC-2026-1999 |  |"
            ),
            self.ADVISORY_IDS,
        )
        self.assertEqual(len(found), 1, found)
        self.assertIn("без описания", found[0])

    def test_language_halves_ignore_code_block_comments(self):
        """`# ...` внутри ``` — shell-комментарий, а не заголовок нового языка."""
        markdown = "# En\n\n```bash\n# не заголовок\n```\n\n# Ru\n"
        self.assertEqual(sorted(language_halves(markdown)), ["En", "Ru"])

    def test_value_present_in_one_half_only_is_a_finding(self):
        """Почему половины сверяются отдельно: по файлу целиком — сходится, по половине — нет."""
        halves = language_halves(
            "# En\nexport WAKE_DATABASE_URL=x\n\n# Ru\nexport WAKE_DATABASE_URL=y\n"
        )
        self.assertIn("export WAKE_DATABASE_URL=x", "\n".join(halves.values()))
        self.assertNotIn("export WAKE_DATABASE_URL=x", halves["Ru"])

    def test_real_multiline_steps_expose_their_tools(self):
        """Block-scalars читаются, и подкоманда отделяет шаг от шага.

        Проверка на настоящем workflow: если разбор YAML перестанет понимать
        `run: |`, набор команд у шага дыма стал бы пустым, и пустая область в
        gate.sh прошла бы как «всё зеркально». Подкоманда важна ровно потому,
        что шаг формата и шаг линтера зовут один и тот же `ruff`: без неё
        локальный гейт подменил бы один другим и остался зелёным.
        """
        steps = run_steps(parse_yaml(CI_FILE.read_text(encoding="utf-8")))
        lint = command_heads(steps[("backend-lint", "Ruff lint")])
        form = command_heads(steps[("backend-lint", "Format check")])
        self.assertLessEqual({"ruff", "check"}, lint)
        self.assertLessEqual({"ruff", "format"}, form)
        self.assertNotEqual(lint, form)
        self.assertLessEqual(
            {"alembic", "upgrade"},
            command_heads(
                steps[("backend-tests", "Migrations build the production schema")]
            ),
        )
        self.assertLessEqual(
            {"alembic", "check"},
            command_heads(steps[("backend-tests", "Models match the migrated schema")]),
        )
        self.assertLessEqual(
            {"python", "uvicorn", "curl", "grep", "test"},
            command_heads(steps[("backend-tests", "Runtime smoke under uvicorn")]),
        )
        self.assertLessEqual(
            {"docker", "sh", "alembic"},
            command_heads(steps[("docker-build", "Verify image")]),
        )
        self.assertEqual(
            command_heads(steps[("frontend-check", "Build")]), {"npm", "run"}
        )

    # Сводный блок гейта: три счётчика, три кода, затем зелёный выход.
    SUMMARY_FIXTURE = (
        'if [ "$FAILED" -gt 0 ]; then\n    echo "x"\n    exit 1\nfi\n'
        'if [ "$ENV_MISSING" = "1" ]; then\n    echo "y"\n    exit 2\nfi\n'
        'if [ "$UNAVAILABLE" -gt 0 ]; then\n    echo "z"\n    exit 3\nfi\n'
        'echo "green"\n'
    )

    def test_exit_accounting_is_read_block_by_block(self):
        """Схлопнутый или переоформленный блок учёта — находка, а не «всё сходно».

        Здесь живёт отличие кода 3 от кода 0, и если разбор читает только
        «в файле есть exit», то заменённый на `exit 0` шаг «проверено не всё»
        пройдёт зелёным.
        """
        self.assertEqual(
            gate_exit_map(self.SUMMARY_FIXTURE),
            {"FAILED": 1, "ENV_MISSING": 2, "UNAVAILABLE": 3},
        )
        self.assertEqual(
            gate_exit_map(self.SUMMARY_FIXTURE.replace("    exit 3", "    exit 0"))[
                "UNAVAILABLE"
            ],
            0,
        )
        self.assertNotIn(
            "ENV_MISSING",
            gate_exit_map(self.SUMMARY_FIXTURE.replace('"$ENV_MISSING"', '"$OTHER"')),
            "счётчик без блока учёта должен исчезать из разбора, а не доставать код",
        )

    def test_exit_list_is_read_entry_by_entry(self):
        """Перечень кодов в прозе читается по записям, а не «в тексте есть цифра»."""
        line = "The exit code is the honest part — 0: green; 1: failed; 2: env; 3: skipped.\n"
        self.assertEqual(documented_exit_codes(line), [0, 1, 2, 3])
        self.assertEqual(
            documented_exit_codes(line.replace("; 3: skipped", "")), [0, 1, 2]
        )
        self.assertEqual(documented_exit_codes("no list in this half\n"), [])
        # Версия инструмента — не код: без ограничения «не цифра и не точка»
        # восьмёрка из `0.15.8:` попала бы в перечень.
        self.assertEqual(
            documented_exit_codes("exit code — 0: green; ruff 0.15.8: p.\n"), [0]
        )

    def test_header_block_stops_at_the_blank_comment(self):
        """Шапка читается до пустой строки комментария, а не до конца файла."""
        script = (
            "# Коды выхода:\n"
            "#   0 — green;\n"
            "#   1 — failed;\n"
            "#\n"
            "#   9 — это уже другой блок\n"
        )
        self.assertEqual(header_exit_codes(script), [0, 1])
        self.assertEqual(header_exit_codes("# заголовка нет\n"), [])
        # Без завершающей пустой строки комментария блок читается до конца файла.
        self.assertEqual(
            header_exit_codes("# Коды выхода:\n#   0 — green;\n#   3 — skipped\n"),
            [0, 3],
        )

    # Ровно та реализация, что стояла в gate.sh до разбора скобок: порт по
    # умолчанию она подставляет верно, ошибается только на IPv6.
    NAIVE_HOSTPORT = r"""_hostport() {
    local rest="${1#*://}"
    rest="${rest%%\?*}"
    rest="${rest##*@}"
    rest="${rest%%/*}"
    local host="${rest%%:*}" port="${rest##*:}"
    [ "$port" = "$host" ] && port=""
    printf '%s %s' "${host:-127.0.0.1}" "${port:-$2}"
}
"""

    def test_naive_host_split_is_blind_to_ipv6(self):
        """Таблица форм не декоративная: без скобочного разбора ошибаются ровно IPv6-строки.

        Если бы наивная реализация попадала во все формы сразу, строки таблицы
        проверяли бы только факт вызова функции, а не разбор.
        """
        if not shutil.which("bash"):
            self.fail("без bash разбор строки подключения нечем проверить")
        got = {}
        for url, default, _host, _port in HOSTPORT_FORMS:
            proc = subprocess.run(
                [
                    "bash",
                    "-c",
                    self.NAIVE_HOSTPORT + '\n_hostport "$0" "$1"',
                    url,
                    default,
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            got[url] = proc.stdout.strip()
        wrong = [
            url for url, _, host, port in HOSTPORT_FORMS if got[url] != f"{host} {port}"
        ]
        self.assertTrue(
            wrong, "наивный разбор угадал все формы — таблица ничего не проверяет"
        )
        self.assertTrue(
            all("[::1]" in url for url in wrong),
            f"ошибка не ограничилась скобками: {[(url, got[url]) for url in wrong]}",
        )


if __name__ == "__main__":
    unittest.main()
