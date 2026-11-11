"""
Проверки конфигурации (config.py).

Настройки — единственная защита от деплоя, который начинает торговать живыми
деньгами, и от входа с угадываемым секретом. Покрыть их надо до того, как они
сработают на проде, потому что цена пропуска здесь — не упавший тест, а ордер.

Значения передаются аргументами, .env и окружение запускания отключены: проверка
падает только по той причине, по которой её написали, а не потому, что в shell
случайно оказался WAKE_DRY_RUN=false.

Запуск: python -m unittest test_config -v
"""

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

from pydantic import ValidationError

from config import Settings

BACKEND = Path(__file__).parent
ENV_EXAMPLE = BACKEND / ".env.example"


def build(**values):
    """Settings без .env и без окружения: явно задано только то, что проверяется."""
    with mock.patch.dict(os.environ, {}, clear=True):
        return Settings(_env_file=None, **values)


class TestLiveTradingGate(unittest.TestCase):
    def test_mainnet_live_requires_second_flag(self):
        """Выключенный dry_run на mainnet не поднимается молча."""
        with self.assertRaises(ValidationError) as ctx:
            build(wake_dry_run=False, wake_lighter_network="mainnet")
        self.assertIn("WAKE_MAINNET_LIVE", str(ctx.exception))

    def test_mainnet_live_with_both_flags(self):
        settings = build(
            wake_dry_run=False,
            wake_lighter_network="mainnet",
            wake_mainnet_live=True,
        )
        self.assertFalse(settings.wake_dry_run)
        self.assertTrue(settings.wake_mainnet_live)

    def test_testnet_needs_no_confirmation(self):
        """На тестнете терять нечего: путь ордера проверяют именно там, и лишняя
        переменная только приучила бы ставить её не глядя."""
        settings = build(wake_dry_run=False, wake_lighter_network="testnet")
        self.assertFalse(settings.wake_dry_run)

    def test_dry_run_on_mainnet_is_the_default(self):
        settings = build(wake_dry_run=True, wake_lighter_network="mainnet")
        self.assertTrue(settings.wake_dry_run)
        self.assertFalse(settings.wake_mainnet_live)


class TestNetwork(unittest.TestCase):
    def test_unknown_network_rejected(self):
        with self.assertRaises(ValidationError):
            build(wake_lighter_network="staging")

    def test_hosts_follow_network(self):
        self.assertEqual(
            build(wake_lighter_network="testnet").lighter_base_url,
            "https://testnet.zklighter.elliot.ai",
        )
        self.assertEqual(
            build(wake_lighter_network="mainnet").lighter_ws_url,
            "wss://mainnet.zklighter.elliot.ai/stream",
        )


class TestSessionLimits(unittest.TestCase):
    def test_ttl_out_of_range_rejected(self):
        for ttl in (0, 31):
            with self.assertRaises(ValidationError):
                build(wake_session_ttl_days=ttl)

    def test_default_ttl_is_short(self):
        """7 дней, а не 30: у токена нет отзыва, и срок — единственная граница,
        после которой украденная строка перестаёт быть входом."""
        self.assertEqual(build().wake_session_ttl_days, 7)

    def test_rate_limits_must_be_positive(self):
        with self.assertRaises(ValidationError):
            build(wake_rate_limit_capacity=0)
        with self.assertRaises(ValidationError):
            build(wake_rate_limit_refill=-1)


