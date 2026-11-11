#!/usr/bin/env bash
# Локальный прогон ровно тех проверок, которые считает CI.
#
# Почему файл существует. До него «полный гейт» был списком в голове и абзацем
# в CONTRIBUTING. Список в голове у того, кто его запускает, всегда короче
# списка, который проверяет CI: на bfeb048 локально были прогнаны `ruff check`
# и 812 тестов, а красный шаг назывался `ruff format --check` — он стоит в CI
# отдельным шагом, и локальный прогон про него просто не вспомнил. Хуже того,
# `needs: [backend-lint]` унесла вместе с форматом и backend-tests, и
# docker-build: залитый коммит не прогнал бэкэнд-набор вообще.
#
# Как это устроено. Каждый шаг помечен комментарием `# ci: <job> / <name>` —
# дословно тем именем, под которым шаг стоит в .github/workflows/ci.yml.
# backend/test_local_gate_parity.py сверяет метки с workflow: шаг, добавленный
# в CI и не появившийся здесь, краснеет; метка, ведущая на удалённый или
# переименованный шаг CI, краснеет тоже; метка без команды за ней — тоже. Так
# список перестаёт быть памятью и становится файлом.
#
# Числа из CI не пересказываются: пин ruff, версии Python/Node и список
# --ignore-vuln для pip-audit вычитываются из ci.yml в момент запуска
# (проверка «в файле нет ни одной буквы из этих значений» — там же, в гейте
# parity). Поднять пин в CI — значит заставить гейт требовать новый, а не тот,
# что был удобен в день написания скрипта.
#
# Коды выхода:
#   0 — все шаги, которые умеет эта машина, прогнаны и зелёные;
#   1 — хотя бы один шаг упал;
#   2 — прогон неполон по вине окружения: не заданы WAKE_* либо передан
#       неизвестный аргумент. С пустыми значениями бэкэнд-шаги говорили бы про
#       другую базу, а не про эту машину;
#   3 — часть шагов эта машина прогнать не может (нет инструмента). Зелёным
#       такой прогон не становится: код 3 означает «проверено не всё,
#       остальное смотрит CI».
#
# Запуск: bash scripts/gate.sh            — полный прогон
#         bash scripts/gate.sh --list     — только реестр зеркалимых шагов:
#                                           ничего не запускает, ничего не
#                                           ставит и не лезет в окружение
#         bash scripts/gate.sh --check-env — только вопрос «годится ли конфигурация
#                                           бэкэнда»: 0 или 2, без шагов и без
#                                           файлов

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CI_FILE="$ROOT/.github/workflows/ci.yml"
cd "$ROOT" || exit 1

GATE_LIST=0
GATE_ENV=0
case "${1:-}" in
    "") ;;
    --list) GATE_LIST=1 ;;
    --check-env) GATE_ENV=1 ;;
    *)
        echo "неизвестный аргумент: $1 (есть только --list и --check-env)"
        exit 2
        ;;
esac

# ── значения, у которых один владелец: ci.yml ──────────────────────────────
# Если regex не находит, гейт падает на старте, а не прогоняет `ruff`
# неизвестной версии и не называет это зелёным.
RUFF_PIN="$(sed -nE 's/.*pip install "ruff==([0-9.]+)".*/\1/p' "$CI_FILE" | head -1)"
CI_PYTHON="$(sed -nE 's/^  PYTHON_VERSION: "([0-9.]+)".*/\1/p' "$CI_FILE" | head -1)"
CI_NODE="$(sed -nE 's/^  NODE_VERSION: "([0-9]+)".*/\1/p' "$CI_FILE" | head -1)"
# Имена баз тоже вычитываются, а не пересказываются: подсказка «экспортируйте
# вот это» переживёт переименование базы в workflow, а пересказанная руками —
# начнёт советовать то, чего CI больше не делает.
MIGRATE_URL="$(sed -nE 's/^ *WAKE_DATABASE_URL: ([^[:space:]]+).*/\1/p' "$CI_FILE" | head -1)"
TEST_URL="$(sed -nE 's/^ *WAKE_TEST_DATABASE_URL: ([^[:space:]]+).*/\1/p' "$CI_FILE" | head -1)"
IGNORES=()
while IFS= read -r id; do
    [ -n "$id" ] && IGNORES+=("--ignore-vuln" "$id")
