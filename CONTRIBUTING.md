# Contributing to Wake

Wake is a trading terminal for [Lighter](https://lighter.xyz): a React frontend, a FastAPI backend and a read-only Telegram bot. The frontend writes through the backend; the bot reads Lighter's public REST with the same client the backend uses, and calls the backend only for Predict markets, which live in its database. This document covers how to get the stack running locally, which checks CI runs, and the conventions the code follows.

## What the backend needs to start

PostgreSQL and Redis. There is no file database: `backend/database.py` opens an async SQLAlchemy engine against `WAKE_DATABASE_URL`, `rate_limiter.py` keeps its token buckets in Redis, and wallet sign-in stores its single-use challenge there too. Without those services the process still starts and `/health` answers — `/health` is liveness — while `/ready` reports `database: fail, redis: fail`, and sign-in and every write fail.

## Prerequisites

| Tool | Version | Where it is pinned |
| --- | --- | --- |
| Node.js | 22 | `NODE_VERSION` in `.github/workflows/ci.yml`, `node:22-alpine` in compose |
| Python | 3.12 | `PYTHON_VERSION` in CI; the runtime image is `python:3.14-slim` |
| PostgreSQL | 16 | `postgres:16-alpine` in CI services and in compose |
| Redis | 8 | `redis:8-alpine` in CI and compose; the Python client is a separate version line — `redis>=8.1.0` in requirements |
| Ruff | 0.15.8 | installed by the CI lint job; a different ruff disagrees with CI about formatting |

## Backend setup

Everything below runs from `backend/`: alembic resolves `alembic.ini` from the working directory, and a run from the repo root used to create a second database in the wrong place.

**1. Services.** Compose gives you a matching pair, or point the variables at your own PostgreSQL and Redis:

```bash
docker compose up -d postgres redis
```

**2. Dependencies and environment.**

```bash
cd backend
pip install -r requirements.txt

export WAKE_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake
export WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test
export WAKE_REDIS_URL=redis://localhost:6379/0
export WAKE_SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export WAKE_CURATOR_TOKEN=local-curator-token
```

`backend/.env` is gitignored, so these values can live there instead of in the shell. Exported variables win over the file — `config.py` reads `env_file` after the real environment. CI has no `.env` at all, so run the gate with these exports, not with whatever your file says.

**3. Schema.**

```bash
createdb wake_test      # or: docker compose exec postgres psql -U wake -c 'CREATE DATABASE wake_test'
alembic upgrade head    # the database the app uses
```

`wake_test` only has to exist: `testsupport.py` builds its tables from the models. That is deliberate — the migrated schema and the model-derived schema are two different things, which is why CI migrates `wake_migrate` while tests run in `wake_test`.

**4. Run it.**

```bash
uvicorn app:app --reload --port 8000
curl -s localhost:8000/ready
```

Swagger UI is at `/docs`, the machine-readable schema at `/openapi.json`. Both credential types — the bearer session token and `X-Curator-Token` — are declared in the OpenAPI output, so the operator surface is discoverable without reading the source.

## Frontend setup

```bash
npm ci
cp .env.example .env    # defaults: mainnet Lighter + backend on :8000
npm run dev             # http://localhost:5173
```

`VITE_*` variables are compiled into the bundle by Vite — they are read from the root `.env`, not from `backend/.env`, and changing one needs a rebuild. Because the Pages project has no build configuration of its own, that file is what decides where a deployed bundle sends its requests; `npm run build` therefore refuses a `VITE_BACKEND_URL` on localhost and says why. Dev server (`npm run dev`) is unaffected.

## Migrations

`pg_models.py` describes the tables; `backend/alembic/versions/` creates them. After a model change:

```bash
cd backend
alembic revision --autogenerate -m "short description"
alembic upgrade head
alembic check
```

`alembic check` exits non-zero when the models and the migrations disagree. CI runs it as its own step, next to `alembic upgrade head` against a database nothing else has touched, so drift fails the pipeline instead of surfacing in production on the first query that needs the missing column. Add a new revision rather than editing a merged one.

`backend/alembic/env.py` takes its URL from `config.DATABASE_URL` rather than reading `os.environ`: migrations and the app then always address the same database, including when the value comes from `.env`.

## Tests

**Backend** — one command, 635 tests (634 passed, 1 skipped), against a real PostgreSQL:

```bash
cd backend
python -m pytest . -q
```

That is exactly what CI runs. The suite is written as `unittest.TestCase` classes, so `python -m unittest discover` collects the same tests — `test_db.py`, `test_predict_db.py`, `test_predict_integration.py` and `test_audit_log.py` included.

Four rules the suite enforces on itself (the first three come from `backend/testsupport.py`, the fourth from `test_properties.py`):

- Tests talk to a real database. `db.py`, `predict_db.py` and `audit_log.py` write PostgreSQL-specific SQL — `ON CONFLICT` against a target index, `FOR UPDATE`, `TIMESTAMPTZ`, `jsonb` — and on SQLite most of those statements never execute at all, so a stand-in would go green over a broken production query.
- `WAKE_TEST_DATABASE_URL` is required and its database must end in `_test`, because tables are TRUNCATEd before each test. A stray pytest run must not be able to empty a working database.
- `fakeredis` appears only where it is itself under test (`test_rate_limiter.py`).
- Money math is checked by invariants over seeded random input, not by fixed examples. `test_properties.py` uses `random.Random(seed)` per check, so a failure replays with the same numbers, and it adds no hypothesis dependency to `requirements.txt` or the image. Change `quant.py`, `mirror_engine.py`, `funding_arb.py`, `predict_amm.py` or `portfolio_risk.py` and those inequalities must hold for every generated input, not only for the values a fixture happens to contain.

**Frontend:**

```bash
npm ci
npm run lint                      # ESLint over src/, e2e/ and the config files
npx tsc --noEmit
npm run test:run                  # vitest: 264 tests in 19 files
node scripts/brand-assets.mjs       # re-render public/og.png and apple-touch-icon.png
npm run build
PW_PORT=5178 npx playwright test  # 70 tests; first run needs `npx playwright install chromium`
```

`src/components/theme.gate.test.ts` keeps the panel honest about its own style:
no gradients, no shadows and no blur in components (elevation lives in
`index.css`, where the theme says so), no `outline: none` without a focus ring,
and no colour literal outside the token palette — `rgba(...)` included, since a
translucent literal is the same escape from the palette wearing a different hat.
The list of legacy literals is now empty — every colour a panel paints is a
token — and the same file computes WCAG contrast from the token values
themselves: each text token on each panel surface must clear 4.5:1, dark ink on
a filled status chip too, and the focus ring 3:1. A third table takes the status
tints seriously as backgrounds: a text token is measured against its own
translucent underlay composited onto every panel, which is where `#ef4444` on
`--down-faint` sat at 4.44:1 while every "text on panel" check stayed green.
These are numbers from the palette, not opinions about a screenshot.

The same file also measures typography and mouse behaviour: no `fontSize` or
`fontFamily` literal in a panel (the scale is `--fs-*` and `--font-mono`), no
`onMouseEnter`/`onMouseLeave` handler (hover is a `:hover` rule), no
`window.confirm`. Each of those three had a concrete cost: the "200% text" check
doubles the tokens, so 219 inline pixel sizes made that gate green while half the
interface did not scale; a JS hover listener is a handler per row that does not
answer to Tab; and `window.confirm` is not shown in the Telegram Mini App, so the
unfollow button did nothing there.

`e2e/design-audit.ts` adds three browser measurements on top: every text node's
computed size must equal a live value of the theme scale (`auditTypeScale`), every
`input`/`select`/`textarea` must have an accessible name (a placeholder is not one
— it disappears on the first character), and every `[data-action]` row must contain
a focusable control, because a `<tr>` with a click handler is invisible to the
keyboard. All three failed on their first run, which is the point.

`e2e/design-gate.spec.ts` measures the same promises in a browser, on rendered
DOM: text that disappears without a scroll container and without an ellipsis,
contrast computed from resolved `getComputedStyle` colours with every translucent
layer composited (an opaque-ancestor-only probe cannot see a chip's own
background), the focus ring under real Tab navigation (`element.focus()` does not
trigger `:focus-visible` after a click, so a probe that calls it finds no
violation to find), touch target sizes (≥44 px at 390/320, ≥24 px under a
pointer, both now in the standing gate), horizontal overflow at four widths —
both `scrollWidth` of the root and the `scrollX` the page reaches when asked to
pan — and `::placeholder`, which is not in the DOM at all, so a tree walk never
saw it. Two more measured states came out of the last pass: a translucent *ink*
is composited through the whole ancestor `opacity` chain (a button at
`opacity: .45` fades its ink and its fill together, and the pair's contrast
drops with them), and one case re-runs every panel at 320 px with the type scale
doubled *plus* `.08em` of letter-spacing on every element — WCAG 1.4.10 reflow
under metrics deliberately wider than the machine's own. The inflation is what
makes that claim checkable: a row that cannot wrap is green at the author's desk
and red on the runner, because the runner's fonts are about 8 % wider (measured:
the runner put `GET /api/v1/account?by=index` at 344 px in a 320 px window and
paned the document by 24 px; the inflated pass reproduces it locally at 343 px
and 23 px, and putting `flex-wrap: nowrap` back turns it red again). The data
behind those panels comes from
`e2e/fixtures.ts`, whose row counts are measured from live responses (Lighter
`/orderBooks` 246 rows, `/funding-rates` 733, Arcus `/markets` 70, the backend's
`MAJOR_PERPS` 18, the `/mirror-log` ceiling 200) — a budget test on invented
volumes either misses the real slowdown or fails without cause.