class TestServiceAddresses(unittest.TestCase):
    """Адреса сервисов и тик резолвера читаются теми же процессами, что и всё
    остальное: агент, бот и резолвер раньше звали os.environ напрямую и не видели
    значений из .env, уходя в локальные дефолты."""

    def test_defaults_are_local(self):
        settings = build()
        self.assertEqual(settings.wake_signing_service_url, "http://localhost:8787")
        self.assertEqual(settings.wake_miniapp_url, "http://localhost:5173/")
        self.assertEqual(settings.wake_backend_url, "http://localhost:8000")
        self.assertEqual(settings.wake_predict_resolver_tick, 300)
        self.assertEqual(settings.anthropic_api_key, "")

    def test_explicit_values_win(self):
        settings = build(
            wake_signing_service_url="http://signing:8787",
            wake_predict_resolver_tick=60,
        )
        self.assertEqual(settings.wake_signing_service_url, "http://signing:8787")
        self.assertEqual(settings.wake_predict_resolver_tick, 60)

    def test_resolver_tick_must_be_positive(self):
        """Ноль — цикл без паузы, который долбит Lighter на каждом витке."""
        for tick in (0, -1):
            with self.assertRaises(ValidationError):
                build(wake_predict_resolver_tick=tick)

    def test_allowed_hosts_are_named_without_ipv6_brackets(self):
        """Скобки — оформление URL, а не имя хоста: сверка идёт по адресу без них.

        В дефолте скобок нет, значит расхождение видно только на явном значении,
        и теряет оно не «произвольный хост», а петлю: оператор, который переписал
        `[::1]` из `ip a`, получил бы 403 там, где разрешён запрос.
        """
        self.assertEqual(
            build().signing_allowed_host_list,
            ["localhost", "127.0.0.1", "::1", "signing"],
        )
        self.assertEqual(
            build(
                wake_signing_allowed_hosts="[::1], Signing,LOCALHOST"
            ).signing_allowed_host_list,
            ["::1", "signing", "localhost"],
        )


class TestDatabaseUrl(unittest.TestCase):
    def test_hosting_style_url_gets_the_async_driver(self):
        """Railway/Supabase/Neon отдают строку без драйвера — её принимают как
        есть, и первый запрос падает внутри /ready."""
        for url, rest in (
            ("postgresql://wake:pw@host:5432/db", "wake:pw@host:5432/db"),
            ("postgres://wake:pw@host:5432/db", "wake:pw@host:5432/db"),
        ):
            self.assertEqual(
                build(wake_database_url=url).wake_database_url,
                f"postgresql+asyncpg://{rest}",
            )

    def test_asyncpg_url_passed_through(self):
        url = "postgresql+asyncpg://wake:pw@host:5432/db"
        self.assertEqual(build(wake_database_url=url).wake_database_url, url)

    def test_alembic_accepts_url_encoded_credentials(self):
        result = subprocess.run(
            [sys.executable, "-m", "alembic", "upgrade", "head", "--sql"],
            cwd=Path(__file__).parent,
            env={
                **os.environ,
                "WAKE_DATABASE_URL": "postgresql+asyncpg://wake:p%40ss%25word@localhost:5432/wake_migrate",
                "WAKE_DRY_RUN": "true",
                "WAKE_MAINNET_LIVE": "false",
            },
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("CREATE TABLE", result.stdout)

    def test_file_database_rejected(self):
        with self.assertRaises(ValidationError):
            build(wake_database_url="sqlite:///wake.db")


class TestLogLevel(unittest.TestCase):
    def test_typo_is_refused_instead_of_degrading_to_info(self):
        """Прежний `getattr(logging, v.upper(), logging.INFO)` проглатывал
        опечатку: WAKE_LOG_LEVEL=debu давал INFO, и «debug не включился» нельзя
        было отличить от «debug не просили» — ровно тогда, когда логи и нужны."""
        for bad in ("debu", "warningg", "", "CRITICAL_", "verbose"):
            with self.assertRaises(ValidationError, msg=bad):
                build(wake_log_level=bad)

    def test_value_is_normalised_to_the_name_logging_uses(self):
        """Имя уровня используется дважды: в валидаторе и в getattr при
        basicConfig — нормализация в одном месте исключает пару «прошло
        валидацию, но getattr не нашёл»."""
        self.assertEqual(build(wake_log_level=" debug ").wake_log_level, "DEBUG")
        self.assertEqual(build(wake_log_level="WARNING").wake_log_level, "WARNING")


class TestListParsing(unittest.TestCase):
    def test_cors_origins_split_and_cleaned(self):
        settings = build(wake_cors_origins="http://a.test, http://b.test ,,")
        self.assertEqual(settings.cors_origins_list, ["http://a.test", "http://b.test"])

    def test_wildcard_cors_rejected(self):
        """app.py обещает «Strict CORS (no wildcards)». Со звёздочкой и
        allow_credentials=True браузер запрос всё равно отклоняет, но в конфиге
        это выглядит как политика «разрешено всем» — проверять надо на старте."""
        for bad in ("*", "https://*.pages.dev", "https://a.test, *"):
            with self.assertRaises(ValidationError, msg=bad):
                build(wake_cors_origins=bad)

    def test_non_origin_value_rejected(self):
        for bad in ("a.test", "  ", "ftp://a.test"):
            with self.assertRaises(ValidationError, msg=bad):
                build(wake_cors_origins=bad)

    def test_empty_trusted_proxies_is_empty_list(self):
        """Пустая строка — «прокси нет», тогда как X-Forwarded-For игнорируется и
        клиент берётся из адреса соединения."""
        self.assertEqual(build().trusted_proxy_ip_list, [])


DEFAULT_CLAIM = re.compile(r"дефолт(?: в коде)?\s*—\s*(\S+)", re.I)
TRIM = ".,;:"
# Ячейка «Default» таблицы: одиночный скаляр в кавычках, голое число/слово либо
# пустое значение, названное по-разному в двух версиях страницы.
EMPTY_WORDS = ("empty", "пусто")
BARE_VALUE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+-]*")
NAME_IN_CELL = re.compile(r"`([A-Z][A-Z0-9_]*)`")
# Строка таблицы настроек отличается от любой другой тем, что её первая ячейка
# состоит только из имён переменных — целиком, а не «имя и ещё слово».
NAME_CELL = re.compile(r"`[A-Z][A-Z0-9_]*`(?:\s*/\s*`[A-Z][A-Z0-9_]*`)*")
# Дефолт фронта — литерал после `||` в src/lib/config.ts.
FRONTEND_FALLBACK = re.compile(
    r'import\.meta\.env\.(VITE_[A-Z0-9_]+)\s*\|\|\s*"([^"]*)"'
)