done < <(grep -oE -- '--ignore-vuln +[A-Za-z0-9._-]+' "$CI_FILE" | awk '{print $2}')
if [ -z "$RUFF_PIN" ] || [ -z "$CI_PYTHON" ] || [ -z "$CI_NODE" ] ||
    [ ${#IGNORES[@]} -eq 0 ] || [ -z "$MIGRATE_URL" ] || [ -z "$TEST_URL" ]; then
    echo "ci.yml прочитан не до конца: пин ruff, версии Python/Node, имена баз"
    echo "alembic/pytest или список --ignore-vuln не найдены"
    exit 1
fi

CACHE="${WAKE_GATE_CACHE:-"${TMPDIR:-/tmp}/wake-gate"}"
# Черновый каталог нужен только прогону. В --list его создавать нечего: режим
# обещает не трогать файловую систему, и держать это обещание проще, чем
# объяснять, почему оно нарушено.
TMPDIR_GATE=""
if [ "$GATE_LIST" = "0" ] && [ "$GATE_ENV" = "0" ]; then
    TMPDIR_GATE="$(mktemp -d)" || exit 1
    trap 'rm -rf "$TMPDIR_GATE"' EXIT
fi

# ── учёт результатов ───────────────────────────────────────────────────────
declare -a SUMMARY=()
FAILED=0
UNAVAILABLE=0
ENV_MISSING=0

record() {
    local status="$1" label="$2" detail="${3:-}"
    SUMMARY+=("$(printf '%-10s %s%s' "$status" "$label" "${detail:+ — $detail}")")
    printf '%s  %s%s\n' "$status" "$label" "${detail:+ — $detail}"
}

# step <job> <name> <команда> — прогон шага под его CI-именем.
step() {
    local job="$1" name="$2" cmd="$3"
    local label="$job / $name"
    if [ "$GATE_LIST" = "1" ]; then
        echo "$label"
        return 0
    fi
    echo ""
    echo "=== $label"
    if (eval "$cmd") >"$TMPDIR_GATE/step.log" 2>&1; then
        tail -n 5 "$TMPDIR_GATE/step.log"
        record "OK" "$label"
    else
        local code=$?
        tail -n 25 "$TMPDIR_GATE/step.log"
        record "FAIL" "$label" "exit=$code"
        FAILED=$((FAILED + 1))
    fi
}

# unavailable <job> <name> <причина> — шаг, который эта машина не прогоняет.
# Не молчит: строка в сводке плюс код выхода 3 вместо нуля.
unavailable() {
    record "НЕТ_ИНСТР" "$1 / $2" "$3"
    [ "$GATE_LIST" = "1" ] && return 0
    UNAVAILABLE=$((UNAVAILABLE + 1))
}

# ── ruff ровно той версии, что пинит CI ────────────────────────────────────
# CONTRIBUTING говорит «другой ruff расходится с CI в форматировании», и это
# ровно тот класс, на котором CI покраснел: локальный ruff здесь новее пина.
# Ставить пин в глобальный интерпретатор нельзя (им пользуются другие проекты),
# поэтому заведён отдельный venv в черновом каталоге, один на версию.
ensure_ruff() {
    if command -v ruff >/dev/null 2>&1 &&
        [ "$(ruff --version 2>/dev/null | awk '{print $2}')" = "$RUFF_PIN" ]; then
        RUFF="ruff"
        return 0
    fi
    local venv="$CACHE/ruff-$RUFF_PIN"
    local exe="$venv/bin/ruff"
    [ -x "$venv/Scripts/ruff.exe" ] && exe="$venv/Scripts/ruff.exe"
    if [ ! -x "$exe" ]; then
        mkdir -p "$CACHE" || return 1
        python -m venv "$venv" >/dev/null 2>&1 || return 1
        "$venv/bin/python" -m pip install --quiet --disable-pip-version-check \
            "ruff==$RUFF_PIN" >/dev/null 2>&1 ||
            "$venv/Scripts/python.exe" -m pip install --quiet --disable-pip-version-check \
                "ruff==$RUFF_PIN" >/dev/null 2>&1 || return 1
    fi
    [ -x "$exe" ] || return 1
    RUFF="$exe"
    return 0
}

# ── окружение бэкэнда ──────────────────────────────────────────────────────
# CI задаёт WAKE_* своим env-блоком; здесь они берутся из окружения. В скрипт
# значения не пишутся: скрипт лежит в открытом репозитории. Отдельно и жёстко
# проверяется имя базы — в CI у alembic и у pytest разные базы, и локальный
# прогон не должен начать миграции там, где живые данные.
db_env_ready() {
    local var missing=0 refused=0
    for var in WAKE_DATABASE_URL WAKE_TEST_DATABASE_URL WAKE_REDIS_URL WAKE_SESSION_SECRET; do
        if [ -z "${!var:-}" ]; then
            echo "не задано $var — бэкэнд-шаги говорили бы не про эту машину"
            missing=1
        fi
    done
    [ "$missing" = "1" ] && return 1
    for var in WAKE_DATABASE_URL WAKE_TEST_DATABASE_URL; do
        if [ "$(_db_name "${!var}")" = "wake" ]; then
            echo "$var указывает на базу wake — это продакшн, гейт в него не ходит"
            refused=1
        fi
    done
    if [ "$refused" = "1" ]; then
        # Подсказка печатается один раз на обе переменные: оператор поправляет
        # export целиком, а не методом «запустил — увидел одну строку».
        echo "в CI те же шаги идут с WAKE_DATABASE_URL=$MIGRATE_URL"
        echo "и WAKE_TEST_DATABASE_URL=$TEST_URL"
        return 1
    fi
    return 0
}

# _unquote <строка> → percent-раскодирование, как его делает драйвер.
# Разбор «%XX» вручную здесь не нужен: после проверки, что каждый `%` стоит
# перед двумя hex-цифрами, остаётся только заменить «%» на «\x» и отдаться
# printf %b. Кривые написания («%ZZ», висящий «%») возвращаются как есть —
# ровно так же делает unquote из stdlib, и имя с таким хвостом не может
# оказаться «wake» ни в одной из реализаций.
_unquote() {
    local s="$1" esc=$'\\x'
    case "$s" in
        # Висящий «%», «%» с одной цифрой и «%» не перед hex — то, что
        # unquote из stdlib оставляет как есть.
        *% | *%[0-9A-Fa-f] | *%[!0-9A-Fa-f]* | *%[0-9A-Fa-f][!0-9A-Fa-f]*)
            printf '%s' "$s"
            ;;
        *%*) printf '%b' "${s//%/$esc}" ;;
        *) printf '%s' "$s" ;;
    esac
}