`e2e/render-budget.spec.ts` then puts numbers on what those volumes cost: nodes
per panel, page height, mounted rows in the market picker (windowed, not all
246), whether the copy journal scrolls inside its own region instead of growing
a 10 317 px page, and how many requests a leader list costs (one hydrated
endpoint, not two requests per card). Thresholds are the measured values with
headroom: they may go down, and the test is written to fail if they go up.

Virtualisation is measured as geometry, not as a row count: the rendered pitch
of a windowed row (50 px in the picker, 40 px in the journal), the scroll range
the window promises (`scrollHeight ≥ count × pitch`), that mounted rows cover the
viewport at mid-scroll, and that scrolling to the end paints the fixture's last
row — named by symbol rather than as «some row». Those four assertions are what
caught a collapsed spacer: the picker kept 200 markets in `padBottom` styled at
9 200 px, `flex-shrink` compressed it to zero, and 180 markets could not be
reached with the mouse at all.

The gate then asks whether the window is operable without a mouse. From search,
`ArrowDown` enters the first row; `ArrowUp`/`ArrowDown`, `PageUp`/`PageDown`,
`Home` and `End` move through all 200 capped rows, scrolling the window before
focusing a row that is not mounted yet, and `Enter` selects the focused market.
The same list is measured through `390 → 1440 → 390` resize and after a deep
scroll is narrowed by a filter: rows must still cover the viewport, the row count
must come from the whole filtered book, and `scrollTop` must settle at a position
the shortened list can actually have.