def _readme_rows(path: Path) -> list:
    """Строки таблиц настроек README: (имена, ячейка дефолта, что влияет).

    Раздел и порядок заголовков не используются: таблицу описывает форма первой
    ячейки, поэтому переименование «Configuration» или вставка новой таблицы между
    двумя не переключают проверку на чужие строки."""
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    rows = []
    for line in text.split("\n"):
        line = line.strip()
        if not (line.startswith("|") and line.endswith("|")):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) != 3 or not NAME_CELL.fullmatch(cells[0]):
            continue
        rows.append((NAME_IN_CELL.findall(cells[0]), cells[1], cells[2]))
    return rows


def _is_frontend(names: list) -> bool:
    """К какому процессу относится строка — по префиксу имён: VITE_* читает
    сборка, остальное читают процессы бэкенда, и проверяются они по своим
    env-примерам."""
    return all(name.startswith("VITE_") for name in names)


def _values(cell: str) -> list:
    """Значения ячейки «Default» как список скаляров; проза — None на своём месте.

    Одиночное значение в кавычках не режется по слэшам: в URL их больше, чем имён
    в строке, и `postgresql+asyncpg://…` распадалось бы в четыре ячейки. Два
    значения через слэш пишутся только голо — так же, как их names в первой
    ячейке."""
    if cell.startswith("`") and cell.endswith("`") and cell.count("`") == 2:
        return [cell[1:-1]]
    values = []
    for part in (raw.strip() for raw in cell.split("/")):
        if part.lower() in EMPTY_WORDS:
            values.append("")
        elif BARE_VALUE.fullmatch(part):
            values.append(part)
        else:
            values.append(None)
    return values


def _cells(cell: str) -> list:
    """Ячейка в форме, общей для двух языков: регистр скаляра снят, проза
    осталась None — сверять нужно смысл строки, а не то, как он набран."""
    return [None if value is None else value.lower() for value in _values(cell)]


def _code_default(default) -> str:
    """Дефолт поля в той форме, в какой его пишет таблица: bool — true/false,
    остальное — str, потому что `True` в README никто не печатает."""
    if isinstance(default, bool):
        return str(default).lower()
    return str(default)


def _env_example(path: Path = ENV_EXAMPLE):
    """env-пример -> {имя: (значение, комментарий, блок)}.

    Комментарий — ровно те строки, что стоят непосредственно перед переменной:
    ими проверяются названные дефолты, иначе блок из трёх переменных приписал бы
    дефолт одной из них другой. Блок — то же самое плюс комментарий секции, если
    у переменной своего нет: обязательность LIGHTER_* описана в файле один раз над
    списком из трёх имён, и второе и третье имя обязаны её читать, а не считаться
    переменными без объяснения. Пустая строка закрывает блок, поэтому соседняя
    секция не наследует чужой комментарий.

    CRLF нормализуется здесь, а не в assert: на Windows checkout отдаёт файл с
    CRLF, и проверка той же строки обязана проходить и на Linux-прогоне CI.
    """
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    entries, comment, section = {}, [], ""
    for line in text.split("\n"):
        if line.startswith("#"):
            comment.append(line[1:].strip())
        elif re.match(r"^[A-Z0-9_]+=", line):
            attached = " ".join(comment)
            key, _, value = line.partition("=")
            entries[key] = (value.strip(), attached, attached or section)
            section = attached or section
            comment = []
        elif not line.strip():
            comment, section = [], ""
    return entries


