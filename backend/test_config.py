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


def _env_example():
    """backend/.env.example -> {имя: (значение, комментарий, блок)}.

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
    text = ENV_EXAMPLE.read_text(encoding="utf-8").replace("\r\n", "\n")
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


if __name__ == "__main__":
    unittest.main()
