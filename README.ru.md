# Wake

Торговый терминал для [Lighter](https://lighter.xyz) (zk perp DEX): React-приложение, FastAPI-бэкенд и read-only Telegram-бот ([@waketrade_bot](https://t.me/waketrade_bot)) с Mini App — сайт пишет через бэкенд, бот отвечает теми же рыночными данными, что видит сайт.

Конфигурация по умолчанию — **mainnet** и `WAKE_DRY_RUN=true`: настоящие рыночные данные из реальной сети, и ни один ордер не выходит из процесса, пока вы сами не выключите dry-run.

Живой фронтенд: https://wake-7k6.pages.dev  
Живой бэкенд: https://wake-backend-production-3483.up.railway.app — `/health` отвечает `{"status":"ok","network":"mainnet","dry_run":true}`, `/ready` сейчас отвечает 503 (`database: fail, redis: fail`): процесс развёрнут, но PostgreSQL и Redis к нему не подключены. Панели с рыночными данными работают; вход, копи-трейд и Predict — нет. Путь из этого состояния в готовое описан в [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md).

## Контакты

- **Telegram:** [@ssrjkk](https://t.me/ssrjkk)
- **Wake Trade бот:** [@waketrade_bot](https://t.me/waketrade_bot)
- **GitHub:** [@ssrjkk](https://github.com/ssrjkk)

## Экраны

Снято с этой сборки на живых данных (2026-10-23), это не макеты. Панели, которым нужен бэкенд, честно показывают состояние «бэкенд недоступен»: развёрнутый процесс отвечает на `/health`, но не на `/ready`, пока к нему не подключены PostgreSQL и Redis. Скриншот с выдуманными числами был бы хуже честной пустой строки.

| | |
| --- | --- |
| ![Терминал](docs/screenshots/terminal-1440.png) | **Терминал** — прибор: цена дисплейным моно, лента тиков по часам, свечи, лента сделок, тикет ордера и список рынков, где у каждой строки ранг ликвидности по нижнему краю. Публичный REST Lighter, без бэкенда. |
| ![Обзор](docs/screenshots/overview-1440.png) | **Обзор** — ранжирование по фактическому $-обороту за 24ч, рынки Arcus, открытые рынки Predict. Само ранжирование — запрос к бэкенду, поэтому предупреждение на снимке есть текущее состояние прода. |
| ![Funding](docs/screenshots/funding-1440.png) | **Funding** — 735 живых ставок с четырёх площадок и 214 перпов Lighter, плюс кандидаты в carry там, где обе ноги есть на одной бирже. |
| ![Портфель](docs/screenshots/portfolio-1440.png) | **Портфель** — подписки из таблицы `follows` и счёт Lighter по L1-адресу; оба пустых состояния говорят, чего не хватает и где это сделать. |
| ![Discover](docs/screenshots/discover-1440.png) | **Discover** — каталог лидеров: подписчики, AUM и собственный счёт лидера на Lighter. Лидеров пока нет, и панель называет адрес бэкенда, куда она ходила. |
| ![Earn](docs/screenshots/earn-1440.png) | **Earn** — уровень подписки и состояние пробного периода; на снимке гейт публикации, потому что записи лидера ещё нет. |
| ![Predict](docs/screenshots/predict-1440.png) | **Predict** — ценовые и событийные рынки на LMSR, котировка и выплата; на снимке оба гейта: список требует бэкенд, позиция и выплата — входа. |
| ![Агент](docs/screenshots/agent-1440.png) | **Агент** — решение по каждому рынку с памятью выигрышей по рынку, доступно на trial или Pro; пустое состояние называет эндпоинт, заголовок куратора и таблицу, где лежат строки. |
| ![Risk](docs/screenshots/risk-1440.png) | **Risk** — экспозиция корзины и расчёт хеджа на единой марже Lighter; корреляции по часовым свечам. |
| ![Терминал на 390](docs/screenshots/terminal-390.png) | **Терминал на 390 px** — тот же прибор в столбик; горизонтального переполнения нет ни на одной вкладке. |
| ![Telegram-бот](docs/screenshots/bot-cards.png) | **@waketrade_bot** — HTML-карточки, которые отправляет `backend/telegram_bot.py`, отрисованные в браузере: рейтинг с кнопками тикеров и листанием, карточка цены со спарклайном по часам, funding по годовой и `/spread` по площадкам. |

## Что делает каждая панель

| Панель | Откуда данные | Работает без бэкенда Wake |
| --- | --- | --- |
| Обзор | Ранжирование рынков по настоящему $-обороту за 24ч (`/markets/overview`, 18 перпов, кэш 60 секунд) плюс открытые рынки Predict | нет |
| Терминал | Свечи и лента сделок из публичного REST Lighter; лента тиков по часам под ценой строится на тех же 48 свечах, что и график | чтение да; отправка ордера требует signing service |
| Discover | Лидеры по числу подписчиков и AUM, подписка / пауза / отписка | нет |
| Портфель | Ваши позиции на Lighter по L1-адресу (публичный REST); подписки и журнал копи-движка — из бэкенда | позиции да, состояние копи-трейдинга нет |
| Earn | Состояние подписки на копи-трейдинг и активация триала | нет |
| Predict | LMSR-рынки цен и событий: создание, котировка, резолюция, выплаты | нет |
| Агент | Решение по рынку с памятью винрейта именно на этом рынке | нет |
| Risk | Кросс-ассетная экспозиция и расчёт хеджа | нет |
| Funding | Ставка funding Lighter рядом с Binance, Bybit и Hyperliquid для одного и того же `market_id` (все четыре приходят из lighter-овского `/funding-rates`), годовая — из 24 эпох в сутки | ставки да; проверка арбитража и расчёт размера идут в бэкенд |

Три панели работают вообще без бэкенда — поэтому сайт не пустеет, когда бэкенд не поднят. Смотрите [src/lib/backend.ts](src/lib/backend.ts).

## Подключение

Оба пути идентичности заканчиваются одинаково: подписанным токеном сессии. Каждый эндпоинт, который касается чужих денег, берёт личность из этого токена, а не из поля запроса.

**Telegram.** Кнопка Login Widget рисуется, только если фронтенд собран с `VITE_TELEGRAM_BOT_NAME` (имя бота без `@`), а бэкенд запущен с `TELEGRAM_BOT_TOKEN`. Бэкенд пересобирает check-строку виджета и сравнивает HMAC (`POST /auth/telegram`), а `initData` мини-аппа проверяет отдельно (`POST /auth/telegram/init`). Без токена панель прямо говорит, что вход через Telegram выключен, вместо кнопки, которая ответит 401.

**Кошелёк.** Injected-кошельки (MetaMask, Rabby) работают без всякой настройки; QR-коннектор WalletConnect требует `VITE_WALLETCONNECT_PROJECT_ID`. Владение адресом доказывается, а не заявляется: `POST /auth/wallet/challenge` отдаёт одноразовый текст для `personal_sign` (5 минут, одно использование), `POST /auth/wallet/verify` восстанавливает адрес из подписи и отказывает, если это не тот адрес, что запрашивал. Запись follower создаётся из восстановленного checksum-адреса.

**Токен.** Любой успешный вход отвечает `{user_id, token, expires_at}`; дальше — `Authorization: Bearer <токен>`. Это `wk1.<payload>.<HMAC-SHA256>` на ключе `WAKE_SESSION_SECRET`, срок — `WAKE_SESSION_TTL_DAYS` (по умолчанию 7 дней). Серверного состояния сессий нет, и назвать чужим id в запросе себя кем-то другим больше нельзя. Без `WAKE_SESSION_SECRET` бэкенд отвечает 503, а не подписывает токены угадываемым ключом.

## Быстрый старт

### Фронтенд

```bash
npm install
cp .env.example .env    # необязательно: дефолты — mainnet + локальные сервисы
npm run dev             # http://localhost:5173
```

### Бэкенд

Бэкенду нужны PostgreSQL и Redis. Самый быстрый способ поднять всё правильно — Compose: он сначала прогоняет миграции.

```bash
docker compose up postgres redis migrate
cd backend
pip install -r requirements.txt
cp .env.example .env      # у WAKE_SESSION_SECRET дефолта нет: впишите сами
alembic upgrade head      # схему создаёт миграция, а не приложение
uvicorn app:app --reload --port 8000
```

Swagger UI — `http://localhost:8000/docs`, машиночитаемая схема (38 путей) — `/openapi.json`; в обоих видно, где нужен bearer-токен и где заголовок куратора. Запускать нужно из `backend/`: `config.py` читает `.env` относительно рабочей директории, поэтому запуск из корня репозитория молча работает с другой конфигурацией.

### Копи-трейдинг без сид-скрипта

Скрипта с демо-лидерами нет. Сначала вход кошельком, потом лидер и подписка — личность живёт в токене, поэтому примеры ниже без него не работают:

```bash
MESSAGE=$(curl -s -X POST http://localhost:8000/auth/wallet/challenge \
  -H 'Content-Type: application/json' \
  -d '{"l1_address": "0xYourAddress"}' | jq -r .message)

# Подпишите $MESSAGE кошельком (personal_sign), затем:
TOKEN=$(curl -s -X POST http://localhost:8000/auth/wallet/verify \
  -H 'Content-Type: application/json' \
  -d "{\"message\": \"$MESSAGE\", \"signature\": \"0x…\"}" | jq -r .token)

curl -X POST http://localhost:8000/leaders \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"handle": "your-handle", "fee_bps": 8}'

curl -X POST http://localhost:8000/follows \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"leader_id": "<leader_id>", "allocation_usd": 500, "max_leverage": 3}'
```

`POST /leaders` не принимает индекс аккаунта: он берётся из записи follower, которую создал вход кошельком, — иначе карточка лидера показывала бы чужую статистику. Индекс Lighter появляется там, только если адрес нашёлся на Lighter при входе, поэтому Telegram-сессия без кошелька получает 403 `LIGHTER_ACCOUNT_NOT_LINKED`.

Публикация — состояние в базе, а не в памяти вкладки:

```bash
curl -s http://localhost:8000/leaders/mine -H "Authorization: Bearer $TOKEN"
curl -X PATCH http://localhost:8000/leaders/<leader_id>/active \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"active": false}'
```

Публичный `GET /leaders` (витрина Discover) отдаёт только опубликованных лидеров — поэтому свою запись читают через `/leaders/mine`: без флага `active` «выключен» и «никогда не публиковался» были бы одним пустым ответом. `PATCH /leaders/{id}/active` доступен владельцу лидера, и в теле обязан быть JSON-boolean: `1` и `"yes"` отвергаются, а не читаются как истина. Выключенный лидер уходит из Discover, а `active_follows_for_leader()` не отдаёт строк — это единственный запрос, из которого подписчиков берут и `leader_listener.py`, и `POST /simulate-mirror`. Строка лидера, подписки и mirror_log при этом остаются, но новых ордеров из его сделок не выводится. Повторный `POST /leaders` публикует ту же запись снова. В интерфейсе это переключатель «Публиковать мои сделки» во вкладке «Терминал»: он читает сервер и пишет на сервер, поэтому перезагрузка страницы показывает то же, что видит копи-движок.

Листенер, который превращает изменения позиции лидера в ордера подписчиков, запускается на каждого лидера:

```bash
cd backend
python leader_listener.py --leader-id <leader_id> --account-index 12345
```

С `WAKE_DRY_RUN=true` он пишет план зеркалирования в лог и ничего не подписывает.

### Signing service

```bash
cd backend
uvicorn signing_service:app --port 8787
```

Нужны `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX` и `LIGHTER_API_KEY_PRIVATE_KEY` (api key с app.lighter.xyz — не приватный ключ кошелька). Терминал шлёт ордера именно сюда, а не в бэкенд.

### Telegram-бот и Mini App

```bash
cd backend
python telegram_bot.py     # берёт TELEGRAM_BOT_TOKEN из окружения
```

Команды: `/price BTC`, `/markets`, `/funding`, `/spread BTC`, `/predict` (`/predict resolved`), `/wake`, `/help`. Написанное голым текстом название (`BTC`, `eth`, `BTC-USDC`) — тот же `/price`: синтаксис команд никто не помнит. Ответы — HTML-карточки: числа стоят в моноширинном блоке, поэтому колонки оборота за 24ч действительно выровнены, а список рынков отдаёт тикеры кнопками — следующий рынок выбирается тапом, а не ручным вводом. Список листается (`ещё →`), и номера мест на второй странице продолжаются (11, 12, …), а не начинаются с единицы.

`/spread BTC` отвечает по тому же активу со всех площадок, которые называет Lighter (lighter, binance, bybit, hyperliquid), через `funding_arb.venue_rate_rows` — ту же функцию, чей ответ отдаёт `GET /funding/venues`. Спад здесь намеренно не считается и к годовой не приводится: эпохи выплат у площадок разные, и сведение этих чисел к общему знаменателю без проверки было бы неправдой, сказанной ради удобства.

Кнопка «Открыть Wake» несёт то, на что вы смотрели: карточка BTC открывает `?tab=terminal&asset=BTC`, ответ по funding — `?tab=funding`, Predict — `?tab=predict`. Оба параметра в `src/lib/deeplink.ts` сначала сверяются со списком вкладок и профилем тикера.

Меню команд проставляется в Telegram при старте (`set_my_commands`): без него автодополнение по «/» пустое, и про возможности бота можно узнать только из чужого скриншота. Если меню поставить не удалось, бот пишет об этом в лог и продолжает работать: меню — это подсказка, а не зависимость.

Откуда именно берутся числа — это то, что решает, могут ли бот и сайт расходиться:

| Команда | Источник | Нужен бэкенд Wake |
| --- | --- | --- |
| `/price`, `/markets` | `lighter_rest.py` — публичный REST Lighter, тот же клиент и та же `WAKE_LIGHTER_NETWORK`, что у «Терминала» | нет |
| `/funding` | `funding_arb.funding_rate_rows` — та же функция, ответ которой отдаёт `GET /funding/rates` | нет |
| `/spread` | `funding_arb.venue_rate_rows` — та же функция, ответ которой отдаёт `GET /funding/venues` | нет |
| `/predict` | `GET /predict/markets` на `WAKE_BACKEND_URL` | да: рынки живут в базе Wake |

Если бэкенд недоступен, `/predict` так и пишет и называет в сообщении `WAKE_BACKEND_URL`, а не показывает пустой список. Внутри docker-compose эта переменная — `http://app:8000`: в контейнере бота на `localhost:8000` слушать некому.

`WAKE_MINIAPP_URL` — адрес, который открывает кнопка «Открыть Wake». Bot API отбраковывает кнопку `web_app` с не-https адресом, и не кнопку, а весь ответ целиком; поэтому на http-адресе бот кнопку не ставит, объясняет причину в `/start` и пишет о ней в лог на старте, а не падает на каждом сообщении.

Бот read-only по устройству: сессии, ключа и account index у него нет, и из сообщения Telegram в проекте не осталось ни одного пути к `/place-order`.

### Резолвер Predict

```bash
cd backend
python predict_resolver.py --loop     # один тик без --loop
```

Price-рынки закрываются по дедлайну только пока этот процесс работает; иначе резолюция остаётся ручным триггером куратора. Интервал — `WAKE_PREDICT_RESOLVER_TICK` (по умолчанию 300 секунд).

## Конфигурация

### Фронтенд (`.env`, Vite читает его при сборке)

| Переменная | Дефолт | Зачем |
| --- | --- | --- |
| `VITE_LIGHTER_NETWORK` | `mainnet` | должна совпадать с `WAKE_LIGHTER_NETWORK` бэкенда, иначе сайт и бот покажут разные market id |
| `VITE_BACKEND_URL` | Railway URL | зашивается в бандл, в рантайме не меняется; для локальной разработки задайте `http://localhost:8000` в `.env`, но боевая сборка значение на loopback отклоняет |
| `VITE_SIGNING_SERVICE_URL` | `http://localhost:8787` | |
| `VITE_WALLETCONNECT_PROJECT_ID` | пусто | без него нет QR-коннектора; injected-кошельки работают и так |
| `VITE_TELEGRAM_BOT_NAME` | пусто | пусто — панель входа через Telegram выключена |
| `VITE_SENTRY_DSN` | пусто | держать пустым, пока проект реально не подключён |

### Бэкенд (`backend/.env`)

Все переменные с их кодовыми дефолтами описаны в [backend/.env.example](backend/.env.example). Те, что меняют поведение:

| Переменная | Дефолт | На что влияет |
| --- | --- | --- |
| `WAKE_DATABASE_URL` | `postgresql+asyncpg://wake:wake@localhost:5432/wake` | единственное хранилище: копи-трейдинг, Predict, подписки, история агента, аудит. Строка `postgresql://…` от хостинга принимается — драйвер asyncpg дописывается на валидации |
| `WAKE_REDIS_URL` | `redis://localhost:6379/0` | token bucket и wallet-challenge; без Redis `/ready` отвечает 503, и вход тоже 503 |
| `WAKE_LIGHTER_NETWORK` | `mainnet` | из имени сети берутся REST-хост, WS-хост и market ids — вместе |
| `WAKE_DRY_RUN` | `true` | `false` означает живые ордера на реальные деньги |
| `WAKE_MAINNET_LIVE` | `false` | второй переключатель: `WAKE_DRY_RUN=false` на mainnet без него не стартует |
| `WAKE_CORS_ORIGINS` | `http://localhost:5173` | список фронтендов через запятую |
| `WAKE_SESSION_SECRET` | пусто | подписывает токены сессии; пусто — любой вход отвечает 503, а не подписывает токены угадываемым ключом |
| `WAKE_SESSION_TTL_DAYS` | 7 | сколько живёт токен (1–30) |
| `WAKE_CURATOR_TOKEN` | пусто | пусто — операторские эндпоинты отвечают 503 `CURATOR_NOT_CONFIGURED`; неверный `X-Curator-Token` — 403 |
| `WAKE_TRUSTED_PROXY_IPS` | пусто | каким соединениям разрешён `X-Forwarded-For`; пусто — побеждает адрес соединения, и за прокси весь сервис делит один bucket |
| `TELEGRAM_BOT_TOKEN` | пусто | процесс бота и проверка подписи Telegram-входа |
| `WAKE_MASTER_KEY` | пусто | шифрует хранилище ключей; хранить в секрет-менеджере, не на диске |
| `WAKE_RATE_LIMIT_CAPACITY` / `WAKE_RATE_LIMIT_REFILL` | 40 / 20 | token bucket на вошедшего пользователя, для анонимных — на IP; запись стоит 3 токена |
| `ANTHROPIC_API_KEY` | пусто | только LLM-путь решений; без ключа агент работает на rule-движке |

## Тесты

```bash
# бэкенд — из backend/; нужна отдельная PostgreSQL-база для тестов
createdb wake_test
export WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test
python -m unittest discover        # 519 тестов, всё через discover
python -m pytest -q                # тот же набор под pytest (в CI ещё и Allure)

# фронтенд
npx tsc --noEmit
npx vitest run
npm run build

# end-to-end (поднимает свой dev-сервер; PW_PORT спасает, когда 5173 занят)
PW_PORT=5178 npx playwright test
```

`test_api_smoke.py` проходит по всем роутам поверх HTTP против настоящей PostgreSQL — в том числе те части модели безопасности, которые тише всего ломаются: нет токена, токен подделан, токена истёк, чужая запись, повторная подпись кошелька, операторский эндпоинт без заголовка. Роут, который с 403 сползает на 200, падает здесь, а не под первым кликом.

## Архитектура

### Бэкенд (FastAPI)

- `backend/app.py` — приложение, middleware (CORS, заголовки безопасности, token bucket в Redis с ключом по субъекту сессии и запасным вариантом по IP клиента, опциональный Sentry), регистрация роутеров, `/health` и `/ready`
- `backend/session.py` — выдача и проверка токена `wk1.<payload>.<HMAC>`; `backend/api/guards.py` — `require_user` / `require_curator` как зависимости роутеров
- `backend/wallet_auth.py` — хранение EIP-191 challenge в Redis, одноразовость, восстановление адреса; `backend/net.py` — адрес клиента, когда спереди стоит прокси
- `backend/api/` — HTTP-роутеры по продуктовых областям:
  - `auth.py` — вход через Login Widget, `initData` мини-аппа и кошелёк
  - `markets.py` — `/markets/overview`: ранжирование перпов по 24ч-обороту
  - `copy_trading.py` — followers, leaders, follows, журнал зеркалирования
  - `predict.py` — рынки цен и событий, резолюция под токеном куратора
  - `agent.py` — решения, память, подписки
  - `portfolio.py` — кросс-ассетный риск и хедж
  - `funding.py` — сравнение площадок и расчёты carry
- Хранилище одно — PostgreSQL: `database.py` (async-движок), `pg_models.py` (схема), `alembic/` (миграции) и репозитории `db.py`, `predict_db.py`, `agent_db.py`, `audit_log.py`, `subscription.py`
- Ядро логики — в корневых модулях, и тестируется отдельно: `mirror_engine.py`, `leader_position_tracker.py`, `predict_amm.py`, `predict_resolution.py`, `portfolio_risk.py`, `funding_arb.py`, `quant.py`, `agent_decision.py`, `agent_memory.py`, `risk_limits.py`, `rate_limiter.py`, `cache.py`
- Конфигурация читается один раз — `backend/config.py`, и каждая его собственная переменная валидируется там: недопустимое сочетание (живые ордера на mainnet без второго переключателя, не-PostgreSQL URL) останавливает процесс на старте. Несколько переменных живут вне него, потому что относятся к одному процессу: тройка ключей подписи в `signing_service.py`, `WAKE_MASTER_KEY` и `WAKE_KEYSTORE_PATH` в `encrypted_key_store.py`, `WAKE_TEST_DATABASE_URL` в тестах, `WAKE_ORDER_*` в `place_order_example.py`. Все они перечислены в `backend/.env.example` с указанием, кто именно их читает.

### Фронтенд (React + TypeScript + Vite + Tailwind + wagmi)

- `src/App.tsx` — оболочка табов, состояние подключения, пробивка здоровья бэкенда
- `src/components/` — по файлу на панель
- `src/lib/backend.ts` — единственное место, откуда идут запросы в бэкенд Wake; каждое сообщение об ошибке на панели рождается здесь
- `src/lib/session.ts` — токен сессии, полученный при входе, лежит в `localStorage` под ключом `wake.session.v1`; `backend.ts` читает его, чтобы подставить `Authorization`, а 401 токен стирает и объявляет выход
- `src/lib/wallet.ts` — вход по кошельку: запросить у бэкенда текст, подписать его через `personal_sign`, отправить подпись обратно; адрес восстанавливает сервер, поэтому клиент не может сам объявить, кто он
- `src/lib/lighter.ts` — клиент публичного REST Lighter
- `src/lib/arcus.ts` — клиент публичного REST Arcus: только чтение, и единственное место, где поля статуса и типа Arcus читаются как есть
- `src/lib/net.ts` — таймаут, под которым уходит каждый наружный запрос, и внятная формулировка того, что он истёк
- `src/lib/predict.ts`, `src/lib/telegram.ts`, `src/lib/leaders.ts`, `src/lib/config.ts`

## Деплой

### Фронтенд: Cloudflare Pages (именно он и работает)

Проект `wake` → https://wake-7k6.pages.dev.

- Проект **не** привязан к Git и не имеет конфигурации сборки на Cloudflare: артефакт собирается локально (`npm run build`, выход — `dist`) и загружается wrangler'ом. `npx wrangler pages project list` показывает `Git Provider: No`, а `builds` у проекта — null.
- Отсюда следствие, о котором лучше знать заранее: значения `VITE_*` берутся из корневого `.env` **на машине, которая собирает**, потому что у самого деплоя переменных окружения нет. Они компилируются в бандл, и смена одной из них требует пересборки и перезагрузки. `.env` с пустым `VITE_TELEGRAM_BOT_NAME` даёт сайт с выключенным входом через Telegram, и дашборд Cloudflare об этом не сообщит — именно так в прод однажды уехал не тот @-имя бота.
- Проверяйте, что реально уехало, а не лог сборки:

```bash
npx wrangler pages deployment list --project-name wake | head -5
curl -s https://wake-7k6.pages.dev/ -o /tmp/i.html
grep -o 'assets/index-[A-Za-z0-9_-]*\.js' /tmp/i.html      # имя бандла и есть id сборки
curl -s https://wake-7k6.pages.dev/assets/<это-имя>.js | grep -c waketrade_bot
```

- `public/_redirects` содержит `/* /index.html 200`, чтобы глубокие ссылки SPA открывались
- Боевая сборка не принимает `VITE_BACKEND_URL` на localhost: `npm run build`
  останавливается с причиной, вместо того чтобы выложить бандл, у которого
  «бэкенд» — машина каждого посетителя. `cp .env.example .env` — это настройка
  разработки; чтобы собрать выкладываемое, убери строку или поставь боевой адрес.

Важное следствие: Pages отвечает `index.html` со статусом 200 на **любой** неизвестный путь, поэтому запрос к API на хост без бэкенда возвращает HTML. `src/lib/backend.ts` превращает это в читаемое «по этому адресу бэкенда Wake нет» вместо SyntaxError, и панели печатают, какие три продолжают работать.

Деплой из репозитория:

```bash
npm run build
npx wrangler pages deploy dist --project-name wake
```

### Бэкенд: Railway (именно он и работает)

Образ собирается из `Dockerfile` в корне репозитория (`railway.json` настраивает сборку). Переменные задаются через дашборд Railway или CLI:

```bash
railway variables set WAKE_CORS_ORIGINS="https://wake-7k6.pages.dev"
railway variables set WAKE_SESSION_SECRET="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
railway variables set WAKE_CURATOR_TOKEN="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
```

К сервису должны быть подключены PostgreSQL и Redis, а их строки подключения — попасть в `WAKE_DATABASE_URL` и `WAKE_REDIS_URL`. Без них процесс по-прежнему отвечает на `/health` — этот эндпоинт говорит только о живости, — а `/ready` показывает правду:

```bash
curl -s "$URL/ready"
# {"status":"ready","checks":{"database":"ok","redis":"ok"}}       — подключено
# {"status":"not_ready","checks":{"database":"fail","redis":"fail"}} — не подключено
```

Схему создаёт `alembic upgrade head`, а не приложение: на Railway миграции прогоняют одноразовым деплой-командой или отдельным сервисом, который завершается (образ включает `alembic.ini` и `alembic/` именно для этого).

### Альтернатива: Docker Compose (локально или на своём хостинге)

```bash
docker compose up app              # :8000
docker compose up signing          # :8787
docker compose up telegram-bot     # нужен TELEGRAM_BOT_TOKEN
docker compose up predict-resolver
```

`app`, `signing` и `predict-resolver` ждут успешного завершения сервиса `migrate`, поэтому свежий стек поднимается на промигрированной схеме. Данные лежат в `postgres-data` и `redis-data`, в `wake-data` — только зашифрованное хранилище ключей. Секреты берутся из `backend/.env`, который `docker-compose.yml` читает, но не требует: в compose есть локальные значения для секрета сессии и токена куратора, чтобы в стек можно было войти сразу.

## Что не сделано — прямо

- `fee_bps` лидера проверяется (0–500) и сохраняется, но никогда не списывается: пути выплат нет.
- Никаких платежей. Тарифы и триалы (`backend/subscription.py`) существуют только как состояние.
- Токены сессии не отзываются: серверного хранилища сессий нет, поэтому украденный токен жив до конца `WAKE_SESSION_TTL_DAYS`, а «выйти» означает только выбросить токен на клиенте. На это пошли сознательно ради бэкенда, который переживает flush Redis, — и поэтому по умолчанию это 7 дней с жёстким потолком в 30.
- Rate limiter пропускает запросы, когда Redis недоступен: мёртвый Redis не должен отнимать терминал у того, у кого открыты позиции. `/ready` об этом сообщает, а не прячет.
- Рынки Predict — внутренний LMSR-AMM: цены и выплаты считаются по пулу в этой базе, а не по контрагенту на бирже.
- LLM-путь решений покрыт тестами на откаты (`test_llm_agent.py`) — нет ключа, сетевая ошибка, битый JSON, недопустимое действие, — но не реальным вызовом модели.
- WebSocket-соединение в `leader_listener.py` автотестами не проверяется (логику сравнения снапшотов позиций — проверяют): нужна реальная сеть.
- `handle` лидера — то, что ввёл регистрирующийся. Индекс аккаунта за ним больше не свободный текст: он берётся из записи, подтверждённой входом кошелька, но сам handle не сверяется.
- `/markets/overview` стоит 18 свечных запросов на обновление и кэшируется 60 секунд.

## Безопасность

- Секреты только из переменных окружения; `backend/.env` в .gitignore, как и `*.db`, `*.enc`.
- Личность — подписанный токен (`WAKE_SESSION_SECRET`), а не идентификатор из тела запроса: ни один эндпоинт не даёт указать, чьи позиции, подписки или тарифы хочется прочитать.
- Вход кошельком доказывает владение адресом подписью EIP-191 к одноразовому challenge; адрес восстанавливается из подписи, а индекс аккаунта Lighter берётся из серверной записи, а не из запроса.
- `WAKE_DRY_RUN` по умолчанию `true`, а выключить его на mainnet можно только вторым переключателем `WAKE_MAINNET_LIVE=true` — без него процесс не стартует. Размеры ордеров всегда округляются вниз.
- Каждый путь, который дотягивается до Lighter, — сервис подписи, листенер копи-трейдинга и раннер агента — проверяет `WAKE_DRY_RUN` в собственном процессе, прежде чем трогать SDK. Пока он включён, `/place-order` возвращает тот ордер, который отправил бы, и на биржу ничего не уходит; `/health` обоих сервисов показывает, в каком они режиме.
- Операторские эндпоинты требуют заголовок `X-Curator-Token` и сравнивают его через `hmac.compare_digest` по байтам; если токен на сервере не задан, они отвечают 500, а не создают и не резолвят рынки анонимно.
- `X-Forwarded-For` принимается только от адресов из `WAKE_TRUSTED_PROXY_IPS` и только правый элемент цепочки — иначе клиент выбирал бы сам, какой IP записать в аудит и в какой bucket rate limit.
- Весь SQL идёт через SQLAlchemy Core/ORM с связанными параметрами; строк SQL в бэкенде не собирают.
- Ключи шифруются at rest (`encrypted_key_store.py`) — это шифрование, а не HSM.
- `/health` и `/ready` не требуют токена; всё остальное, что читает или меняет состояние, требует. Ошибки приходят в одной форме — `{error: {code, message}}` — чтобы клиент ветвился по `code`, а не разбирал текст.

Для работы с реальными средствами: внешний аудит безопасности, замена файлового хранилища ключей на HSM/KMS и юридическая консультация по вашей юрисдикции. Об уязвимостях сообщать приватно — через security advisory GitHub, а не публичным issue.

## Документация

- [README.md](README.md) — английская версия
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md) — границы доверия и чеклист перед запуском
- [CHANGELOG.md](CHANGELOG.md)
- [LICENSE](LICENSE) — MIT

## Лицензия

MIT — см. [LICENSE](LICENSE).