# _db_name <url> → имя базы так, как его увидит драйвер.
# Разбор повторяет SQLAlchemy и диалект asyncpg — замеры лежат в MEASURED из
# backend/test_db_url.py, там же они перепроверяются прогоном диалекта: имя —
# всё после первого слэша за authority и до первого `?`, снятым ровно одним
# слэшем и раскодированным. Отсюда то, чего «последний отрезок после слэша» не
# видел: `?sslmode=require` (строка Railway, Supabase, Neon) к имени не
# приклеивается, `//wake` — это база `/wake`, а `/wake/x_test` — база с косой
# чертой в имени, и якорь драйвер от имени не отделяет. Если слэша после хоста
# нет, базы в URL нет вовсе, и asyncpg откроет базу с именем пользователя.
# Раскодирование — не косметика: в нём была дыра, строка `/%77ake` называлась
# «%77ake», страж продакшна её не узнавал, а драйвер открывал базу `wake`.
_db_name() {
    local tail="${1#*://}"
    tail="${tail%%\?*}"
    local authority="$tail" rest='' name
    case "$tail" in
        */*)
            authority="${tail%%/*}"
            rest="${tail#*/}"
            ;;
    esac
    name="$(_unquote "$rest")"
    if [ -n "$name" ]; then
        printf '%s' "$name"
        return 0
    fi
    # Пути нет: драйвер откроет базу с именем из userinfo (то, что стоит перед
    # последним `@`, до двоеточия-пароля). Без `@` имени пользователя в URL нет,
    # и тогда имя берётся из окружения запуска — гейт его не называл бы.
    case "$authority" in
        *@*)
            local userinfo="${authority%@*}"
            _unquote "${userinfo%%:*}"
            ;;
        *) printf '' ;;
    esac
}