Open dialogs are audited against their own shell, not the panel behind them, and
the shell itself must not acquire a horizontal scrollbar. Six states are covered
under stress fixtures at 320 px with a doubled type scale: sign-in, market
selection, order confirmation, copy confirmation, Predict trade and Risk position.
The scale test reads the computed value back (`--fs-ui: 26px`) before measuring,
because the previous version installed it after page load, never applied it, and
could remain green while the interface stayed at 13 px.

Render cost is budgeted in **frames**, not milliseconds. One build measured
295, 369, 386, 547 and 1 079 ms for a single picker open with an unchanged DOM —
a millisecond threshold on a laptop (or a loaded CI runner) is a coin flip, not a
gate. Counted in frames the same action is flat: 10 of 10 opens land on frame 2,
so the published ceiling is 3 frames.

The fixtures also have a worst-case contour (`{ stress: true }`): the same fields
with values from the edges of the range — a 24-character ticker, `1,234,567.891011`,
funding of 0.42 per hour, which prints as `367920.0%` annualised. Plausible data
hides column overflow until a real outlier arrives, and it also hides a broken
spacer height. The stress tests assert the extreme value reached the screen
before measuring it, so the contour cannot quietly become empty.

CI runs `npm run test:run -- --coverage` and `npm run test:e2e`. The e2e suite drives the frontend alone against the vite dev server — its route stubs intercept everything outside their own origin, so it neither needs nor tests the backend.

Playwright starts its own dev server with `VITE_TELEGRAM_BOT_NAME` and `VITE_WALLETCONNECT_PROJECT_ID` explicitly empty. Local `.env` values cannot skip tests or change the sign-in scenario. The Telegram component's configured path is covered by unit tests; e2e also checks keyboard focus, Escape, tab navigation and mobile overflow. `e2e/miniapp.spec.ts` runs the same page against a stub `window.Telegram.WebApp` with a Telegram user agent: it asserts the page calls `ready`/`expand` in order, paints the window from the theme tokens, moves the safe-area numbers into CSS, and closes the top panel on the header back button.

`PW_PORT` exists because the suite starts its own dev server; set it when 5173 is already taken.

## Dependencies

```bash
cd backend && pip-audit -r requirements.txt
```