class TestEnvExample(unittest.TestCase):
    """Переменные окружения и то, что о них написано в backend/.env.example.

    Файл — единственная инструкция для того, кто разворачивает Wake впервые, и
    расходится он с кодом молча: в нём живут те же дефолты, диапазоны и список
    уровней, что в валидаторах config.py. Проверка «переменная существует» этого
    не ловила, и в файле стояло «диапазон 1–180, дефолт 30» для WAKE_SESSION_TTL_DAYS,
    тогда как валидатор принимает 1–30, а код по умолчанию отдаёт 7. Кто прочитал
    файл, а не код, считал бы месячный срок токена штатным — при том что отзыва у
    токена нет и срок является единственной границей.

    Проверяются четыре обещания файла: переменную код действительно читает,
    названный дефолт совпадает с фактическим, диапазоны и уровни совпадают с
    валидатором, и пустое поле либо означает дефолт, либо помечено обязательным.
    """

    @classmethod
    def setUpClass(cls):
        cls.entries = _env_example()
        corpus = [
            path.read_text(encoding="utf-8", errors="replace")
            for path in sorted(BACKEND.rglob("*.py"))
            if path != ENV_EXAMPLE
        ]
        for rel in (
            "../docker-compose.yml",
            "../Dockerfile",
            "../.github/workflows/ci.yml",
        ):
            extra = (BACKEND / rel).resolve()
            if extra.exists():
                corpus.append(extra.read_text(encoding="utf-8"))
        cls.corpus = "\n".join(corpus)

    def test_every_listed_variable_is_read_by_code(self):
        """Переменная, которую никто не читает, — обещание, которого нет.

        Часть переменных минует Settings: сервис подписи и place_order_example
        читают os.environ напрямую, поэтому корпус — все исходники, а не config."""
        dead = sorted(
            key
            for key in self.entries
            if key not in self.corpus and key.lower() not in self.corpus
        )
        self.assertEqual(dead, [], f"никто не читает: {dead}")

    def test_every_setting_is_listed(self):
        missing = sorted(
            name.upper()
            for name in Settings.model_fields
            if name.upper() not in self.entries
        )
        self.assertEqual(missing, [], f"не описаны в .env.example: {missing}")

    def test_stated_defaults_are_the_real_ones(self):
        """Каждое «дефолт в коде — X» сверяется с реальным значением поля.

        Формулировка в файле вольная (типографское тире, точка или запятая на
        конце, значение через перенос строки), поэтому сравнение идёт по
        нормализованной строке: bool → true/false, числа и URL — как их отдаёт
        Settings."""
        checked = 0
        for key, (_value, comment, _block) in sorted(self.entries.items()):
            field = key.lower()
            if field not in Settings.model_fields:
                continue
            default = Settings.model_fields[field].default
            if isinstance(default, bool):
                default = str(default).lower()
            for claim in DEFAULT_CLAIM.findall(comment):
                self.assertEqual(
                    claim.strip(TRIM),
                    str(default),
                    f"{key}: в комментарии дефолт {claim.strip(TRIM)!r}, в коде {default!r}",
                )
                checked += 1
        self.assertGreaterEqual(checked, 8, "сверка не проверила ни одного дефолта")

    def test_session_ttl_range_is_what_the_validator_accepts(self):
        match = re.search(
            r"принимает (\d+)[–-](\d+)", self.entries["WAKE_SESSION_TTL_DAYS"][1]
        )
        self.assertIsNotNone(
            match, "в комментарии нет диапазона для WAKE_SESSION_TTL_DAYS"
        )
        low, high = int(match[1]), int(match[2])
        for accepted in (low, high):
            build(wake_session_ttl_days=accepted)
        for rejected in (low - 1, high + 1):
            with self.assertRaises(ValidationError, msg=rejected):
                build(wake_session_ttl_days=rejected)
        documented = re.search(
            r"дефолт в коде — (\d+)", self.entries["WAKE_SESSION_TTL_DAYS"][1]
        )
        self.assertEqual(
            int(documented[1]),
            build().wake_session_ttl_days,
            "дефолт из комментария и дефолт Settings — одно число",
        )

    def test_log_levels_are_the_ones_the_validator_accepts(self):
        """Список уровней обязан быть ровно тем набором, который проходит
        валидатор: без CRITICAL файл советует оператору уровень, который он
        отвергает, а с лишним именем — обещает то, чего нет.

        Полноту проверяет перебор имён logging: то, что валидатор принимает и
        чего нет в файле, — молча недокументированная настройка, и «все
        названные имена настоящие» этого не ловит."""
        listed = re.search(
            r"([A-Z]+(?:/[A-Z]+){2,})", self.entries["WAKE_LOG_LEVEL"][1]
        )
        self.assertIsNotNone(listed, "в комментарии нет списка уровней")
        names = listed.group(1).split("/")
        self.assertEqual(len(names), len(set(names)))
        accepted = set()
        for candidate in (
            "CRITICAL",
            "FATAL",
            "ERROR",
            "WARN",
            "WARNING",
            "INFO",
            "DEBUG",
            "NOTSET",
        ):
            try:
                build(wake_log_level=candidate)
            except ValidationError:
                continue
            accepted.add(candidate)
        self.assertEqual(
            set(names),
            accepted,
            f"в файле {sorted(names)}, принимает валидатор {sorted(accepted)}",
        )

    def test_empty_value_is_a_default_or_a_declared_requirement(self):
        """Пустое поле обещает «код возьмёт свой дефолт». Это правда не для всего
        файла: LIGHTER_ACCOUNT_INDEX, LIGHTER_API_KEY_PRIVATE_KEY и WAKE_MASTER_KEY
        дефолта не имеют, и пустая строка для них — отказ процесса, а не значение
        по умолчанию; такие переменные обязаны быть помечены словом «обязательны»."""
        for key, (value, _comment, block) in sorted(self.entries.items()):
            if value != "":
                continue
            field = key.lower()
            if field in Settings.model_fields:
                self.assertEqual(
                    Settings.model_fields[field].default,
                    "",
                    f"{key}: пустое поле обещает дефолт, а в коде он другой",
                )
                continue
            self.assertIn(
                "обязател",
                block.lower(),
                f"{key}: переменная без дефолта и без слова «обязательны» в комментарии",
            )