# _hostport <url> <порт по умолчанию> → хост:порт из строки подключения.
# Скобки в «[::1]:6379» — оформление URL, а не имя хоста: getaddrinfo понимает
# адрес без них, и без их снятия хостом оказывалась одна «[«. Направление ошибки
# при этом безопасное — провал проба гейт читает как «машине нечем прогнать», а
# не как «проверено», поэтому ложнозелёным такой URL стать не может.
_hostport() {
    local rest="${1#*://}"
    rest="${rest%%\?*}"
    rest="${rest##*@}"
    rest="${rest%%/*}"
    local host port
    case "$rest" in
        \[*\]*)
            host="${rest%%\]*}"
            host="${host#\[}"
            port="${rest#*\]}"
            port="${port#:}"
            ;;
        *)
            host="${rest%%:*}"
            port="${rest##*:}"
            [ "$port" = "$host" ] && port=""
            ;;
    esac
    printf '%s %s' "${host:-127.0.0.1}" "${port:-$2}"
}

# --check-env: один вопрос — годится ли это окружение для бэкэнд-шагов.
# Отвечает до первого шага, ничего не устанавливает и не создаёт файлов, поэтому
# его можно ставить перед длинным прогоном и в тесты, которые проверяют сам
# отказ, а не пересказывают его. Отвечает он по конфигу, а не по живости:
# открыт ли порт у Postgres и Redis выясняет только прогон, и OK здесь значит
# «переменные заданы и базы названы разрешёнными», а не «шаги пройдут».
if [ "$GATE_ENV" = "1" ]; then
    if db_env_ready; then
        echo "OK  конфигурация бэкэнда годится: alembic и pytest пойдут в базы из этих URL"
        echo "    (живость Postgres и Redis проверяет прогон, а не этот режим)"
        exit 0
    fi
    exit 2
fi

