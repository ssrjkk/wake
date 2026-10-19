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
import unittest
from unittest import mock

from pydantic import ValidationError

from config import Settings


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
        for ttl in (0, 181):
            with self.assertRaises(ValidationError):
                build(wake_session_ttl_days=ttl)

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

    def test_file_database_rejected(self):
        with self.assertRaises(ValidationError):
            build(wake_database_url="sqlite:///wake.db")


class TestListParsing(unittest.TestCase):
    def test_cors_origins_split_and_cleaned(self):
        settings = build(wake_cors_origins="http://a.test, http://b.test ,,")
        self.assertEqual(settings.cors_origins_list, ["http://a.test", "http://b.test"])

    def test_empty_trusted_proxies_is_empty_list(self):
        """Пустая строка — «прокси нет», тогда как X-Forwarded-For игнорируется и
        клиент берётся из адреса соединения."""
        self.assertEqual(build().trusted_proxy_ip_list, [])


if __name__ == "__main__":
    unittest.main()