class TestReadmeConfigTable(unittest.TestCase):
    """Таблицы настроек в README — вторая копия дефолтов, и она не сверялась.

    `backend/.env.example` проверен этим файлом выше, `vite-env.d.ts` и
    `src/lib/config.ts` — гейтом контракта. README остаётся единственной
    инструкцией для того, кто разворачивает Wake по документу, а не по исходникам
    дефолтов, и живой пример у него уже был: `WAKE_SIGNING_SERVICE_URL` и
    `WAKE_LOG_LEVEL` читаются кодом, выставляются якорем в docker-compose и не
    были названы ни в одной из двух версий страницы — до той проверки, что их
    нашла. Молчала она потому, что числа и строки таблицы сверялись глазами:
    в README живут те же 7 дней сессии, тот же `(1–30)` и тот же набор уровней,
    что в валидаторах, и перестареть они могут в том же коммите, в котором их
    изменили, — обе строки выглядят правдоподобно.

    Отсюда четыре обещания: переменная из таблицы существует в соответствующем
    env-примере (то есть читается кодом), названный дефолт равен дефолту из кода
    (`Settings` для бэкенда, `|| "…"` в `src/lib/config.ts` для фронта),
    русская таблица называет тот же набор и с теми же значениями, и то, что
    оператор обязан настроить, из таблицы не исчезает.
    """

    ROOT = BACKEND.parent
    CONFIG_TS = ROOT / "src" / "lib" / "config.ts"
    README_NAMES = ("README.md", "README.ru.md")
    # Диапазон в третьей колонке пишется через тире (обычное или en), и это
    # единственный способ, каким таблица обещает границы валидатора.
    RANGE = re.compile(r"\((\d+)\s*[–-]\s*(\d+)\)")
    # Обязаны быть в таблице те, без чего деплой небезопасен или нерабочий:
    # два переключателя живой торговли, секрет сессии и мастер-ключ (у обоих нет
    # дефолта, и молчание о них читается как «ничего настраивать не надо»), адрес
    # и список хостов сервиса подписи, прокси (иначе весь прод в одном rate-limit
    # bucket), база с Redis и CORS. Список рукописный намеренно: выводиться он
    # может только из самого README, и проверка тогда пропускала бы именно то,
    # зачем написана, — исчезнувшую из страницы строку.
    MUST_BE_DOCUMENTED = (
        "WAKE_DATABASE_URL",
        "WAKE_REDIS_URL",
        "WAKE_DRY_RUN",
        "WAKE_MAINNET_LIVE",
        "WAKE_SESSION_SECRET",
        "WAKE_MASTER_KEY",
        "WAKE_CORS_ORIGINS",
        "WAKE_TRUSTED_PROXY_IPS",
        "WAKE_SIGNING_SERVICE_URL",
        "WAKE_SIGNING_ALLOWED_HOSTS",
    )

    @classmethod
    def setUpClass(cls):
        cls.rows = {name: _readme_rows(cls.ROOT / name) for name in cls.README_NAMES}
        cls.env_backend = set(_env_example())
        cls.env_frontend = set(_env_example(cls.ROOT / ".env.example"))
        cls.frontend_defaults = dict(
            match.groups()
            for match in FRONTEND_FALLBACK.finditer(
                cls.CONFIG_TS.read_text(encoding="utf-8")
            )
        )

    def _defaults(self):
        """Имя -> дефолт из кода в той форме, в какой его пишет таблица."""
        return {
            name.upper(): _code_default(spec.default)
            for name, spec in Settings.model_fields.items()
        }

    def test_readme_names_a_variable_the_code_reads(self):
        """Переменная таблицы обязана быть в env-примере своего процесса: он сам
        сверен с исходниками выше, и через него таблица получает связь с кодом."""
        problems = []
        for path, rows in sorted(self.rows.items()):
            for names, _default, _gates in rows:
                registry = (
                    self.env_frontend if _is_frontend(names) else self.env_backend
                )
                problems += [
                    f"{path}: {name} — в таблице есть, в env-примере его нет"
                    for name in names
                    if name not in registry
                ]
        self.assertEqual(problems, [])

    def test_readme_defaults_are_the_code_defaults(self):
        """Каждая ячейка «Default» сверяется со значением из кода.

        Форма ячейки задаёт строгость: `значение` в кавычках, голое число или
        слово сравниваются буквально, «empty/пусто» — с пустой строкой, проза
        («Railway URL») проверяется только на то, что дефолт в коде действительно
        есть и он не пустой: иначе страница описывает значение, которого нет.
        Строка с двумя именами обязана иметь два значения через слэш, и
        сравниваются они по порядку — переставленные 40 и 20 были бы зелёными
        при сверке множествами."""
        defaults = {**self._defaults(), **self.frontend_defaults}
        problems, checked = [], 0
        for path, rows in sorted(self.rows.items()):
            for names, cell, _gates in rows:
                parts = _values(cell)
                if len(parts) != len(names):
                    problems.append(
                        f"{path}: {names}: значений {len(parts)}, имён {len(names)}"
                    )
                    continue
                for name, part in zip(names, parts):
                    if part is None:
                        if name not in defaults or defaults[name] == "":
                            problems.append(
                                f"{path}: {name}: в таблице {cell!r}, "
                                "в коде дефолта нет"
                            )
                        continue
                    if name not in defaults:
                        if part != "":
                            problems.append(
                                f"{path}: {name}: обязательная переменная "
                                f"описана дефолтом {part!r}"
                            )
                        continue
                    self.assertEqual(
                        part,
                        defaults[name],
                        f"{path}: {name}: в таблице {part!r}, в коде {defaults[name]!r}",
                    )
                    checked += 1
        self.assertEqual(problems, [])
        self.assertGreaterEqual(checked, 20, "сверка не проверила ни одного дефолта")

    def test_both_languages_name_the_same_variables(self):
        """Русская таблица — не сокращение английской: одно имя, пропущенное
        в одном из двух файлов, значит, что кто-то прочитал не ту версию."""
        en, ru = (
            {name for names, _d, _g in self.rows[path] for name in names}
            for path in self.README_NAMES
        )
        self.assertEqual(sorted(en - ru), [], f"только в README.md: {sorted(en - ru)}")
        self.assertEqual(
            sorted(ru - en), [], f"только в README.ru.md: {sorted(ru - en)}"
        )
        by_name = {
            path: {
                name: cell for names, cell, _gates in self.rows[path] for name in names
            }
            for path in self.README_NAMES
        }
        for name in sorted(en & ru):
            english, russian = by_name["README.md"][name], by_name["README.ru.md"][name]
            self.assertEqual(
                _cells(english),
                _cells(russian),
                f"{name}: README.md говорит {english!r}, README.ru.md — {russian!r}",
            )

    def test_safety_switches_stay_in_the_table(self):
        """Переменные, без которых деплой небезопасен или не поднимается, не
        имеют права исчезнуть со страницы — см. причину списка в классе."""
        listed = {name for names, _d, _g in self.rows["README.md"] for name in names}
        self.assertEqual(
            sorted(set(self.MUST_BE_DOCUMENTED) - listed),
            [],
            "исчезли из таблицы README",
        )

    def test_ranges_and_lists_are_the_ones_the_validator_accepts(self):
        """Третья колонка обещает не только назначение переменной: в ней живут
        диапазон срока сессии и набор уровней логов, и оба проверяются тем же
        валидатором, что и формулировки `.env.example`."""
        levels = []
        for path in self.README_NAMES:
            rows = {
                names[0]: (cell, gates)
                for names, cell, gates in self.rows[path]
                if len(names) == 1
            }
            ttl = rows["WAKE_SESSION_TTL_DAYS"]
            match = self.RANGE.search(ttl[1])
            self.assertIsNotNone(
                match, f"{path}: в строке WAKE_SESSION_TTL_DAYS нет диапазона"
            )
            low, high = int(match[1]), int(match[2])
            for accepted in (low, high):
                build(wake_session_ttl_days=accepted)
            for rejected in (low - 1, high + 1):
                with self.assertRaises(ValidationError, msg=f"{path}: {rejected}"):
                    build(wake_session_ttl_days=rejected)
            levels.append(
                {
                    match.group(1)
                    for match in re.finditer(
                        r"`([A-Z]{3,})`", rows["WAKE_LOG_LEVEL"][1]
                    )
                }
            )
            accepted = set()
            for candidate in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"):
                try:
                    build(wake_log_level=candidate)
                except ValidationError:
                    continue
                accepted.add(candidate)
            self.assertEqual(
                levels[-1],
                accepted,
                f"{path}: таблица называет уровни {sorted(levels[-1])}, "
                f"валидатор принимает {sorted(accepted)}",
            )
        self.assertEqual(
            levels[0],
            levels[1],
            "набор уровней разнится в двух версиях страницы",
        )

    def test_the_gate_is_not_blind(self):
        """Разбор, который ничего не нашёл, сделал бы верхние проверки зелёными
        навсегда: таблица имеет право потерять строку только вместе с этим
        провалом. Пороги — измеренная полнота этой таблицы, а живое число, до
        которого дорос разбор, печатается в сообщении: пол поднимают от замера,
        а не по памяти строки в docstring."""
        for path, rows in sorted(self.rows.items()):
            backend = [row for row in rows if not _is_frontend(row[0])]
            frontend = [row for row in rows if _is_frontend(row[0])]
            names_backend = len({name for row in backend for name in row[0]})
            names_frontend = len({name for row in frontend for name in row[0]})
            self.assertGreaterEqual(
                names_backend,
                19,
                f"{path}: бэкенд-таблица разобрана не вся ({names_backend} имён)",
            )
            self.assertGreaterEqual(
                names_frontend,
                6,
                f"{path}: фронтенд-таблица разобрана не вся ({names_frontend} имён)",
            )
        defaults = len(self._defaults())
        self.assertGreaterEqual(
            defaults,
            20,
            f"Settings не разобран — сверять не с чем ({defaults} дефолтов)",
        )
        frontend_defaults = len(self.frontend_defaults)
        self.assertGreaterEqual(
            frontend_defaults,
            4,
            f"config.ts не разобран ({frontend_defaults} дефолтов)",
        )


if __name__ == "__main__":
    unittest.main()