CI uses `pip-audit --strict` with the exact advisory exceptions reviewed in [SECURITY.md](SECURITY.md#dependency-auditing). The SDK's `urllib3<2.1.0` constraint still blocks patched releases. New advisories, including urllib3 advisories outside that list, and audit execution errors fail the job. Exceptions do not mean the dependency is patched.

Adding a dependency: it goes into `backend/requirements.txt` (which is what the image installs) or into `package.json`. Test-only tools stay out of `requirements.txt` — `pytest`, `allure-pytest` and `fakeredis` are installed by the CI job, not by the production image.

## What CI runs

| Job | What it checks |
| --- | --- |
| backend-lint | `ruff check .` and `ruff format --check .` with ruff 0.15.8 |
| backend-security | `pip-audit --strict -r requirements.txt`, with only the reviewed advisory IDs in `SECURITY.md` excluded |
| backend-tests | creates `wake_test`, `alembic upgrade head`, `alembic check`, `pytest` with an Allure report, then a runtime smoke under real uvicorn: `/health`, `/ready` must say ready, `/subscription` without a token must answer 401 with `"code":"SESSION_REQUIRED"` |
| frontend-check | `npm audit`, `npm run lint -- --max-warnings 0`, `npx tsc --noEmit`, `npm run build` |
| frontend-tests | `npm run test:run -- --coverage` |
| e2e-tests | Playwright in chromium against the dev server |
| docker-build | builds the image on every push and every pull request to `main`, then runs `import app` and `alembic heads` inside it with no network |

The runtime smoke step is separate from the tests on purpose: inside pytest the app runs through `ASGITransport`, which never exercises startup hooks, a real connection pool or `/ready` against a real Redis.

## Code style

**Python**

- `ruff format` is the arbiter of formatting — run it instead of hand-matching its output. Line length 88, rules `E4`/`E7`/`E9`/`F`, all fixed in `backend/ruff.toml` so a ruff upgrade cannot silently change the rule set.
- Type hints where they carry information.
- Comments explain the constraint that makes a line non-obvious — why the pool is disposed inside its own loop, why a query avoids `IN` with a variable list. Code comments in the backend are in Russian; documentation and identifiers are in English.
- No `print` in the request path — log through the module logger; Sentry is wired when `SENTRY_DSN` is set.
- Secrets come from environment variables only.
- SQL is parameterized. If you find yourself formatting a query string with an input, stop.

**TypeScript / React**

- Strict mode is on; no `any` unless a boundary forces it.
- Functional components with hooks, one panel per file under `src/components/`.
- Every request to the Wake backend goes through `src/lib/backend.ts`. That is where an unreadable failure becomes a readable message; panels do not fetch on their own.
- Lighter's public REST has its own client in `src/lib/lighter.ts` — the same reason: one place for URL shapes and market ids.
- Copy in the UI names what failed and what the user can do about it. An empty panel is an invitation to act, not a shrug.

**Commits**

- Conventional prefix and a scope where it helps: `fix(ui):`, `chore(deps):`, `docs:`.
- One logical change per commit. The message says why, since the diff already says what.
- Behavior change → test change. API or configuration change → documentation change, in both READMEs.

## What to contribute

- Bug fixes with a test that reproduces them.
- Documentation corrections — the READMEs describe the running system, so a stale sentence is a bug.
- Missing test coverage, especially on paths the suite reaches only by accident.
- Performance work with a number attached to it.
- UI and UX improvements.

For anything larger, open an issue first to agree on the approach.

## Pull requests

1. Branch from `main`: `git checkout -b fix/short-name`.
2. Make the change.
3. Run the whole gate locally: ruff check and format, `alembic upgrade head` and `alembic check`, `pytest`, `lint`, `tsc`, `vitest`, `build`, Playwright.
4. Push and open a PR against `main`.

In the PR: what changed and why, which parts you verified by hand, and a reference to the issue if there is one. Keep unrelated changes out.

## Reporting issues

Include what you expected and what happened instead, the steps to reproduce, the network (`mainnet` or `testnet`), whether `WAKE_DRY_RUN` was on, versions (OS, Python, Node), and the relevant log lines. Never paste a session token, a private key, an API key index with its secret, or a bot token into an issue.

## Security

Report a vulnerability through GitHub's private vulnerability reporting, or by writing to the maintainer — not in a public issue. See [SECURITY.md](SECURITY.md) for what the project treats as its security boundaries.

Do not commit API keys, database credentials, private keys, or anything else sensitive. `backend/.env`, keystores and databases are gitignored; keep it that way and check `git status` before you add files.

## Questions

Open an issue.

---

# Contributing в Wake

Wake — торговый терминал для [Lighter](https://lighter.xyz): React-приложение, FastAPI-бэкенд и read-only Telegram-бот. Фронт пишет через бэкенд; бот читает публичный REST Lighter тем же клиентом, которым пользуется бэкенд, и обращается к бэкенду только за Predict-рынками — они живут в его базе. Здесь описано, как поднять стек локально, какие проверки делает CI и каким соглашениям следует код.

## Что нужно бэкенду для запуска

PostgreSQL и Redis. Файловой базы больше нет: `backend/database.py` открывает async-движок SQLAlchemy по `WAKE_DATABASE_URL`, `rate_limiter.py` держит token buckets в Redis, и там же лежит одноразовый challenge входа кошельком. Без этих сервисов процесс всё равно стартует и `/health` отвечает — `/health` это liveness, — но `/ready` покажет `database: fail, redis: fail`, и вход с любой записью не работают.

## Требования

| Инструмент | Версия | Где закреплено |
| --- | --- | --- |
| Node.js | 22 | `NODE_VERSION` в `.github/workflows/ci.yml`, `node:22-alpine` в compose |
| Python | 3.12 | `PYTHON_VERSION` в CI; runtime-образ — `python:3.14-slim` |
| PostgreSQL | 16 | `postgres:16-alpine` в CI и в compose |
| Redis | 8 | `redis:8-alpine` в CI и compose; python-клиент — отдельная линейка версий, `redis>=8.1.0` в requirements |
| Ruff | 0.15.8 | ставит CI-джоб линтера; другой ruff расходится с CI в форматировании |

## Настройка бэкенда

Всё ниже — из `backend/`: alembic берёт `alembic.ini` из рабочей директории, и запуск из корня когда-то молча создавал вторую базу не там.

**1. Сервисы.** Compose даёт подходящую пару; или укажите переменные на свою PostgreSQL и Redis:

```bash
docker compose up -d postgres redis
```

**2. Зависимости и окружение.**

```bash
cd backend
pip install -r requirements.txt

export WAKE_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake
export WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test
export WAKE_REDIS_URL=redis://localhost:6379/0
export WAKE_SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export WAKE_CURATOR_TOKEN=local-curator-token
```

`backend/.env` в .gitignore, так что значения можно держать там, а не в shell. Переменные окружения важнее файла — `config.py` читает `env_file` после реального окружения. В CI файла `.env` нет вообще, поэтому и гейт прогоняйте с этими export, а не с тем, что лежит у вас в файле.

**3. Схема.**

```bash
createdb wake_test      # или: docker compose exec postgres psql -U wake -c 'CREATE DATABASE wake_test'
alembic upgrade head    # база, с которой работает приложение
```

От `wake_test` нужно только существование: таблицы в ней строит `testsupport.py` по моделям. Это намеренно — схема из миграций и схема из моделей это две разные вещи, поэтому CI мигрирует `wake_migrate`, а тесты идут в `wake_test`.

**4. Запуск.**

```bash
uvicorn app:app --reload --port 8000
curl -s localhost:8000/ready
```

Swagger UI — на `/docs`, машиночитаемая схема — на `/openapi.json`. Оба типа credentials, bearer-сессия и `X-Curator-Token`, объявлены в OpenAPI, так что операторскую поверхность можно найти без чтения исходников.

## Настройка фронтенда

```bash
npm ci
cp .env.example .env    # дефолты: mainnet Lighter + бэкенд на :8000
npm run dev             # http://localhost:5173
```

Переменные `VITE_*` Vite зашивает в бандл: читаются из корневого `.env`, а не из `backend/.env`, и смена одной из них требует пересборки. Поскольку у Pages-проекта своей конфигурации сборки нет, именно этот файл решает, куда развёрнутый бандл шлёт запросы; поэтому `npm run build` отклоняет `VITE_BACKEND_URL` на localhost и объясняет причину. На dev-сервер (`npm run dev`) это не влияет.

## Миграции

`pg_models.py` описывает таблицы, `backend/alembic/versions/` их создаёт. После изменения модели:

```bash
cd backend
alembic revision --autogenerate -m "что изменилось"
alembic upgrade head
alembic check
```

`alembic check` завершается с ошибкой, если модели и миграции расходятся. В CI это отдельный шаг, рядом с `alembic upgrade head` на базе, до которой никто не дотрагивался, — так дрейф валит пайплайн, а не всплывает в проде на первом запросе, которому не хватило колонки. Новый коммит миграций добавлять не переписывая слитый.

`backend/alembic/env.py` берёт URL из `config.DATABASE_URL`, а не читает `os.environ`: миграции и приложение всегда обращаются в одну и ту же базу, в том числе когда значение пришло из `.env`.

## Тесты

**Бэкенд** — одна команда, 635 тестов (634 прошли, 1 пропущен), против настоящего PostgreSQL:

```bash
cd backend
python -m pytest . -q
```

Ровно это запускает CI. Suite написан классами `unittest.TestCase`, поэтому `python -m unittest discover` собирает те же тесты — включая `test_db.py`, `test_predict_db.py`, `test_predict_integration.py` и `test_audit_log.py`.

Четыре правила, которые suite соблюдает к самому себе (первые три — из `backend/testsupport.py`, четвёртое — из `test_properties.py`):

- Тесты идут в настоящую базу. `db.py`, `predict_db.py` и `audit_log.py` пишут PostgreSQL-специфичный SQL — `ON CONFLICT` с указанием индекса, `FOR UPDATE`, `TIMESTAMPTZ`, `jsonb`, — и на SQLite большая часть таких запросов просто не исполняется: подстава была бы зелёной над сломанным продакшн-запросом.
- `WAKE_TEST_DATABASE_URL` обязателен, и база должна оканчиваться на `_test`: перед каждым тестом таблицы очищаются TRUNCATE, так что случайный запуск pytest не должен иметь возможности стереть рабочую базу.
- `fakeredis` используется только там, где он сам и проверяется (`test_rate_limiter.py`).
- Денежная математика проверяется инвариантами на псевдослучайном входе, а не зафиксированными примерами. В `test_properties.py` у каждой проверки своё `random.Random(seed)`, поэтому упавший тест воспроизводится с теми же числами, а hypothesis не попадает ни в `requirements.txt`, ни в образ. После правки в `quant.py`, `mirror_engine.py`, `funding_arb.py`, `predict_amm.py` или `portfolio_risk.py` эти неравенства должны держаться на любом сгенерированном входе, а не только на тех значениях, которые случайно попали в фикстуру.

**Фронтенд:**

```bash
npm ci
npm run lint                      # ESLint по src/, e2e/ и конфигам
npx tsc --noEmit
npm run test:run                  # vitest: 264 теста в 19 файлах
node scripts/brand-assets.mjs       # перерендерить public/og.png и apple-touch-icon.png
npm run build
PW_PORT=5178 npx playwright test  # 70 тестов; первый прогон требует `npx playwright install chromium`
```

`src/components/theme.gate.test.ts` следит за стилем самой панели: ни градиентов,
ни теней, ни блюра в компонентах (приподнятость слоя живёт в `index.css`, где это
решила тема), ни одного `outline: none` без кольца фокуса и ни одного цвета вне
палитры токенов — `rgba(...` там же, потому что прозрачный литерал есть тот же
выход за палитру, только в другой шапке. Список наследия теперь пуст: вся окраска
панелей идёт из токенов. Тем же файлом считается и контраст — по значениям
токенов, а не глазами: каждый текстовый токен на каждой поверхности панели
обязан давать 4.5:1, тёмные чернила на залитом статусном чипе тоже, кольцо
фокуса — 3:1. Третья таблица относит к делу подложки статусов: текст меряется
против его же полупрозрачного слоя, смешанного с каждой поверхностью панели, —
именно там `#ef4444` на `--down-faint` давал 4.44:1, пока все проверки «текст на
панели» оставались зелёными.

Тот же файл следит за типографикой и за поведением мыши: ни одного `fontSize` или
`fontFamily` числом в панели (шкала — `--fs-*` и `--font-mono`), ни одного
`onMouseEnter`/`onMouseLeave` (наведение рисуется правилом `:hover`), ни одного
`window.confirm`. У каждого запрета есть конкретная цена: проверка «крупного
текста» удваивает токены, поэтому 219 литералов в пикселях держали её зелёной
там, где половина интерфейса на удвоение не реагировала; обработчик наведения —
слушатель на каждую строку, который не отвечает на Tab; а `window.confirm` в
Telegram Mini App не показывается, и кнопка отписки там молчала.

`e2e/design-audit.ts` добавляет три измерения прямо в браузере: размер каждой
надписи обязан совпасть с живым значением шкалы темы (`auditTypeScale`), у каждого
`input`/`select`/`textarea` обязано быть доступное имя (placeholder именем не
считается — он исчезает на первом символе), и внутри каждой `[data-action]`-строки
обязан найтись фокусируемый контрол, потому что `<tr>` с обработчиком для
клавиатуры невидим. Все три краснели на первом же прогоне — именно за этим они и
написаны.

`e2e/design-gate.spec.ts` меряет те же обещания в браузере на живом DOM: текст,
который исчезает без контейнера со скроллом и без многоточия; контраст по
фактически вычисленным `getComputedStyle` цветам, где смешивается каждый
полупрозрачный слой до первого непрозрачного предка (проверка, которая берёт
только непрозрачного предка, не видит подложку самого чипа) и где сквозь всю
цепочку `opacity` предков гасится и сама буква: кнопка ордера жила с
`opacity: .45` в состоянии «неактивна», а это уносит вниз контраст и букв, и её
же подложки; кольцо фокуса при настоящей Tab-навигации (после клика
`element.focus()` не включает `:focus-visible`, и проверка, которая зовёт его
сама, нарушения не нашла бы вообще); размеры целей касания (≥44 px на 390/320 и
≥24 px под указателем — обе границы теперь в постоянном гейте, а не в разовом
прогоне); `::placeholder`, которого в дереве нет вовсе, — поэтому обход дерева
его никогда не мерил; и горизонтальное переполнение на четырёх ширинах — и по
`scrollWidth` корня, и по `scrollX`, до которого страница действительно доезжает:
широкая таблица внутри статичного скролл-контейнера оставляет `body` на 320 px,
пока документ едет боком на 451. Отдельный случай прогоняет все панели на 320 px
при удвоенной шкале типов и с надбавкой `.08em` к ширине каждого знака — рефлю по
WCAG 1.4.10 под метриками, заведомо более широкими, чем у локальной машины.
Надбавка здесь именно ради того, чтобы обещание «ловит чужие шрифты» было
проверяемым числом: строка, которая не переносится, зелёная на столе автора и
красная на раннере, потому что шрифты раннера примерно на 8 % шире (замер:
раннер поставил `GET /api/v1/account?by=index` на 344 px в окне 320 и сдвинул
документ на 24 px; локально с надбавкой получается 343 px и 23 px, а
возврат `flex-wrap: nowrap` снова делает прогон красным). Данные для панелей берёт
`e2e/fixtures.ts`, а объёмы в нём — замеры живых ответов (Lighter `/orderBooks` —
246 строк, `/funding-rates` — 733, Arcus `/markets` — 70, `MAJOR_PERPS` бэкенда —
18, потолок `/mirror-log` — 200): бюджет на выдуманном объёме либо не замечает
настоящую просадку, либо краснеет без причины.

`e2e/render-budget.spec.ts` ставит числа на то, сколько этот объём стоит: узлов
на панель, высота страницы, сколько строк окна рынка живёт в DOM (окно, а не все
246), скроллится ли журнал копи-движка внутри своей области вместо страницы в
10 317 px и сколько запросов стоит список лидеров (один гидратированный эндпоинт
вместо двух на карточку). Пороги — замер с запасом: они могут только уменьшаться,
и тест написан так, чтобы рост его валил.

Виртуализация меряется геометрией, а не числом строк: отрисованный шаг строки
окна (50 px в списке рынков, 40 px в журнале), диапазон скролла, который окно
обещает (`scrollHeight ≥ число строк × шаг`), покрыта ли видимая область
отрисованными строками на середине прокрутки и доезжает ли прокрутка в конец до
последней строки фикстуры — по имени тикера, а не до «какой-то строки». Именно
эти четыре проверки поймали схлопнутую заглушку: у окна рынка нижняя заглушка
была обычным `div` внутри flex-колонки, `flex-shrink` сжал её 9 200 px до нуля,
`scrollHeight` стал 804 вместо 10 004, и 180 из 200 рынков нельзя было открыть
мышью — их находил только поиск.

Дальше та же проверка спрашивает, доступен ли список без мыши. `ArrowDown` из
поиска переходит в первую строку; стрелки, `PageUp`/`PageDown`, `Home` и `End`
ведут фокус по всем 200 строкам окна, сначала прокручивая его до ещё не
смонтированной цели, а `Enter` выбирает рынок под фокусом. Список измеряют и при
ресайзе `390 → 1440 → 390`, и после глубокой прокрутки, за которой фильтр
сокращает данные: строки обязаны накрывать видимую область, их число берётся из
всего отфильтрованного списка, а `scrollTop` обязан успокоиться на положении,
которое укороченный список действительно может иметь.

Открытые диалоги меряются по собственной оболочке, а не по панели за ними, и сама
оболочка не имеет права получать горизонтальный скролл. Под стресс-данными на
320 px при удвоенной шкале проверяются шесть состояний: вход, выбор рынка,
подтверждение ордера, подтверждение копирования, сделка Predict и добавление
позиции в Risk. Масштаб читается из computed-стиля до замера (`--fs-ui: 26px`):
прежняя версия ставила его после загрузки страницы, никогда не применяла и могла
оставаться зелёной, пока интерфейс жил своими же 13 px.

Стоимость рендера бюджется в кадрах, а не в миллисекундах. Одна и та же сборка
на один клик открытия окна давала 295, 369, 386, 547 и 1 079 мс при неизменном
дереве: порог в миллисекундах на ноутбуке — это подбрасывание монеты, а на
загруженном раннере CI — красный тест без причины. По кадрам то же действие
плоское: 10 из 10 открытий и 8 из 8 перерисовок на фильтр приходится на второй
кадр, поэтому опубликованный потолок — 3 кадра.

У фикстур есть и контур худших данных (`{ stress: true }`): те же поля со
значениями с краёв диапазона — тикер в 24 символа, `1,234,567.891011`, funding
0.42 в час (в годовых это печатается как `367920.0%`), PnL −999 999 999.
Правдоподобные числа прячут переполнение колонки до первого реального выброса, а
заодно прячут и расползание шага строк. Проверка сначала утверждает, что крайнее
значение дошло до экрана, и только потом мерит его — иначе контур мог бы зелёным
ничего не мерить.

CI запускает `npm run test:run -- --coverage` и `npm run test:e2e`. E2e-проверка работает только с фронтом против dev-сервера vite: её route-заглушки отсекают весь трафик вне собственного origin, поэтому бэкенд ей не нужен и не проверяется.

Playwright поднимает собственный dev-сервер с явно пустыми `VITE_TELEGRAM_BOT_NAME` и `VITE_WALLETCONNECT_PROJECT_ID`. Локальный `.env` больше не пропускает тесты и не меняет сценарий входа. Настроенный Telegram-виджет покрыт unit-тестами; e2e проверяет фокус с клавиатуры, Escape, навигацию по вкладкам и отсутствие переполнения на мобильном экране. `e2e/miniapp.spec.ts` гоняет ту же страницу против заглушки `window.Telegram.WebApp` с телеграмовским user agent: что страница вызывает `ready`/`expand` по порядку, красит окно токенами темы, переносит выемки экрана в CSS и закрывает верхнюю панель по стрелке «назад».

`PW_PORT` существует потому, что suite поднимает свой dev-сервер; ставьте его, когда 5173 занят.

## Зависимости

```bash
cd backend && pip-audit -r requirements.txt
```

CI использует `pip-audit --strict` с точечными исключениями, разобранными в [SECURITY.md](SECURITY.md#проверка-зависимостей). Ограничение SDK `urllib3<2.1.0` всё ещё запрещает исправленные версии. Новые уязвимости, включая новые уязвимости urllib3 вне списка, и ошибки самого аудита роняют джоб. Исключения не означают, что зависимость исправлена.

Новая зависимость идёт в `backend/requirements.txt` (его ставит образ) или в `package.json`. Тестовые инструменты в `requirements.txt` не попадают: `pytest`, `allure-pytest` и `fakeredis` ставит CI-джоб, а не продакшн-образ.

## Что прогоняет CI

| Джоб | Что проверяет |
| --- | --- |
| backend-lint | `ruff check .` и `ruff format --check .` на ruff 0.15.8 |
| backend-security | `pip-audit --strict -r requirements.txt`, исключены только разобранные в `SECURITY.md` ID уязвимостей |
| backend-tests | создаёт `wake_test`, `alembic upgrade head`, `alembic check`, `pytest` c Allure-отчётом, затем runtime-smoke под настоящим uvicorn: `/health`, `/ready` обязан ответить ready, `/subscription` без токена — 401 с `"code":"SESSION_REQUIRED"` |
| frontend-check | `npm audit`, `npm run lint -- --max-warnings 0`, `npx tsc --noEmit`, `npm run build` |
| frontend-tests | `npm run test:run -- --coverage` |
| e2e-tests | Playwright в chromium против dev-сервера |
| docker-build | собирает образ на каждый push и каждый pull request в `main`, затем внутри него без сети выполняет `import app` и `alembic heads` |

Шаг с smoke намеренно отдельный: в pytest приложение поднимается через `ASGITransport`, поэтому startup-хуки, настоящий пул соединений и `/ready` с живым Redis в тестах не исполняются никогда.

## Стиль кода

**Python**

- Форматирование определяет `ruff format` — запускайте его, а не подгоняйте вид вручную. Длина строки 88, правила `E4`/`E7`/`E9`/`F` закреплены в `backend/ruff.toml`, чтобы апгрейд ruff не поменял набор правил молча.
- Type hints там, где они несут информацию.
- Комментарий объясняет ограничение, из-за которого строка неочевидна: почему пул освобождается внутри своего цикла, почему запрос обходит `IN` со списком переменного размера. Комментарии в бэкенде на русском; документация и идентификаторы на английском.
- Никаких `print` в пути обработки запроса — логгер модуля; Sentry подключается, когда задан `SENTRY_DSN`.
- Секреты только из переменных окружения.
- SQL параметризованный. Если вы собираете текст запроса строковым форматированием с входными данными — остановитесь.

**TypeScript / React**

- Строгий режим включён; `any` только там, где его требует граница.
- Функциональные компоненты с hooks, одна панель на файл в `src/components/`.
- Любой запрос к бэкенду Wake идёт через `src/lib/backend.ts`: именно там нечитаемый сбой превращается в понятное сообщение, и панели не ходят в сеть сами.
- Публичный REST Lighter живёт в `src/lib/lighter.ts` по той же причине — одни место для формы URL и market ids.
- Текст в интерфейсе говорит, что сломалось и что с этим делать. Пустая панель приглашает к действию, а не пожимает плечами.

**Коммиты**

- Conventional-префикс и scope, где он помогает: `fix(ui):`, `chore(deps):`, `docs:`.
- Одно логическое изменение на коммит. Сообщение объясняет зачем — что именно изменилось, видно в diff.
- Изменилось поведение → изменились тесты. Изменился API или конфигурация → обновлены оба README.

## Чем можно помочь

- Исправления багов с тестом, который их воспроизводит.
- Правки документации: README описывает работающую систему, поэтому устаревшая фраза — это баг.
- Покрытие тестами мест, до которых suite доходит случайно.
- Оптимизации, у которых есть число до и после.
- Улучшения UI и UX.

Для чего-то большего сначала откройте issue и согласуйте подход.

## Pull request

1. Ветка от `main`: `git checkout -b fix/short-name`.
2. Изменения.
3. Полный гейт локально: ruff check и format, `alembic upgrade head` и `alembic check`, `pytest`, `lint`, `tsc`, `vitest`, `build`, Playwright.
4. Push и PR в `main`.

В описании: что и почему изменилось, что проверено руками, ссылка на issue, если он есть. Несвязанные изменения — в другой PR.

## Сообщения о проблемах

Опишите, чего ждали и что получили, шаги воспроизведения, сеть (`mainnet` или `testnet`), был ли включён `WAKE_DRY_RUN`, версии (ОС, Python, Node) и относимые строки лога. Никогда не вставляйте в issue session-токен, приватный ключ, api key с секретом или токен бота.

## Безопасность

Об уязвимости сообщайте через private vulnerability reporting на GitHub или письмом мейнтейнеру — не в публичном issue. Границы, которые проект считает безопасностными, описаны в [SECURITY.md](SECURITY.md).

Не коммитьте API-ключи, учётные данные баз, приватные ключи и что-либо чувствительное. `backend/.env`, хранилища ключей и базы в .gitignore; проверяйте `git status` перед `git add`.

## Вопросы

Открывайте issue.
