"""
Конфигурация через pydantic-settings. Все переменные окружения валидируются
при старте процесса — если чего-то не хватает или значение некорректно,
приложение упадёт до первого запроса, а не в середине обработки.

Все настройки задаются через env vars. Файл .env читается автоматически,
если есть в рабочей директории.
"""

import logging
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # SQLite paths (legacy, until full PostgreSQL migration)
    wake_db_path: str = "wake.db"
    wake_audit_db_path: str = "audit.db"

    # PostgreSQL (async)
    wake_database_url: str = "postgresql+asyncpg://wake:wake@localhost:5432/wake"
    wake_db_echo: bool = False

    # Redis
    wake_redis_url: str = "redis://localhost:6379/0"

    # Dry run — реальные ордера только при false
    wake_dry_run: bool = True

    # Lighter network
    wake_lighter_network: str = "mainnet"

    # CORS — несколько источников через запятую
    wake_cors_origins: str = "http://localhost:5173"

    # Rate limiting
    wake_rate_limit_capacity: int = 40
    wake_rate_limit_refill: int = 20

    # Logging
    wake_log_level: str = "INFO"

    # Telegram
    telegram_bot_token: str = ""

    # Sentry
    sentry_dsn: str = ""
    wake_env: str = "local"

    # Lighter hosts (hardcoded — не из env, чтобы нельзя было случайно сломать)
    _lighter_hosts: dict = {
        "mainnet": "mainnet.zklighter.elliot.ai",
        "testnet": "testnet.zklighter.elliot.ai",
    }

    @field_validator("wake_lighter_network")
    @classmethod
    def validate_network(cls, v: str) -> str:
        allowed = {"mainnet", "testnet"}
        if v not in allowed:
            raise ValueError(
                f"WAKE_LIGHTER_NETWORK={v!r}: доступно только {', '.join(sorted(allowed))}"
            )
        return v

    @field_validator("wake_rate_limit_capacity", "wake_rate_limit_refill")
    @classmethod
    def validate_rate_limits(cls, v: int, info) -> int:
        if v <= 0:
            raise ValueError(f"{info.field_name} должен быть > 0, получено {v}")
        return v

    @property
    def lighter_host(self) -> str:
        return self._lighter_hosts[self.wake_lighter_network]

    @property
    def lighter_base_url(self) -> str:
        return f"https://{self.lighter_host}"

    @property
    def lighter_ws_url(self) -> str:
        return f"wss://{self.lighter_host}/stream"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.wake_cors_origins.split(",") if o.strip()]


settings = Settings()

# Logging setup
logging.basicConfig(
    level=getattr(logging, settings.wake_log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Backward compatibility — старые импорты продолжают работать
DB_PATH = settings.wake_db_path
AUDIT_DB_PATH = settings.wake_audit_db_path
DRY_RUN = settings.wake_dry_run
LIGHTER_NETWORK = settings.wake_lighter_network
LIGHTER_HOST = settings.lighter_host
LIGHTER_HOSTS = settings._lighter_hosts
LIGHTER_BASE_URL = settings.lighter_base_url
LIGHTER_WS_URL = settings.lighter_ws_url
CORS_ORIGINS = settings.cors_origins_list
RATE_LIMIT_CAPACITY = settings.wake_rate_limit_capacity
RATE_LIMIT_REFILL = settings.wake_rate_limit_refill
LOG_LEVEL = settings.wake_log_level
TELEGRAM_BOT_TOKEN = settings.telegram_bot_token
DATABASE_URL = settings.wake_database_url
REDIS_URL = settings.wake_redis_url