# Живость сервисов отделена от падения шага: упавший на мёртвом Redis /ready —
# это «машине нечем», а не «код сломан», и код выхода у этих случаев разный.
# Иначе гейт раз за разом краснеет без причины, и его начинают игнорировать, —
# ровно та болячка, из-за которой он написан.
service_alive() {
    local host port
    read -r host port <<<"$(_hostport "$1" "$2")"
    (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null || return 1
    exec 3<&- 3>&- 2>/dev/null
    return 0
}

pg_alive() { service_alive "$WAKE_DATABASE_URL" 5432; }
redis_alive() { service_alive "$WAKE_REDIS_URL" 6379; }

# ── версии против CI ───────────────────────────────────────────────────────
# Здесь расхождение — заметка, а не остановка: интерпретатор меняет человек,
# а не скрипт, и решение о его установке вне этого файла. Но «зелёный гейт на
# python 3.14 против 3.12 в CI» не должен выглядеть как полное совпадение.
note_versions() {
    local py node
    py="$(python --version 2>&1 | awk '{print $2}' | cut -d. -f1,2)"
    node="$(node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    [ "$py" != "$CI_PYTHON" ] &&
        SUMMARY+=("$(printf '%-10s %s' 'ЗАМЕТКА' "python $py локально, CI считает на $CI_PYTHON")")
    [ "$node" != "$CI_NODE" ] &&
        SUMMARY+=("$(printf '%-10s %s' 'ЗАМЕТКА' "node v${node} локально, CI собирает на $CI_NODE")")
    return 0
}

# ── backend-lint ───────────────────────────────────────────────────────────
# Ниже — метки `# ci:` только у тех шагов CI, которые здесь прогоняются.
# Перечисленные, кто метки не имеет, не зеркалятся намеренно: их список живёт в
# allowlist backend/test_local_gate_parity.py, там же — причина по каждой
# записи, без неё allowlist превращается в свалку, ровно как список «Старые
# имена» в теме: Install Ruff, Install pip-audit, Install dependencies, Create
# the pytest database, Generate Allure report, npm ci в трёх job, npx playwright
# install --with-deps chromium. Первые четверо ставят инструмент или базу,
# пятый собирает html-отчёт из уже полученного результата, остальные
# разворачивают node_modules и браузер: краснеть на исправном коде ни один из них
# не должен, а молчать в allowlist — тем более.
if [ "$GATE_LIST" = "0" ] && ! ensure_ruff; then
    unavailable "backend-lint" "Ruff lint" "ruff $RUFF_PIN недоступен и не собрался в $CACHE"
    unavailable "backend-lint" "Format check" "ruff $RUFF_PIN недоступен и не собрался в $CACHE"
else
    # ci: backend-lint / Ruff lint
    step "backend-lint" "Ruff lint" "cd backend && \"\$RUFF\" check . --output-format=concise"
    # ci: backend-lint / Format check
    step "backend-lint" "Format check" "cd backend && \"\$RUFF\" format --check ."
fi

# ── backend-security ───────────────────────────────────────────────────────
if [ "$GATE_LIST" = "0" ] && ! command -v pip-audit >/dev/null 2>&1; then
    unavailable "backend-security" "Scan dependencies for vulnerabilities" "pip-audit не установлен"
else
    # ci: backend-security / Scan dependencies for vulnerabilities
    step "backend-security" "Scan dependencies for vulnerabilities" \
        'cd backend && audit=pip-audit
         # console-shim pip-audit на Windows из Git Bash не исполняется (exit 126),
         # и молча считать это «не проверено» нельзя: тот же инструмент с теми же
         # аргументами зовётся модулем. Проверяется сам вызов, а не имена в PATH.
         pip-audit --version >/dev/null 2>&1 || audit="python -m pip_audit"
         $audit -r requirements.txt --strict '"${IGNORES[*]}"
fi

# ci: backend-security / Upstream cap on urllib3 must still be binding
step "backend-security" "Upstream cap on urllib3 must still be binding" \
    'if pip install --dry-run --ignore-installed --quiet "urllib3>=2.1.0" "lighter-sdk>=1.1.8" >/dev/null 2>&1; then
       echo "lighter-sdk больше не запрещает urllib3>=2.1.0: пора снимать --ignore-vuln и переписывать раздел в SECURITY.md"
       exit 1
     fi
     echo "cap держится: urllib3>=2.1.0 неразрешим с lighter-sdk>=1.1.8"'

# ── backend-tests ──────────────────────────────────────────────────────────
# Пригодность окружения вычисляется один раз и по двум причинам отдельно: без
# базы не работает ни alembic, ни pytest, а без Redis падает только /ready.
BACKEND_OK=0
SMOKE_OK=0
if [ "$GATE_LIST" = "1" ]; then
    BACKEND_OK=1
    SMOKE_OK=1
elif db_env_ready; then
    pg_alive && BACKEND_OK=1
    [ "$BACKEND_OK" = "1" ] && redis_alive && SMOKE_OK=1
fi

if [ "$BACKEND_OK" = "1" ]; then
    # ci: backend-tests / Migrations build the production schema
    step "backend-tests" "Migrations build the production schema" "cd backend && alembic upgrade head"
    # ci: backend-tests / Models match the migrated schema
    step "backend-tests" "Models match the migrated schema" "cd backend && alembic check"
    # ci: backend-tests / Run tests with Allure
    step "backend-tests" "Run tests with Allure" "cd backend && python -m pytest . --tb=short -q"
    if [ "$SMOKE_OK" = "1" ]; then
        # ci: backend-tests / Runtime smoke under uvicorn
        step "backend-tests" "Runtime smoke under uvicorn" '
      cd backend
      python -m uvicorn app:app --host 127.0.0.1 --port 8137 >"$TMPDIR_GATE/uvicorn.log" 2>&1 &
      srv=$!
      for i in $(seq 1 40); do
        curl --silent --fail --max-time 5 http://127.0.0.1:8137/health >/dev/null && break
        sleep 1
      done
      ready=$(curl --silent --fail --max-time 10 http://127.0.0.1:8137/ready)
      code=$(curl --silent --output "$TMPDIR_GATE/unauth.json" --write-out "%{http_code}" --max-time 10 \
        http://127.0.0.1:8137/subscription)
      kill "$srv" 2>/dev/null
      wait "$srv" 2>/dev/null
      echo "/ready: $ready"
      echo "без токена: $(cat "$TMPDIR_GATE/unauth.json")"
      echo "$ready" | grep -q "\"status\":\"ready\"" || {
        echo "/ready не ответил ready — зависимость приложения не жива"
        cat "$TMPDIR_GATE/uvicorn.log"
        exit 1
      }
      test "$code" = "401"
      grep -q "\"code\":\"SESSION_REQUIRED\"" "$TMPDIR_GATE/unauth.json"
    '
    else
        unavailable "backend-tests" "Runtime smoke under uvicorn" \
            "Redis по WAKE_REDIS_URL не отвечает: /ready обязан сказать fail, и это не про код"
    fi
else
    ENV_MISSING=1
    unavailable "backend-tests" "Migrations build the production schema" "нет WAKE_* или база не отвечает"
    unavailable "backend-tests" "Models match the migrated schema" "нет WAKE_* или база не отвечает"
    unavailable "backend-tests" "Run tests with Allure" "нет WAKE_* или база не отвечает"
    unavailable "backend-tests" "Runtime smoke under uvicorn" "нет WAKE_* или база не отвечает"
fi

# Шаг Generate Allure report метки не имеет: он собирает html-отчёт из уже
# полученного результата тестов, ни один контракт проекта от его сборки не
# зависит, и в allowlist с причиной он назван в
# backend/test_local_gate_parity.py.

# ── фронтенд ───────────────────────────────────────────────────────────────
if [ "$GATE_LIST" = "0" ] && ! command -v npm >/dev/null 2>&1; then
    unavailable "frontend-check" "Audit frontend dependencies" "npm не установлен"
    unavailable "frontend-check" "ESLint" "npm не установлен"
    unavailable "frontend-check" "TypeScript type check" "npm не установлен"
    unavailable "frontend-check" "Build" "npm не установлен"
    unavailable "frontend-tests" "Run tests" "npm не установлен"
    unavailable "e2e-tests" "Run E2E tests" "npm не установлен"
else
    # ci: frontend-check / Audit frontend dependencies
    step "frontend-check" "Audit frontend dependencies" "npm audit"
    # ci: frontend-check / ESLint
    step "frontend-check" "ESLint" "npm run lint -- --max-warnings 0"
    # ci: frontend-check / TypeScript type check
    step "frontend-check" "TypeScript type check" "npx tsc --noEmit"
    # ci: frontend-check / Build
    step "frontend-check" "Build" "npm run build"
    # ci: frontend-tests / Run tests
    step "frontend-tests" "Run tests" "npm run test:run -- --coverage"
    # ci: e2e-tests / Run E2E tests
    step "e2e-tests" "Run E2E tests" "npm run test:e2e"
fi

# ── docker-build ───────────────────────────────────────────────────────────
if [ "$GATE_LIST" = "0" ] && ! command -v docker >/dev/null 2>&1; then
    unavailable "docker-build" "Build backend image" "docker на этой машине недоступен"
    unavailable "docker-build" "Verify image" "docker на этой машине недоступен"
else
    # ci: docker-build / Build backend image
    # В CI второй тег — `latest`, который потом забирает деплой. Локального
    # `latest` ни один деплой не читает, зато он молча переезжает на каждую
    # сборку гейта; здесь он называется gate-latest, чтобы не делать вид, что
    # нужен тому, кто его потом возьмёт.
    step "docker-build" "Build backend image" \
        "docker build -t wake-backend:gate . && docker tag wake-backend:gate wake-backend:gate-latest"
    # ci: docker-build / Verify image
    step "docker-build" "Verify image" \
        'docker run --rm --network none wake-backend:gate sh -c '"'"'python -c "import app; print(\"OK\")" && alembic heads'"'"''
fi

if [ "$GATE_LIST" = "1" ]; then
    exit 0
fi

note_versions
echo ""
echo "=== сводка"
printf '%s\n' "${SUMMARY[@]}"
echo ""
if [ "$FAILED" -gt 0 ]; then
    echo "упало шагов: $FAILED — это не гейт"
    exit 1
fi
if [ "$ENV_MISSING" = "1" ]; then
    echo "бэкэнд-шаги не прогонялись: WAKE_* не заданы или база не отвечает — код 2, не 0"
    echo "в CI те же шаги идут с WAKE_DATABASE_URL=$MIGRATE_URL"
    echo "и WAKE_TEST_DATABASE_URL=$TEST_URL"
    exit 2
fi
if [ "$UNAVAILABLE" -gt 0 ]; then
    echo "не прогнано на этой машине: $UNAVAILABLE (строки НЕТ_ИНСТР выше) — код 3, не 0"
    exit 3
fi
echo "все шаги CI, которые умеет эта машина, зелёные"
