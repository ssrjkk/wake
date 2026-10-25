"""
Конфигурация через pydantic-settings. Все переменные окружения валидируются
при старте процесса — если чего-то не хватает или значение некорректно,
приложение упадёт до первого запроса, а не в середине обработки.

Все настройки задаются через env vars. Файл .env читается автоматически,
если есть в рабочей директории.
"""

import logging
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator, model_validator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # PostgreSQL (единственная база: подписки, аллокации, рынки предсказаний,
    # аудит — всё здесь). SQLite был бы файлом в контейнере: он переживает
    # рестарт, только если примонтован диск, а ON CONFLICT с указанием индекса,
    # строка под FOR UPDATE и регистрозависимый LIKE на нём не исполняются.
    wake_database_url: str = "postgresql+asyncpg://wake:wake@localhost:5432/wake"
    wake_db_echo: bool = False

    # Redis
    wake_redis_url: str = "redis://localhost:6379/0"

    # Сессия (session.py): подписанный токен вместо user_id из запроса. Секрет
    # обязателен для входа — без него выдача отвечает 503, а не подписывает токены
    # угадываемым ключом.
    wake_session_secret: str = ""
    # 7 дней, не 30. У токена нет отзыва (session.py прямо это говорит), и
    # основанием для этого был именно короткий срок: 30 дней «короткий» — это
    # месяц, когда украденная строка остаётся входом. Перелогин — подпись
    # кошелька или тап в Telegram, цена короткого срока мала.
    wake_session_ttl_days: int = 7

    # Токен куратора (api/predict.py): создание рынков, резолюция, ручной прогон
    # копи-движка.
    wake_curator_token: str = ""

    # IP доверенных прокси (Railway/Cloudflare) через запятую. Без этого адрес
    # клиента берётся из request.client.host, а за прокси это адрес прокси: один
    # общий bucket на весь сервис.
    wake_trusted_proxy_ips: str = ""

    # Dry run — реальные ордера только при false
    wake_dry_run: bool = True

    # Второе условие для mainnet: одного выключенного dry_run мало. Переключают
    # вручную, после того как путь ордера проверен на тестнете.
    wake_mainnet_live: bool = False

    # Lighter network
    wake_lighter_network: str = "mainnet"

    # CORS — несколько источников через запятую
    wake_cors_origins: str = "http://localhost:5173"

    # Rate limiting
    wake_rate_limit_capacity: int = 40
    wake_rate_limit_refill: int = 20

    # Копи-агент: куда летит подписанный ордер. Прямой os.environ.get() в
    # agent_runner не видел значения из .env — pydantic читает файл в себя, а не
    # в окружение процесса, и агент упорно ходил на localhost, даже когда в .env
    # стоял другой адрес.
    wake_signing_service_url: str = "http://localhost:8787"

    # Тик отдельного процесса-резолвера (predict_resolver.py), секунды.
    wake_predict_resolver_tick: int = 300

    # Telegram-бот (telegram_bot.py): по какой ссылке открывать Wake и какой
    # бэкенд дёргать для данных. Проверяется в том же месте, что и остальное.
    wake_miniapp_url: str = "http://localhost:5173/"
    wake_backend_url: str = "http://localhost:8000"

    # Ключ LLM-агента. Пустой — агент остаётся на правилном решении (llm_agent),
    # и это видно в reasoning, а не молча.
    anthropic_api_key: str = ""

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

    @field_validator("wake_database_url")
    @classmethod
    def validate_database_url(cls, v: str) -> str:
        """PostgreSQL и схема asyncpg — одна проверка на границе.

        Railway, Supabase и Neon отдают строку вида postgresql://user:pass@host/db
        без драйвера, а асинхронный движок ждёт postgresql+asyncpg://. С «голой»
        строкой падает первый же запрос, и /ready всю жизнь отвечает
        database: fail — ошибка съедается и превращается в строчку в JSON, а не в
        внятный отказ на старте. SQLite тут же закрыт явно: файл в контейнере
        переживает рестарт ровно настолько, насколько сам контейнер."""
        for bare in ("postgresql://", "postgres://"):
            if v.startswith(bare):
                return "postgresql+asyncpg://" + v[len(bare) :]
        if v.startswith("postgresql+asyncpg://"):
            return v
        raise ValueError(
            f"WAKE_DATABASE_URL={v!r}: база должна быть PostgreSQL "
            "(postgresql://… или postgresql+asyncpg://…)"
        )

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

    @field_validator("wake_predict_resolver_tick")
    @classmethod
    def validate_resolver_tick(cls, v: int) -> int:
        """Тик резолвера не может быть нулевым или отрицательным: цикл с нулем
        крутится без паузы и долбит Lighter на каждом витке."""
        if v <= 0:
            raise ValueError(f"WAKE_PREDICT_RESOLVER_TICK={v}: нужно больше нуля")
        return v

    @field_validator("wake_session_ttl_days")
    @classmethod
    def validate_session_ttl(cls, v: int) -> int:
        if not 1 <= v <= 30:
            raise ValueError(
                f"WAKE_SESSION_TTL_DAYS={v}: разумный диапазон 1–30 дней; отзыв "
                "токена не хранится, поэтому срок и есть защита"
            )
        return v

    @field_validator("wake_log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        """Уровень логов — конечный список, а не строка на вкус оператора.

        Прежний `getattr(logging, v.upper(), logging.INFO)` молча проглатывал
        опечатку: WAKE_LOG_LEVEL=debu и WAKE_LOG_LEVEL=warningg давали INFO, и
        режим «включил разбор, а в логах ничего» ничем не отличался от «debug не
        включали». Нормализация сюда же: значение сравнивается и используется
        одним написанием."""
        name = v.strip().upper()
        allowed = {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}
        if name not in allowed:
            raise ValueError(
                f"WAKE_LOG_LEVEL={v!r}: доступен {', '.join(sorted(allowed))}"
            )
        return name

    @field_validator("wake_cors_origins")
    @classmethod
    def validate_cors_origins(cls, v: str) -> str:
        """Список источников без wildcard — то, что обещает докстринг app.py.

        Звёздочка с allow_credentials=True не работает по спецификации (браузер
        её отклоняет), но в конфиге выглядит как «разрешили всем», и кто-то
        потом считает это политикой. Отказ на старте дешевле, чем иллюзия
        настроенного CORS."""
        origins = [o.strip() for o in v.split(",") if o.strip()]
        if not origins:
            raise ValueError("WAKE_CORS_ORIGINS пустой — указать источник явно")
        for origin in origins:
            if "*" in origin:
                raise ValueError(
                    f"WAKE_CORS_ORIGINS={v!r}: wildcard не разрешён, каждый "
                    "источник нужно перечислить целиком"
                )
            if not origin.startswith(("http://", "https://")):
                raise ValueError(
                    f"WAKE_CORS_ORIGINS: {origin!r} — должен быть с http:// или https://"
                )
        return v

    @model_validator(mode="after")
    def validate_live_trading(self) -> "Settings":
        """Реальные ордера на mainnet — по двум независимым переменным.

        У выключенного dry_run одно значение: опечатка в деплое или чужой коммит
        с false вывели бы торговлю живыми деньгами без всякого подтверждения.
        Тестнет с выключенным dry_run остаётся свободным — там терять нечего, и
        именно там путь ордера проверяют перед этим переключателем."""
        if self.wake_dry_run or self.wake_lighter_network != "mainnet":
            return self
        if not self.wake_mainnet_live:
            raise ValueError(
                "WAKE_DRY_RUN=false на mainnet требует WAKE_MAINNET_LIVE=true: "
                "ордера уйдут на живую сеть настоящими деньгами. Сначала проверь "
                "путь на тестнете (WAKE_LIGHTER_NETWORK=testnet), потом подтверждай "
                "отдельно."
            )
        return self

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

    @property
    def trusted_proxy_ip_list(self) -> list[str]:
        return [o.strip() for o in self.wake_trusted_proxy_ips.split(",") if o.strip()]


settings = Settings()

# Logging setup. Fallback-уровень здесь не нужен: wake_log_level прошёл
# валидатор, и список разрешённых имён известен с той же строки, что и getattr.
logging.basicConfig(
    level=getattr(logging, settings.wake_log_level),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Модульные алиасы: импортирующему коду не нужно повторять settings.<имя>.
DRY_RUN = settings.wake_dry_run
LIGHTER_NETWORK = settings.wake_lighter_network
LIGHTER_HOSTS = settings._lighter_hosts
LIGHTER_BASE_URL = settings.lighter_base_url
LIGHTER_WS_URL = settings.lighter_ws_url
CORS_ORIGINS = settings.cors_origins_list
TELEGRAM_BOT_TOKEN = settings.telegram_bot_token
DATABASE_URL = settings.wake_database_url
DB_ECHO = settings.wake_db_echo
REDIS_URL = settings.wake_redis_url
SESSION_SECRET = settings.wake_session_secret
SESSION_TTL_S = settings.wake_session_ttl_days * 86400
CURATOR_TOKEN = settings.wake_curator_token
TRUSTED_PROXY_IPS = settings.trusted_proxy_ip_list
SIGNING_SERVICE_URL = settings.wake_signing_service_url
PREDICT_RESOLVER_TICK = settings.wake_predict_resolver_tick
MINIAPP_URL = settings.wake_miniapp_url
BACKEND_URL = settings.wake_backend_url
ANTHROPIC_API_KEY = settings.anthropic_api_key
