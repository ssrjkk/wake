# Security Policy

Wake is a trading interface. It holds no funds: positions live on Lighter, and a
session token never unlocks a withdrawal. What it does hold is worse than a
profile and lighter than custody — trading API keys that can place and cancel
orders on someone's account. The boundaries below are drawn around that.

## Supported Versions

Only the latest release receives security fixes. There is no backport branch.

## Reporting a Vulnerability

**Do not open a public issue.** Use GitHub private vulnerability reporting on
this repository, or email the maintainer.

Include: what the endpoint or file is, a reproduction that does not touch a real
account (testnet or a dry-run instance), the impact you see, and a suggested fix
if you have one.

Response timeline:

- first reply: within 48 hours
- assessment: within 7 days
- fix and release: depends on severity; live-money paths come first

## Trust Boundaries

### Identity is a signed token, never a field in the request

`backend/session.py` issues `wk1.<base64url({sub, iat, exp})>.<HMAC-SHA256>`.
Verification compares the signature with `hmac.compare_digest` before it looks at
`exp`. The secret is `WAKE_SESSION_SECRET`; with no secret configured the server
answers 503 (`SESSION_NOT_CONFIGURED`) rather than signing with a guessable key.
TTL is `WAKE_SESSION_TTL_DAYS`, validated to 1–180 days, default 30.

There is no revocation list. A token is valid until it expires; what it opens is
a non-custodial terminal — positions, follows, subscription state — not a way out
to an external address.

`backend/api/guards.py` turns the token into a subject (`require_user`). Routes
with an owner resolve that owner server-side: no endpoint accepts a
`user_id`/`follower_id` chosen by the caller, because before this existed, naming
another person's `follower_id` was enough to write to their positions and take
their winnings.

### Sign-in proves the thing it claims

Three paths, one result (`backend/api/auth.py`):

- **Wallet** (`backend/wallet_auth.py`): the server issues a text binding Wake's
  name, the address, a 16-byte random nonce and an expiry; the wallet signs it
  (EIP-191) and `eth-account` recovers the address from the signature. The
  challenge is stored in Redis with `SET ex=300` and consumed with `GETDEL`, so a
  captured `(message, signature)` pair cannot be replayed for a second login.
  Addresses are normalised to EIP-55 because they are the primary key of the
  follower record. With no Redis, wallet sign-in answers 503 instead of accepting
  the client's word. A challenge record that does not parse is the same class of
  failure and answers the same way: `wake:wallet:*` is written only by this
  module, so a malformed value means the store was touched from outside, and a
  400 would blame the client for a server incident and hide it in the audit trail
  as a failed login attempt.
- **Telegram Login Widget**: `secret_key = SHA256(bot_token)`, then HMAC-SHA256
  over the sorted `key=value` lines, compared in constant time.
- **Telegram Mini App**: `initData` verified through aiogram
  (`check_webapp_signature`), which derives the key the way the Mini App spec
  requires. The two Telegram derivations differ, so they are two functions.

Both Telegram checks reject signatures older than 24 hours. Every successful
sign-in, and every rejected one, writes an audit row with the way in and the
client IP.

### What is public, and why

`/health`, `/ready`, the `/auth/*` endpoints, `/leaders`,
`/follows/by-leader/{leader_id}`, `/predict/markets*` listings,
`/funding/*`, `/markets/overview`, `/portfolio/risk`, `/portfolio/hedge`,
`/funding-arb/*`. These are market data reads and stateless arithmetic: they
touch no user record and no database write. Everything that reads or changes
someone's state requires the bearer token.

`/follows/by-leader/{leader_id}` is deliberately aggregates only — follower
count and total allocation. The per-row list (who followed, for how much, with
what mirrored size) moved to `GET /leaders/{id}/followers` behind ownership of
the leader: an operator tool that reads the same rows is curator-gated, so
leaving them open here contradicted the project's own classification of them.

`GET /leaders/mine` is the owner's own leader record including a deactivated
one, and `PATCH /leaders/{id}/active` flips publication — both gated on the
same ownership check (`_owned_leader`: 404 if the record does not exist, 403 if
the Lighter account behind it was confirmed by somebody else's wallet sign-in).
This is not a cosmetic flag: `active` is what `active_follows_for_leader()`
filters on, which is the single query the mirror engine reads a leader's
followers from, so turning it off is what actually stops other people's accounts
from trading on his signals.

Curator operations — market creation and resolution, manual copy-engine runs —
require `X-Curator-Token` compared with `hmac.compare_digest` over bytes, and
answer 503 (`CURATOR_NOT_CONFIGURED`) when the server has no token configured
rather than running anonymously. 503 and not 403 because the reason is server
configuration: a client cannot fix it by logging in again, and one language with
`SESSION_NOT_CONFIGURED` is what lets a client tell "the server is missing
something" from "my request is bad". `X-Curator-Token` is in the CORS
`allow_headers` list, so an operator web UI can actually send it — without that
entry the browser fails the preflight and the operator surface is broken by
configuration rather than by code.

### The Telegram bot is a reader with client-supplied input

`backend/telegram_bot.py` holds no session, no private key and no Lighter
account index, and it has no code path to `/place-order`: nothing a Telegram
message can do is write anything. Three invariants keep that true:

- **Everything the bot renders is escaped.** Answers use Telegram's HTML parse
  mode, so a Predict market question (typed by a curator) or a ticker (typed by
  any user) would otherwise become markup in a message sent to other people. All
  non-numeric text goes through `esc()`; `card()` escapes the title and body and
  takes notes only as module constants. Tests cover the injection case.
- **Callback data is treated as hostile.** Buttons carry `p:<TICKER>`; a client
  can send any bytes there, so the value must match `TICKER_RE` — at most 12
  characters of `[A-Z0-9$]` with a letter in it — before it reaches
  `lighter_rest`. An unrecognised value answers "old button" and never hits the
  network.
- **The Mini App button is dropped rather than sent** when `WAKE_MINIAPP_URL` is
  not https: Telegram rejects the whole reply, not just the button, so an http
  address would break every message the bot sends.

The bot does not authenticate the sender: it answers the same public numbers for
whoever asks, which is why no command accepts an account id, a chat id or an
amount. If the bot ever gains a write path, it inherits every rule in the
identity and order-execution sections above — the chat id of the sender is not
authorization for anything.

### Order execution

Three code paths can reach Lighter, and each checks `WAKE_DRY_RUN` in its own
process before touching the SDK: `backend/signing_service.py` (the solo
terminal), `backend/leader_listener.py` (copy trading) and
`backend/agent_runner.py` (the agent, which additionally runs `risk_limits`
checks first). While dry-run is on, the signing service returns the order it
would have sent and nothing leaves; `/health` on both services reports the mode,
so a browser or an operator can see it rather than assume it.

The signing service has no authentication, and cannot have any — a secret in a
public browser bundle is not a secret — so its only boundary is the address it is
published on. That boundary is enforced, not documented: every request is compared
against its `Host` header and anything outside `WAKE_SIGNING_ALLOWED_HOSTS`
(default `localhost,127.0.0.1,::1,signing`) answers `403 SIGNING_HOST_NOT_ALLOWED`
before the key is read. CORS is not this control: it decides whether a foreign page
may *read* the response, while `curl` from anywhere reaches the endpoint. The
terminal additionally compares the network the order book was read from with the
network `/health` reports, because `market_id`, `min_quote_amount` and the size
decimals come from the browser's chosen network while the signature is made on the
service's own.

Two independent switches guard live trading on mainnet (`backend/config.py`,
validated at import): `WAKE_DRY_RUN=false` on mainnet additionally requires
`WAKE_MAINNET_LIVE=true`, otherwise the process refuses to start. A typo in a
deploy variable is not enough to trade real money. Testnet with dry-run off stays
free, because that is where the order path is checked first.

Order sizes always round down to the market's `supported_size_decimals`, and a
size below `min_base_amount` is rejected rather than silently raised.
`backend/place_order_example.py` is a manual operator script, not part of the
running system: it defaults to testnet through its own `WAKE_LIGHTER_NETWORK`
check and needs an explicit API key in the environment.

The copy engine sizes a mirror order against the follower's own money at the
venue, not against the number typed into the follow row. `allocation_usd` is what
a follower said he is willing to risk; the cap that has to hold before an order is
built is free margin, and the only honest reading of it is the account value
Lighter publishes for that `account_index` (`lighter_rest.get_account_equity`,
cached 30 s). When the venue cannot be read, the follower is skipped and the skip
is written to `mirror_log` as `margin_unverified` — the alternative was to assume
the allocation was available margin, which is exactly the assumption a cap exists
to make. `POST /follows` refuses a follower whose wallet sign-in never produced a
Lighter account index (403 `LIGHTER_ACCOUNT_NOT_LINKED`), because an unlinked
subscriber is a row that cannot be verified, mirrored or unsubscribed from real
money.

`/place-order` has no authentication. A secret bundled into a public browser
build is not a secret, so access control is placement: in the Compose stack its
port is published on `127.0.0.1` only, and containers reach it on the internal
network. Do not expose it publicly. Input is bounded by pydantic (`base_amount`
and `price` must be positive integers, `market_index` non-negative), so a
malformed request fails as 422 before an SDK call.

Idempotency is an in-process cache keyed by `client_order_index` with a one-hour
TTL. It dedupes replays inside one process; it is not shared between workers or
instances. The index is no longer derived from the clock: the browser draws it
from `crypto.getRandomValues` and both server paths derive it from the UUID of
the trade or mirror row it belongs to, so the same intent keeps the same index
while two different orders cannot land on one index and have the second silently
answered with the first one's tx_hash.

### Key storage

`backend/encrypted_key_store.py` stores follower keys as a Fernet
(AES-128-CBC + HMAC) blob at `WAKE_KEYSTORE_PATH`, keyed by `WAKE_MASTER_KEY`.
The blob is rewritten atomically — temp file, `fsync`, `os.replace` — with
owner-only `0600` permissions, and the constructor never creates the file: an
interrupted write cannot leave a truncated keystore, because losing this file
means losing every follower's key at once, and a mistyped path must not conjure
an empty store next to the real one. That is encryption at rest, and it is
honest about its limit: the master key sits
in the environment of the same host that decrypts it, so a host compromise
yields both. An HSM or KMS keeps signing inside a hardware or IAM boundary and
never hands the raw key to the process; that is infrastructure, not tidier
Python, and it is not implemented here. `backend/.env`, `*.enc` and `*.db` are
gitignored; the master key belongs in a real secret manager.

Keys are provisioned through a CLI, not through an HTTP route:
`python -m encrypted_key_store store <follower_id> <api_key_index>` reads the
secret from stdin (terminal echo off on a tty, one line when piped) and
`remove`/`list` work on the same file. A route that accepted an API key would put
a follower's signing secret in request bodies — in proxied logs, in any
`curl -v` transcript, and in front of every middleware that records payloads.
`list` prints ids and indexes only and never a key, so the operator can compare
the store against the `followers` table without opening it.

### Data layer

PostgreSQL only — `backend/config.py` rejects any `WAKE_DATABASE_URL` that is not
PostgreSQL (and normalises `postgresql://` to `postgresql+asyncpg://`, which is
what asyncpg needs). Schema changes go through Alembic and nothing else;
`alembic check` in CI fails on drift. All SQL is SQLAlchemy Core/ORM with bound
parameters — there is no string-built SQL in the backend. Sensitive actions are
written to the `audit_log` table in the same database, so they survive a
container restart, and they are readable: `GET /audit` (curator token, newest
first, 500 rows per response) is the operator's way to answer "who actually
signed in". A write that fails — the database blinked, a detail would not
serialise — is logged at ERROR and never turns into a 500 on the caller, because
that caller has already moved money and would reasonably retry the request.

`success` in those rows means "the operation ran", not "the caller liked the
answer". A Predict claim that pays 0 — a losing position, or a second claim on an
already-paid one — is a completed operation; the market that is not resolved yet
is the refusal. Getting this backwards fills `GET /audit?failed_only` with normal
traffic, and a filter an operator has learned to skim is worse than no filter.

Two money paths take a PostgreSQL lock before they read the state they are about
to spend. `record_trade` in Predict locks the market row `FOR UPDATE`; a step of
the agent takes a session-scoped advisory lock on the user
(`pg_try_advisory_lock(hashtextextended(...))`) because its limit check is an
aggregate over many rows with no single row to hold. Without that second lock two
parallel requests from one person — two tabs, a double tap, a `curl` in a loop —
read the same `risk_state_today` and both pass, spending the daily volume cap and
the per-market position cap twice. A contended step answers 409
`AGENT_STEP_IN_PROGRESS`; a lock whose connection died is dropped with the socket
by invalidating the connection rather than being inherited by the next owner in
the pool.

Markets in the Predict module settle on the same layer as the money paths, not on
the interface. `record_trade()` refuses a market whose `resolve_at` has passed:
the outcome of a price market is already fixed by the oracle at that moment, so
accepting trades until the resolver closes it means selling a known answer to the
pool for less than a dollar. `resolve_market()` and `claim_winnings()` take row
locks — the timer process and the curator's manual trigger can reach the same
market in one tick, and two parallel claims by the same user must pay once.

### Transport, headers, rate limiting

- CORS: explicit origins from `WAKE_CORS_ORIGINS`, no wildcards, credentials
  allowed for the bearer header.
- Every API response carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy:
  strict-origin-when-cross-origin`, a `Permissions-Policy` that denies
  camera/microphone/geolocation/payment, and `Content-Security-Policy:
  default-src 'self'`.
- "Every" includes the refusals, and that is a property of middleware order, not
  of each handler: Starlette inserts every middleware at position 0, so the last
  one registered is the outermost, and the stack is built CORS → security
  headers → error envelope → rate limiter (`backend/app.py`). While the rate
  limiter sat outermost, its 429 — and any 500 or 400 produced outside the
  routers — left the application without `Access-Control-Allow-Origin`, so the
  browser withheld the response from JavaScript entirely: "too many requests,
  retry in 6s" reached the user as "the backend is down". `Retry-After` is in
  `expose_headers`, otherwise the client sees the 429 but not the window. A test
  pins the layer order, because any new middleware registered later silently
  moves outside these ones.
- Rate limiting is a Redis token bucket (`backend/rate_limiter.py`): the key is
  `user:<sub>` when the bearer verifies, otherwise `ip:<client>`; write methods
  cost 3 tokens, reads 1; capacity 40, refill 20/s by default. When Redis is
  down it fails **open** — the terminal has open positions and must not be
  locked out by its own limiter — and the outage is visible as `redis: fail` on
  `/ready` rather than hidden.
- `X-Forwarded-For` is read only when the connection really came from
  `WAKE_TRUSTED_PROXY_IPS`, and only the rightmost address in the chain
  (`backend/net.py`). Otherwise a client could choose the IP that rate limits and
  audit records attribute it to.
- Errors are one JSON shape, `{error: {code, message}}`, so clients branch on
  `code` and nothing leaks a stack trace into a response body.
- `SENTRY_DSN` is optional; if set, exception data goes to Sentry with the SDK's
  own defaults and nothing extra is scrubbed.

### Dependency auditing

CI runs `pip-audit --strict` against `backend/requirements.txt`. Audit errors
and advisories outside the exact list below fail the job, including new urllib3
advisories. `npm audit` checks both production and development frontend packages.

The following urllib3 advisories were reviewed on 2026-10-25. `lighter-sdk`
1.1.8 — published 2026-10-19 and still the newest release — requires
`urllib3<2.1.0`, and `pip install --dry-run "urllib3>=2.1.0" "lighter-sdk>=1.1.8"`
is unsolvable, so a patched urllib3 cannot be installed at all. CI checks that
resolution instead of trusting this paragraph: the step after the audit fails on
the first day the cap lifts, and says which list to delete.

What actually touches urllib3 in this dependency set: `lighter/configuration.py`
imports it for the logger name and retry constants, and the legacy generated
`openapi_client` transport uses its pool — neither is on the order path. That
path is the async `SignerClient`, whose REST calls go through aiohttp; the only
requests-based (and therefore urllib3-based) call in the package is the
synchronous nonce fallback, which the async path does not reach. Wake's own reads
of market data use the standard library (`backend/lighter_rest.py`), not urllib3.
Nothing here configures urllib3 proxy TLS, calls its low-level cross-origin proxy
API, or streams a response through it.

These are bounded exceptions, not fixes: do not expose the signing service (the
Host gate refuses it by default), add untrusted SDK hosts, or introduce those
HTTP paths without revisiting the exceptions. Remove the exceptions when the SDK permits an update.

| Advisory | Affected path |
| --- | --- |
| CVE-2024-37891 | Proxy authorization header forwarded across origins |
| CVE-2025-50181 | Pool-level redirect limits ignored |
| CVE-2025-66418 | Unbounded chained response decompression |
| CVE-2025-66471 | Streaming response decompression exceeds read limits |
| CVE-2026-21441 | Redirect response decompression during streaming |
| CVE-2026-44431 | Sensitive headers forwarded by the low-level proxy API |
| CVE-2026-97687 | Proxy and target TLS policies mixed |
| CVE-2026-97689 | Unbounded chunk-size field while streaming |

The decompression exceptions remain residual risk for dependency code that reads
responses in full; trusted HTTPS hosts reduce exposure but do not remove it.

## What These Measures Do Not Cover

- **No external audit.** Nothing in this repository has been reviewed by a
  third-party security firm.
- **Not custody-grade.** No HSM, no KMS, no signing inside a hardware boundary.
  Decrypting a follower key puts it in process memory.
- **No token revocation.** A stolen bearer token works until it expires.
- **Client-side sizing on the solo path.** The signing service validates types,
  positivity and the int32/float64 bounds of the scaled numbers; per-account
  equity and exposure limits are checked in the browser. A caller who is not the browser can ask for more than their balance
  shows — Lighter rejects what the account cannot carry, but Wake does not
  police it.
- **No CSP at the frontend edge.** The security headers above are set by the API.
  The Pages-hosted app is served without `_headers`; adding one means testing
  against Telegram's widget script and the wallet connectors together (fonts are
  already first-party and come from the bundle).
- **Telegram identity is what Telegram signs.** The widget and Mini App prove a
  Telegram account, not a person. A leader's `handle` is free text.
- **The API does not terminate TLS.** Railway and Cloudflare do, which is why
  `WAKE_TRUSTED_PROXY_IPS` has to be set correctly for client-IP logic to mean
  anything.
- **Other people's keys are not live.** Multi-tenant copy trading is Phase 2,
  gated on a security review of the keystore component itself and on legal advice
  for the jurisdiction, not on swapping one file for another.

## Production Checklist

Before any instance trades at all:

1. Set `WAKE_SESSION_SECRET` (otherwise sign-in answers 503) and
   `WAKE_CURATOR_TOKEN` (otherwise operator routes answer 503).
2. Keep `WAKE_DRY_RUN=true`; confirm the order path on
   `WAKE_LIGHTER_NETWORK=testnet` first.
3. Set `WAKE_TRUSTED_PROXY_IPS` to the actual proxy addresses.
4. Pin `WAKE_CORS_ORIGINS` to the deployed frontend origin — the default is
   `http://localhost:5173`.
5. Put `WAKE_MASTER_KEY` in a secret manager, not in a file in the repository.
6. Keep the signing service on loopback or an internal network. The service now
   refuses any other `Host` unless you list it in `WAKE_SIGNING_ALLOWED_HOSTS`,
   and a published hostname plus `WAKE_DRY_RUN=false` is an unauthenticated
   money-moving endpoint.
7. Only after a testnet run is verified end to end: `WAKE_DRY_RUN=false` plus
   `WAKE_MAINNET_LIVE=true`, deliberately, by a person who accepts the loss.

---

# Политика безопасности

Wake — торговый интерфейс. Средства он не хранит: позиции живут на Lighter, а
токен сессии не открывает вывод. Но он хранит то, что тяжелее профиля и легче
кастодиального кошелька, — торговые API-ключи, умеющие выставлять и отменять
ордера на чужом счёте. Границы ниже нарисованы вокруг этого.

## Поддерживаемые версии

Исправления получает только последний релиз. Веток для бэкпортов нет.

## Как сообщать об уязвимостях

**Не заводите публичный issue.** Приватный security advisory в GitHub этого
репозитория или письмо мейнтейнеру.

Полезно: эндпоинт или файл, воспроизведение без реального счёта (тестнет или
dry-run-инстанс), видимый эффект, предложение по исправлению — если есть.

Сроки:

- первый ответ: 48 часов
- оценка: 7 дней
- исправление и релиз: по тяжести; пути, где живые деньги, — первыми

## Границы доверия

### Личность — подписанный токен, а не поле запроса

`backend/session.py` выдаёт `wk1.<base64url({sub, iat, exp})>.<HMAC-SHA256>`.
Подпись сравнивается через `hmac.compare_digest` до того, как смотрятся на `exp`.
Секрет — `WAKE_SESSION_SECRET`; без него сервер отвечает 503
(`SESSION_NOT_CONFIGURED`), а не подписывает угадываемым ключом. Срок —
`WAKE_SESSION_TTL_DAYS`, валидируется в диапазоне 1–180, по умолчанию 30.

Отзыва нет: токен живёт до истечения. Что он открывает — некастодиальный
терминал (позиции, подписки, состояние подписки), а не способ вывести деньги на
посторонний адрес.

`backend/api/guards.py` превращает токен в субъекта (`require_user`). Владелец
записи определяется на сервере: эндпоинты больше не принимают `user_id` или
`follower_id`, который выбрал вызывающий, — до этого достаточно было назвать
чужой `follower_id`, чтобы писать в чужие позиции и забирать чужой выигрыш.

### Вход подтверждает то, что заявляет

Три способа, один результат (`backend/api/auth.py`):

- **Кошелёк** (`backend/wallet_auth.py`): сервер выдаёт текст, в который входят
  название Wake, адрес, 16-байтовый случайный nonce и срок; кошелёк подписывает
  его (EIP-191), а `eth-account` восстанавливает адрес из подписи. Challenge
  лежит в Redis (`SET ex=300`) и снимается одним `GETDEL`, поэтому перехваченная
  пара `(message, signature)` не даёт второй вход. Адрес нормализуется по EIP-55:
  он первичный ключ записи подписчика. Без Redis вход кошельком отвечает 503, а не
  верит клиенту на слово. Неразбирающаяся запись challenge — та же категория
  отказа: ключ `wake:wallet:*` пишет только этот модуль, значит битое значение
  кто-то положил извне, а 400 свалил бы серверный инцидент на клиента и спрятал бы
  его в аудите под «неудачной попыткой входа».
- **Telegram Login Widget**: `secret_key = SHA256(bot_token)`, затем HMAC-SHA256
  по отсортированным строкам `key=value`, сравнение по постоянному времени.
- **Telegram Mini App**: `initData` проверяется через aiogram
  (`check_webapp_signature`) — ключ выводится так, как требует спецификация
  мини-приложений. Выводы ключа в этих двух потоках разные, поэтому проверки —
  две отдельные функции.

Обе телеграм-проверки отклоняют подписи старше 24 часов. Каждый успешный вход и
каждый отвергнутый пишет строку в аудит: способ входа и IP клиента.

### Что открыто и почему

`/health`, `/ready`, `/auth/*`, `/leaders`, `/follows/by-leader/{leader_id}`,
списки `/predict/markets*`, `/funding/*`, `/markets/overview`,
`/portfolio/risk`, `/portfolio/hedge`, `/funding-arb/*`. Это чтение рыночных
данных и арифметика без состояния: ни чужих записей, ни записей в базу. Всё, что
читает или меняет чужое состояние, требует bearer-токен.

Операторские операции (создание и резолюция рынков, ручной прогон копи-движка)
требуют `X-Curator-Token`, сравнивают его через `hmac.compare_digest` по байтам и
отвечают 503 (`CURATOR_NOT_CONFIGURED`), когда токен на сервере не настроен,
вместо анонимного исполнения. 503, а не 403: причина — конфигурация сервера, и
клиент не может исправить её повторным входом. `X-Curator-Token` входит в CORS
`allow_headers`, поэтому операторский веб-интерфейс действительно может его
отправить; без этой строки браузер падал бы на preflight, и поверхность
оператора была бы сломана конфигурацией, а не кодом.

### Telegram-бот — читатель с недоверчивым вводом

`backend/telegram_bot.py` не держит сессию, приватный ключ и account index
Lighter, и из него нет ни одного пути к `/place-order`: сообщение в Telegram не
может ничего написать. Эти инварианты и делают утверждение верным:

- **Всё, что бот рисует, экранируется.** Ответы идут в HTML-режиме Telegram,
  поэтому вопрос Predict-рынка (его набирает куратор) или тикер (его набирает
  любой) иначе превратились бы в разметку в чужих сообщениях. Любой не-числовой
  текст проходит через `esc()`; `card()` экранирует заголовок и тело, а сноски
  принимает только константами модуля. Случай инъекции покрыт тестом.
- **callback_data считается враждебным.** Кнопки несут `p:<TICKER>`, а туда
  клиент может подставить что угодно, поэтому значение обязано совпасть с
  `TICKER_RE` (до 12 символов `[A-Z0-9$]`, обязательно с буквой) прежде, чем
  попадёт в `lighter_rest`. Нераспознанное значение отвечает «кнопка устарела» и
  в сеть не идёт.
- **Кнопка Mini App снимается, а не отправляется**, если `WAKE_MINIAPP_URL` не
  https: Telegram отбраковывает весь ответ целиком, поэтому http-адрес ломал бы
  каждое сообщение бота.

Бот не аутентифицирует отправителя: он отвечает одинаковыми публичными числами
всякому, кто спросит, — и поэтому ни одна команда не принимает id аккаунта, id
чата или сумму. Если у бота появится путь на запись, он наследует все правила
разделов про личность и исполнение ордеров выше: id чата отправителя
авторизацией не является.

### Исполнение ордеров

До Lighter дотягиваются три пути, и каждый проверяет `WAKE_DRY_RUN` в собственном
процессе до вызова SDK: `backend/signing_service.py` (соло-терминал),
`backend/leader_listener.py` (копи-трейдинг) и `backend/agent_runner.py` (агент,
который дополнительно прогоняет `risk_limits`). Пока dry-run включён, сервис
подписи возвращает тот ордер, который отправил бы, и наружу ничего не уходит;
`/health` обоих сервисов показывает режим — его видно, а не предполагают.

У сервиса подписи нет аутентификации, и она невозможна: секрет в публичном
бандле — не секрет. Единственная граница — адрес, под которым он опубликован, и
эта граница проверяется кодом, а не обещанием в доке: каждый запрос сверяется с
заголовком `Host`, и всё, что вне `WAKE_SIGNING_ALLOWED_HOSTS` (по умолчанию
`localhost,127.0.0.1,::1,signing`), получает `403 SIGNING_HOST_NOT_ALLOWED` до
чтения ключа. CORS этой границей не является: он решает, прочитает ли чужая
страница ответ, а `curl` доходит до эндпоинта откуда угодно. Терминал
дополнительно сверяет сеть, из которой прочитана книга рынков, с сетью из
`/health` сервиса: `market_id`, `min_quote_amount` и decimals приходят от
переключателя браузера, а подпись ставится в сети сервиса.

Живой трейдинг на mainnet открывают два независимых переключателя
(`backend/config.py`, проверка на импорте): `WAKE_DRY_RUN=false` на mainnet
требует `WAKE_MAINNET_LIVE=true`, иначе процесс не стартует. Опечатки в одной
переменной деплоя недостаточно, чтобы торговать настоящими деньгами. Тестнет с
выключенным dry-run остаётся свободным: именно там сначала проверяют путь ордера.

Размер всегда округляется вниз до `supported_size_decimals` рынка, а размер ниже
`min_base_amount` отклоняется, а не поднимается молча.
`backend/place_order_example.py` — скрипт, который оператор запускает руками, не
часть работающей системы: он по умолчанию на тестнете (собственная проверка
`WAKE_LIGHTER_NETWORK`) и требует явно положенный в окружение API-ключ.

Копи-движок считает размер зеркала по деньгам подписчика на площадке, а не по
числу, вбитому в строку подписки. `allocation_usd` — сколько человек сам сказал,
что готов рисковать; капиться до построения ордера надо по свободной марже, а
честно её прочесть можно только из аккаунта Lighter для этого `account_index`
(`lighter_rest.get_account_equity`, кэш 30 с). Когда площадка не отдала значение,
подписчик пропускается, и пропуск пишется в `mirror_log` как `margin_unverified`:
альтернатива — считать аллокацию доступной маржой на веру, то есть ровно то
допущение, ради которого кап и существует. `POST /follows` отклоняет подписчика,
у которого wallet-вход не дал индекса аккаунта Lighter (403
`LIGHTER_ACCOUNT_NOT_LINKED`): строка без привязки — это запись, которую нельзя
ни проверить, ни зеркалить, ни отменить.

У `/place-order` нет аутентификации. Секрет, вшитый в публичную браузерную
сборку, секретом не является, поэтому граница — это размещение: в Compose его порт
публикуется только на `127.0.0.1`, контейнеры достают его по внутренней сети.
Наружу его не выставляют. Вход ограничивают pydantic-модели (`base_amount` и
`price` — положительные целые, `market_index` неотрицательное), поэтому кривой
запрос падает в 422 до обращения к SDK.

Идемпотентность — кэш внутри процесса по `client_order_index` с TTL в час. Он
склеивает повторы в одном процессе, не разделяется между воркерами и инстансами.
Индекс больше не строится по часам: браузер берёт его из `crypto.getRandomValues`,
а оба серверных пути выводят из UUID той сделки или строки зеркалирования, к
которой он относится. Поэтому повтор одного замысла сохраняет тот же индекс, а
два разных ордера не могут столкнуться на одном индексе и получить ответ с
tx_hash первого, не отправив второй.

### Хранение ключей

`backend/encrypted_key_store.py` хранит ключи подписчиков как Fernet-блоб
(AES-128-CBC + HMAC) по пути `WAKE_KEYSTORE_PATH` под `WAKE_MASTER_KEY`. Блоб
перезаписывается атомарно — временный файл, `fsync`, `os.replace` — с правами
`0600` только для владельца, и конструктор файл не создаёт: оборванная запись не
может оставить обрезанное хранилище, потому что потеря этого файла означает
одномоментную потерю ключей всех подписчиков, а опечатка в пути не должна
породить пустое хранилище рядом с настоящим. Это
шифрование at rest, и оно честно про свою границу: мастер-ключ лежит в окружении
того же хоста, который его расшифровывает, поэтому компрометация хоста даёт
атакующему и данные, и ключ. HSM или KMS держат подпись внутри аппаратного или
IAM-контура и не отдают сырой ключ процессу; это отдельная инфраструктура, а не
более аккуратный Python, и здесь её нет. `backend/.env`, `*.enc` и `*.db` в
.gitignore; мастер-ключу место в нормальном секрет-менеджере.

Ключи кладут в хранилище через CLI, а не через HTTP-роут:
`python -m encrypted_key_store store <follower_id> <api_key_index>` читает секрет
из stdin (без эха в терминале, одной строкой при пайпе), `remove` и `list` работают
с тем же файлом. Роут, принимающий API-ключ, положил бы секрет подписчика в тела
запросов — в логи прокси, в распечатку `curl -v` и под каждый middleware, который
пишет полезную нагрузку. `list` печатает только id и индексы, без ключей: оператор
может сверить хранилище с таблицей `followers`, не открывая его.

### Данные

Только PostgreSQL: `backend/config.py` отклоняет `WAKE_DATABASE_URL`, который не
PostgreSQL (и дописывает `asyncpg` к `postgresql://`, потому что иначе первый же
запрос падает с невнятной причиной). Схема меняется только через Alembic, а
`alembic check` в CI падает на расхождении. Весь SQL идёт через SQLAlchemy
Core/ORM со связанными параметрами; строк SQL в бэкенде не собирают. Чувствительные
действия пишутся в таблицу `audit_log` той же базы и переживают рестарт контейнера,
и они читаются: `GET /audit` (токен куратора, свежие сверху, до 500 строк в ответе) —
это способ оператора ответить на «кто вообще заходил». Сбой записи — база моргнула,
деталь не сериализуется — уходит в лог уровнем ERROR и никогда не становится 500 у
вызывающего кода: там уже изменены деньги, и повтор такого запроса означал бы вторую
сделку вместо одной.

`success` в этих строках значит «операция исполнилась», а не «ответ понравился».
Клима Predict с выплатой 0 — проигравшая ставка или повторный claim по уже
выплаченному — исполнившаяся операция; отказ здесь другой: рынок без резолюции.
Если считать иначе, `GET /audit?failed_only` заполняется обычной работой, а
фильтром, который оператор научился проматывать, пользоваться нельзя.

Два денежных пути берут блокировку PostgreSQL до чтения состояния, которое
собираются потратить. `record_trade` в Predict держит строку рынка `FOR UPDATE`;
шаг агента берёт сессионный advisory-замок на пользователе
(`pg_try_advisory_lock(hashtextextended(...))`), потому что его лимит — агрегат по
многим строкам и держать тут нечего. Без второго замка два параллельных запроса
одного человека (две вкладки, двойной тап, `curl` в цикле) читают один и тот же
`risk_state_today` и проходят оба, расходуя дневной объём и лимит открытой позиции
по рынку дважды. Спорный шаг отвечает 409 `AGENT_STEP_IN_PROGRESS`; замок, у
которого умерло соединение, снимается вместе с сокетом — соединение инвалидируется,
чтобы следующий владелец в пуле не унаследовал чужую блокировку.

Рынки Predict сходятся тем же слоем, что и денежные пути, а не интерфейсом.
`record_trade()` отказывает рынку, у которого `resolve_at` уже прошёл: исход
price-рынка в этот момент уже определён оракулом, и принимать сделки до того, как
резолвер закроет рынок, значит продавать пулу заведомый ответ дешевле доллара.
`resolve_market()` и `claim_winnings()` берут блокировки строк — процесс по
таймеру и ручной триггер куратора могут сойтись к одному рынку в одном тике, а
два параллельных клима одного пользователя должны заплатить один раз.

### Транспорт, заголовки, лимиты

- CORS: явные источники из `WAKE_CORS_ORIGINS`, без wildcard'ов, credentials
  разрешены — нужен bearer-заголовок.
- Каждый ответ API несёт `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `X-XSS-Protection`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy`, запрещающий
  камеру/микрофон/геолокацию/payment, и `Content-Security-Policy: default-src
  'self'`.
- «Каждый» включает отказы, и это свойство порядка middleware, а не каждого
  обработчика: Starlette вставляет каждый слой в начало списка, поэтому
  последним добавленный оказывается внешним, и стек собран CORS → заголовки →
  конвертер ошибок → лимитер (`backend/app.py`). Пока лимитер был внешним, его
  429 — и любой 500 или 400 вне роутов — уходили без
  `Access-Control-Allow-Origin`, то есть браузер вообще не отдавал их
  JavaScript: «слишком много запросов, повторите через 6 секунд» доходило до
  человека как «бэкенд лежит». `Retry-After` добавлен в `expose_headers`, иначе
  клиент видит 429, но не видит окно. Порядок слоёв закрепляет тест: любой новый
  middleware, добавленный позже, молча переезжает наружу этих.
- Rate limiting — token bucket в Redis (`backend/rate_limiter.py`): ключ
  `user:<sub>`, если bearer подтверждается, иначе `ip:<client>`; write-методы
  стоят 3 токена, чтение 1; по умолчанию capacity 40, refill 20/сек. При
  недоступном Redis лимитер пропускает (**fail-open**): у терминала в этот момент
  открыты позиции, и собственный лимитер не должен его запирать. Мёртвый Redis
  виден как `redis: fail` на `/ready`, а не спрятан.
- `X-Forwarded-For` читается, только если соединение реально пришло из
  `WAKE_TRUSTED_PROXY_IPS`, и берётся правый элемент цепочки (`backend/net.py`).
  Иначе клиент выбирал бы сам, какой IP попадает в аудит и в какой bucket.
- Ошибки приходят в одной форме `{error: {code, message}}`, чтобы клиент
  ветвился по `code`, а стектрейсы в тело ответа не пишутся.
- `SENTRY_DSN` опционален: если задан, данные об исключениях уходят в Sentry с
  дефолтами самого SDK, ничего дополнительно не вырезается.

### Проверка зависимостей

CI запускает `pip-audit --strict` по `backend/requirements.txt`. Ошибки аудита
и уязвимости вне точного списка ниже роняют джоб, включая новые уязвимости
urllib3. `npm audit` проверяет фронтенд вместе с dev-зависимостями.

Перечисленные уязвимости urllib3 проверены 2026-10-25. `lighter-sdk` 1.1.8 —
опубликован 2026-10-19 и остаётся свежим релизом — требует `urllib3<2.1.0`, а
`pip install --dry-run "urllib3>=2.1.0" "lighter-sdk>=1.1.8"` не разрешается, то
есть пропатченный urllib3 нельзя поставить вообще. CI проверяет именно это
разрешение, а не верит абзацу: шаг после аудита краснеет в первый день, когда
предел снимут, и говорит, какой список удалять.

Что на самом деле задевает urllib3 в этом наборе зависимостей:
`lighter/configuration.py` импортирует его ради имени логгера и констант повторов,
а легаси-транспорт `openapi_client` работает через его пул — ни то, ни другое на
пути ордера не лежит. Путь ордера — это асинхронный `SignerClient`, чьи запросы
ходят через aiohttp; единственный requests-вызов (а значит и urllib3-вызов) в
пакете — синхронный запасной путь за nonce, до которого асинхронная ветка не
доходит. Собственные данные Lighter Wake читает стандартной библиотекой
(`backend/lighter_rest.py`), не urllib3. TLS прокси urllib3 здесь никто не
настраивает, низкоуровневый междоменный прокси-API не вызывает, потоковые ответы
через него не читаются.

Это ограниченные исключения, а не исправления: публикация сервиса подписи (её
теперь не пропускает гейт по `Host`), недоверенные хосты SDK или добавление этих
HTTP-путей требуют пересмотра исключений. После снятия ограничения SDK исключения надо удалить.

| Уязвимость | Затронутый путь |
| --- | --- |
| CVE-2024-37891 | Передача заголовка авторизации прокси другому хосту |
| CVE-2025-50181 | Игнорирование запрета редиректов на уровне пула |
| CVE-2025-66418 | Неограниченная цепочка распаковки ответа |
| CVE-2025-66471 | Распаковка потокового ответа превышает лимит чтения |
| CVE-2026-21441 | Распаковка ответа редиректа при потоковом чтении |
| CVE-2026-44431 | Передача секретных заголовков низкоуровневым API прокси |
| CVE-2026-97687 | Смешивание TLS-настроек прокси и целевого сервера |
| CVE-2026-97689 | Неограниченное поле размера чанка при потоковом чтении |

Распаковка остаётся остаточным риском для кода зависимостей, читающего ответ
целиком: доверенные HTTPS-хосты уменьшают риск, но не устраняют его.

## Что эти меры НЕ закрывают

- **Внешнего аудита не было.** Ни один файл здесь не смотрела сторонняя
  security-команда.
- **Это не кастодия.** Нет HSM, нет KMS, подпись не прячется в аппаратный контур:
  расшифрованный ключ подписчика попадает в память процесса.
- **Токен нельзя отозвать.** Украденный bearer работает до истечения срока.
- **Размер ордера в соло-пути проверяется в браузере.** Сервис подписи проверяет
  типы, положительность и границы масштабированных чисел (int32 у индекса,
  точный диапазон float64 у цены и размера); баланс счёта и экспозиция —
  клиентская проверка.
  Тот, кто не браузер, может попросить больше, чем позволяет баланс: Lighter
  такое отклонит, но Wake не сторожит.
- **На фронте нет CSP на edge.** Заголовки выше ставит API. Статический сайт на
  Pages отдаётся без `_headers`; добавлять его надо вместе с проверкой, что
  работают виджет Telegram и коннекторы кошельков (шрифты уже свои, из бандла).
- **Telegram подтверждает аккаунт, а не человека.** И handle лидера — свободный
  текст.
- **TLS терминирует не этот процесс** — Railway и Cloudflare. Поэтому
  `WAKE_TRUSTED_PROXY_IPS` должен быть настроен, иначе клиентский IP ничего не
  значит.
- **Чужие ключи не подключены.** Мультитенантный копи-трейдинг — Фаза 2, и её
  блокирует не замена файла, а ревью самого хранилища ключей и юридическая
  консультация по юрисдикции.

## Чеклист перед запуском

Перед тем как инстанс вообще начнёт торговать:

1. Задать `WAKE_SESSION_SECRET` (иначе вход отвечает 503) и
   `WAKE_CURATOR_TOKEN` (иначе операторские роуты отвечают 503).
2. Оставить `WAKE_DRY_RUN=true` и сначала проверить путь ордера на
   `WAKE_LIGHTER_NETWORK=testnet`.
3. Выставить `WAKE_TRUSTED_PROXY_IPS` на реальные адреса прокси.
4. Задать `WAKE_CORS_ORIGINS` на домен задеплоенного фронтенда — дефолт это
   `http://localhost:5173`.
5. Положить `WAKE_MASTER_KEY` в секрет-менеджер, а не в файл в репозитории.
6. Оставить сервис подписи на loopback или во внутренней сети. Сервис теперь сам
   отклоняет любой другой `Host`, пока ты не внесёшь его в
   `WAKE_SIGNING_ALLOWED_HOSTS`; опубликованное имя вместе с `WAKE_DRY_RUN=false`
   — это неаутентифицированный эндпоинт, двигающий деньги.
7. Только после проверенного тестнет-прогона: `WAKE_DRY_RUN=false` плюс
   `WAKE_MAINNET_LIVE=true` — руками и осознанно.
