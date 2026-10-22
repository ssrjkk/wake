# Wake

Trading terminal for [Lighter](https://lighter.xyz) (zk perp DEX): a React web app, a FastAPI backend, and a read-only Telegram bot ([@waketrade_bot](https://t.me/waketrade_bot)) with a Mini App — the site writes through the backend, the bot answers with the same market data the site shows.

Default configuration is **mainnet** with `WAKE_DRY_RUN=true`: real market data from the real network, and no order ever leaves the process until you turn dry-run off yourself.

Live frontend: https://wake-7k6.pages.dev  
Live backend: https://wake-backend-production-3483.up.railway.app — `/health` answers `{"status":"ok","network":"mainnet","dry_run":true}`, `/ready` currently answers 503 (`database: fail, redis: fail`): the process is deployed, the PostgreSQL and Redis services are not attached to it yet. Market-data panels work; sign-in, copy trading and Predict do not. [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) is the path from this state to a ready one.

## Contact

- **Telegram:** [@ssrjkk](https://t.me/ssrjkk)
- **Wake Trade bot:** [@waketrade_bot](https://t.me/waketrade_bot)
- **GitHub:** [@ssrjkk](https://github.com/ssrjkk)

## Screens

Captured from this build with live data (2026-10-23), not mockups. The backend-dependent panels show the "backend unavailable" state on purpose: the deployed process answers `/health` but not `/ready` until PostgreSQL and Redis are attached, and a screenshot with invented numbers would be worse than an honest empty state.

| | |
| --- | --- |
| ![Terminal](docs/screenshots/terminal-1440.png) | **Терминал** — the desk: quote in a display mono, hourly tick tape, candles, trade tape, order ticket, and a market list with a liquidity rank along each row. Public Lighter REST, no backend. |
| ![Overview](docs/screenshots/overview-1440.png) | **Обзор** — ranking by real 24h quote volume, Arcus markets, open Predict markets. The ranking itself is a backend call, so the notice in the shot is the current production state. |
| ![Funding](docs/screenshots/funding-1440.png) | **Funding** — 735 live rates across four venues and 214 Lighter perps, with the carry candidates where both legs exist on one exchange. |
| ![Portfolio](docs/screenshots/portfolio-1440.png) | **Портфель** — subscriptions from the `follows` table and the Lighter account by L1 address; both empty states say what is missing and where to act. |
| ![Discover](docs/screenshots/discover-1440.png) | **Discover** — leader directory with followers, AUM and the leader's own Lighter account. No leaders yet, and the panel names the backend address it tried. |
| ![Earn](docs/screenshots/earn-1440.png) | **Earn** — subscription tier and trial state; the shot shows the publish gate, because there is no leader record yet. |
| ![Predict](docs/screenshots/predict-1440.png) | **Predict** — LMSR price and event markets, quoting and claims; the shot shows the list gate (backend) and the sign-in gate (positions and payouts). |
| ![Agent](docs/screenshots/agent-1440.png) | **Агент** — per-market decision with per-market win-rate memory, gated on trial or Pro; the empty state names the endpoint, the curator header and the table the rows live in. |
| ![Risk](docs/screenshots/risk-1440.png) | **Risk** — basket exposure and hedge sizing on Lighter's single margin, correlations from hourly candles. |
| ![Terminal at 390](docs/screenshots/terminal-390.png) | **Терминал на 390 px** — the same desk stacked; no tab overflows horizontally. |
| ![Telegram bot](docs/screenshots/bot-cards.png) | **@waketrade_bot** — the HTML cards `backend/telegram_bot.py` sends, rendered in a browser: ranking with ticker buttons and pagination, price card with the hourly sparkline, funding ranking, `/spread` across venues. |

## What each panel does

| Panel | Where the data comes from | Works without the Wake backend |
| --- | --- | --- |
| Обзор (Overview) | Market ranking by real 24h quote volume (`/markets/overview`, 18 perp markets, cached 60 s) plus open Predict markets | no |
| Терминал (Terminal) | Candles and recent trades from Lighter's public REST; the hourly tick tape under the quote is drawn from the same 48 candles the chart uses | reads yes; sending an order needs the signing service |
| Discover | Leaders ranked by follower count and AUM, follow / pause / unfollow | no |
| Портфель (Portfolio) | Your positions on Lighter looked up by L1 address (public REST); subscriptions and the copy-engine log from the backend | positions yes, copy state no |
| Earn | Copy subscription state and trial activation | no |
| Predict | LMSR price and event markets: creation, quoting, resolution, claims | no |
| Агент (Agent) | Per-market decision with per-market win-rate memory | no |
| Risk | Cross-asset exposure and hedge sizing | no |
| Funding | Lighter funding rate next to Binance, Bybit and Hyperliquid for the same `market_id` (all four come from Lighter's `/funding-rates`), annualised at 24 epochs/day | rates yes; the arb check and sizing call the backend |

Those three keep working with no backend, which is why the site does not go blank when the backend is missing — see [src/lib/backend.ts](src/lib/backend.ts).

## Connecting

Both identity paths end in the same thing: a signed session token, and every endpoint that touches someone's money takes the identity from that token, never from a field in the request.

**Telegram.** The Login Widget button renders only when the frontend is built with `VITE_TELEGRAM_BOT_NAME` (bot username, no `@`) and the backend runs with `TELEGRAM_BOT_TOKEN`. The backend recomputes the widget's check string and compares HMACs (`POST /auth/telegram`), and validates Mini App `initData` separately (`POST /auth/telegram/init`). Without the token the panel states that Telegram login is off rather than showing a button that will 401.

**Wallet.** Injected wallets (MetaMask, Rabby) work with no configuration; WalletConnect QR needs `VITE_WALLETCONNECT_PROJECT_ID`. Ownership is proven, not asserted: `POST /auth/wallet/challenge` returns a one-off `personal_sign` text (5 minutes, single use), `POST /auth/wallet/verify` recovers the address from the signature and rejects it if it is not the address that asked. The follower record is created from that recovered checksummed address.

**The token.** `{user_id, token, expires_at}` comes back from any successful sign-in; send it as `Authorization: Bearer <token>`. It is `wk1.<payload>.<HMAC-SHA256>` signed with `WAKE_SESSION_SECRET` and valid for `WAKE_SESSION_TTL_DAYS` (30 days by default) — there is no server-side state to lose, and no way to claim another user by editing an id in the request. Without `WAKE_SESSION_SECRET` the backend answers 503 instead of issuing tokens signed with a guessable key.

## Quick start

### Frontend

```bash
npm install
cp .env.example .env    # optional: the defaults are mainnet + localhost services
npm run dev             # http://localhost:5173
```

### Backend

The backend needs PostgreSQL and Redis. The fastest correct way to get both is Compose — it also runs the migrations before the API starts:

```bash
docker compose up postgres redis migrate
cd backend
pip install -r requirements.txt
cp .env.example .env      # WAKE_SESSION_SECRET has no default: fill it in
alembic upgrade head      # schema comes from migrations, never from the app
uvicorn app:app --reload --port 8000
```

Swagger UI at `http://localhost:8000/docs`, machine-readable schema (38 paths) at `/openapi.json`; both list the bearer token and the curator header as authorisation. Run it from `backend/` — `config.py` reads `.env` relative to the working directory, so starting from the repo root silently runs with a different configuration.

### Copy trading without a seed script

There is no demo-leader seeder. Sign in with a wallet, then register a leader and a follow — the identity is the token, so the examples below need it:

```bash
MESSAGE=$(curl -s -X POST http://localhost:8000/auth/wallet/challenge \
  -H 'Content-Type: application/json' \
  -d '{"l1_address": "0xYourAddress"}' | jq -r .message)

# Sign $MESSAGE with your wallet (personal_sign), then:
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

`POST /leaders` takes no account index: it is read from the follower record the wallet sign-in wrote, so a leader card cannot show someone else's statistics. The Lighter index appears there only if the address was found on Lighter at sign-in — hence 403 `LIGHTER_ACCOUNT_NOT_LINKED` for a Telegram-only session.

The listener that turns a leader's position changes into follower orders runs per leader:

```bash
cd backend
python leader_listener.py --leader-id <leader_id> --account-index 12345
```

With `WAKE_DRY_RUN=true` it logs the mirror plan instead of signing anything.

### Signing service

```bash
cd backend
uvicorn signing_service:app --port 8787
```

Requires `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_INDEX` and `LIGHTER_API_KEY_PRIVATE_KEY` (an API key exported from app.lighter.xyz — not a wallet private key). The Terminal sends orders here, never to the backend.

### Telegram bot and Mini App

```bash
cd backend
python telegram_bot.py     # reads TELEGRAM_BOT_TOKEN from the environment
```

Commands: `/price BTC`, `/markets`, `/funding`, `/spread BTC`, `/predict` (`/predict resolved`), `/wake`, `/help`. Typing a bare ticker (`BTC`, `eth`, `BTC-USDC`) is the same as `/price` — nobody remembers command syntax. Answers are HTML cards: the numbers sit in a monospace block, so the 24h volume columns actually line up, and a market list comes with the tickers as buttons, so the next tap chooses the market instead of typing it. The list paginates (`ещё →`), and ranks continue across pages — place 11 is place 11, not place 1 again.

`/spread BTC` answers the same asset across every venue Lighter reports (lighter, binance, bybit, hyperliquid) through `funding_arb.venue_rate_rows` — the function behind `GET /funding/venues`. It deliberately does not print a spread or an annualised difference: the venues pay on different epochs, and reducing those numbers to one denominator without checking would be a lie the bot told for convenience.

The "Open Wake" button carries where you were looking: the BTC card opens `?tab=terminal&asset=BTC`, the funding answer opens `?tab=funding`, Predict opens `?tab=predict`. `src/lib/deeplink.ts` validates both parameters against the tab list and a ticker profile before using them.

The command menu is written to Telegram at startup (`set_my_commands`), otherwise autocomplete on `/` is empty and the bot's capabilities are only knowable from a screenshot. If the menu cannot be registered, the bot logs it and keeps polling — the menu is discoverability, not a dependency.

Where the numbers come from is the part that decides whether the bot and the site can disagree:

| Command | Source | Needs the Wake backend |
| --- | --- | --- |
| `/price`, `/markets` | `lighter_rest.py` — public Lighter REST, same client and same `WAKE_LIGHTER_NETWORK` as the Terminal | no |
| `/funding` | `funding_arb.funding_rate_rows` — the exact function `GET /funding/rates` returns | no |
| `/spread` | `funding_arb.venue_rate_rows` — the exact function `GET /funding/venues` returns | no |
| `/predict` | `GET /predict/markets` on `WAKE_BACKEND_URL` | yes, the markets live in the Wake database |

`/predict` says so when the backend is unreachable, and names `WAKE_BACKEND_URL` in the message, instead of showing an empty list. Inside docker-compose that variable is `http://app:8000`: `localhost` inside the bot's own container has nothing listening on 8000.

`WAKE_MINIAPP_URL` is the address the "Open Wake" button opens. Telegram's Bot API rejects a `web_app` button whose URL is not https — and it rejects the whole message, not just the button — so with an http address the bot drops the button, says why in `/start`, and logs the reason at startup rather than failing on every reply.

The bot is read-only by construction: it holds no session, no key and no account index, and there is no code path from a Telegram message to `/place-order`.

### Predict resolver

```bash
cd backend
python predict_resolver.py --loop     # one tick without --loop
```

Price markets close themselves at the deadline only while this process runs; otherwise resolution stays a manual curator call. `WAKE_PREDICT_RESOLVER_TICK` sets the interval (default 300 s).

## Configuration

### Frontend (`.env`, read by Vite at build time)

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_LIGHTER_NETWORK` | `mainnet` | must match the backend's `WAKE_LIGHTER_NETWORK`, or the site and the bot show different market ids |
| `VITE_BACKEND_URL` | Railway URL | baked into the bundle, not changeable at runtime; set `http://localhost:8000` in `.env` for local dev, and note that a production build refuses a loopback value |
| `VITE_SIGNING_SERVICE_URL` | `http://localhost:8787` | |
| `VITE_WALLETCONNECT_PROJECT_ID` | empty | empty means no QR connector; injected wallets still work |
| `VITE_TELEGRAM_BOT_NAME` | empty | empty disables the Telegram login panel |
| `VITE_SENTRY_DSN` | empty | leave empty until a real project exists |

### Backend (`backend/.env`)

[backend/.env.example](backend/.env.example) documents every variable with its code default. The ones that change behaviour:

| Variable | Default | What it gates |
| --- | --- | --- |
| `WAKE_DATABASE_URL` | `postgresql+asyncpg://wake:wake@localhost:5432/wake` | the only store: copy trading, Predict, subscriptions, agent history, audit. A plain `postgresql://…` from a hosting panel is accepted — the asyncpg driver is added at validation |
| `WAKE_REDIS_URL` | `redis://localhost:6379/0` | token bucket and wallet challenges; without it `/ready` answers 503 and sign-in answers 503 |
| `WAKE_LIGHTER_NETWORK` | `mainnet` | name → REST host, WS host and market ids together |
| `WAKE_DRY_RUN` | `true` | `false` means live orders with real money |
| `WAKE_MAINNET_LIVE` | `false` | second switch: `WAKE_DRY_RUN=false` on mainnet refuses to start without it |
| `WAKE_CORS_ORIGINS` | `http://localhost:5173` | comma-separated list of frontends allowed to call the API |
| `WAKE_SESSION_SECRET` | empty | signs session tokens; empty means every sign-in answers 503 rather than using a guessable key |
| `WAKE_SESSION_TTL_DAYS` | 30 | how long a token stays valid (1–180) |
| `WAKE_CURATOR_TOKEN` | empty | empty answers 500 `CURATOR_NOT_CONFIGURED` on every operator endpoint; a wrong `X-Curator-Token` answers 403 |
| `WAKE_TRUSTED_PROXY_IPS` | empty | which connection peers may supply `X-Forwarded-For`; empty means the socket address wins, so behind Railway everyone shares one bucket |
| `TELEGRAM_BOT_TOKEN` | empty | bot process and Telegram login verification |
| `WAKE_MASTER_KEY` | empty | encrypts the key store; keep it in a secrets manager, not on disk |
| `WAKE_RATE_LIMIT_CAPACITY` / `WAKE_RATE_LIMIT_REFILL` | 40 / 20 | token bucket per signed-in user, per IP for anonymous traffic; a write costs 3 tokens |
| `ANTHROPIC_API_KEY` | empty | only the LLM decision path; without it the agent runs the rule engine |

## Testing

```bash
# backend — run from backend/; needs a scratch PostgreSQL database
createdb wake_test
export WAKE_TEST_DATABASE_URL=postgresql+asyncpg://wake:wake@localhost:5432/wake_test
python -m unittest discover        # 350 tests, all through discovery
python -m pytest -q                # the same set under pytest (+ Allure in CI)

# frontend
npx tsc --noEmit
npx vitest run
npm run build

# end-to-end (starts its own dev server; PW_PORT avoids a port clash)
PW_PORT=5178 npx playwright test
```

`test_api_smoke.py` walks every API route over HTTP against a real PostgreSQL, including the parts of the security model that are easy to lose silently: no token, forged token, expired token, another user's record, a replayed wallet signature, a curator endpoint without the header. A route that regresses from 403 to 200 fails there, not on the first click.

## Architecture

### Backend (FastAPI)

- `backend/app.py` — app, middleware (CORS, security headers, Redis token bucket keyed by session subject and falling back to the client IP, optional Sentry), router registration, `/health` and `/ready`
- `backend/session.py` — issues and verifies the `wk1.<payload>.<HMAC>` token; `backend/api/guards.py` — `require_user` / `require_curator` as router dependencies
- `backend/wallet_auth.py` — EIP-191 challenge storage in Redis, single use, address recovery; `backend/net.py` — the client address when a proxy stands in front
- `backend/api/` — HTTP routers by product area:
  - `auth.py` — Telegram Login Widget, Mini App `initData` and wallet sign-in
  - `markets.py` — `/markets/overview`: perp ranking by 24h quote volume
  - `copy_trading.py` — followers, leaders, follows, mirror log
  - `predict.py` — price and event markets, curator-gated resolution
  - `agent.py` — decisions, memory, subscriptions
  - `portfolio.py` — cross-asset risk and hedge
  - `funding.py` — venue comparison and carry calculations
- Storage is one PostgreSQL base: `database.py` (async engine), `pg_models.py` (schema), `alembic/` (migrations), and the repositories `db.py`, `predict_db.py`, `agent_db.py`, `audit_log.py`, `subscription.py`
- Core logic lives in root modules and is tested on its own: `mirror_engine.py`, `leader_position_tracker.py`, `predict_amm.py`, `predict_resolution.py`, `portfolio_risk.py`, `funding_arb.py`, `agent_decision.py`, `agent_memory.py`, `risk_limits.py`, `rate_limiter.py`, `cache.py`
- Configuration is read once in `backend/config.py`, and every variable it owns is validated there — a bad combination (live orders on mainnet without the second switch, a non-Postgres URL) stops the process at startup. A handful of variables stay outside it because they belong to one process: the signing key triple in `signing_service.py`, `WAKE_MASTER_KEY` and `WAKE_KEYSTORE_PATH` in `encrypted_key_store.py`, `WAKE_TEST_DATABASE_URL` in the tests, `WAKE_ORDER_*` in `place_order_example.py`. They are listed in `backend/.env.example` too, with the process that reads each one.

### Frontend (React + TypeScript + Vite + Tailwind + wagmi)

- `src/App.tsx` — tab shell, connection state, the backend health probe
- `src/components/` — one file per panel
- `src/lib/backend.ts` — the only place that calls the Wake backend; every error a panel shows is produced here
- `src/lib/session.ts` — the session token from a sign-in, kept in `localStorage` under `wake.session.v1`; `backend.ts` reads it to set `Authorization`, and a 401 clears it and announces the sign-out
- `src/lib/wallet.ts` — wallet sign-in: ask the backend for a challenge, sign it with `personal_sign`, send the signature back; the address is recovered server-side, so the client never claims an identity
- `src/lib/lighter.ts` — Lighter public REST client
- `src/lib/predict.ts`, `src/lib/telegram.ts`, `src/lib/leaders.ts`, `src/lib/config.ts`

## Deployment

### Frontend: Cloudflare Pages (this is what runs)

Project `wake` → https://wake-7k6.pages.dev.

- The project is **not** connected to Git and has no Cloudflare build configuration: the artifact is produced locally and uploaded with wrangler. `npx wrangler pages project list` shows `Git Provider: No`, and `builds` is null on the project.
- Consequence worth knowing: `VITE_*` values come from the root `.env` **on the machine that builds**, because the deployment carries no environment variables of its own. They are compiled into the bundle, so changing one requires a rebuild and a redeploy. A `.env` with an empty `VITE_TELEGRAM_BOT_NAME` produces a site whose Telegram login is switched off, and the Cloudflare dashboard will not show you that — this is how a wrong bot handle reached production once.
- Verify what actually shipped instead of trusting the build log:

```bash
npx wrangler pages deployment list --project-name wake | head -5
curl -s https://wake-7k6.pages.dev/ -o /tmp/i.html
grep -o 'assets/index-[A-Za-z0-9_-]*\.js' /tmp/i.html      # the bundle name is the build id
curl -s https://wake-7k6.pages.dev/assets/<that-name>.js | grep -c waketrade_bot
```

- `public/_redirects` contains `/* /index.html 200` so deep links into the SPA resolve
- A production build refuses `VITE_BACKEND_URL` pointing at localhost: `npm run build`
  stops with the reason instead of uploading a bundle whose "backend" is each
  visitor's own machine. `cp .env.example .env` is a development setup — to build
  something deployable, drop the line or set the deployed address.

One consequence worth knowing: because Pages answers *any* unknown path with `index.html` and status 200, an API request to a host with no backend returns HTML. `src/lib/backend.ts` turns that into a readable "there is no backend at this address" message instead of a JSON parse error, and the panels print which three still work.

Deploy from the repo:

```bash
npm run build
npx wrangler pages deploy dist --project-name wake
```

### Backend: Railway (this is what runs)

The image is built from the `Dockerfile` at the repo root (`railway.json` configures the build). Variables are set through the dashboard or the CLI:

```bash
railway variables set WAKE_CORS_ORIGINS="https://wake-7k6.pages.dev"
railway variables set WAKE_SESSION_SECRET="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
railway variables set WAKE_CURATOR_TOKEN="$(python -c 'import secrets;print(secrets.token_urlsafe(32))')"
```

A PostgreSQL and a Redis service must be attached, and their connection strings go into `WAKE_DATABASE_URL` and `WAKE_REDIS_URL`. Without them the process still answers `/health` — that endpoint reports liveness only — while `/ready` reports the truth:

```bash
curl -s "$URL/ready"
# {"status":"ready","checks":{"database":"ok","redis":"ok"}}      — attached
# {"status":"not_ready","checks":{"database":"fail","redis":"fail"}} — not attached
```

The schema is created by `alembic upgrade head`, not by the app. On Railway run it as a one-off deploy command or as a separate service that exits (see [docs/RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) — the image ships `alembic.ini` and `alembic/` for exactly this).

### Alternative: Docker Compose (local or self-hosted)

```bash
docker compose up app              # :8000
docker compose up signing          # :8787
docker compose up telegram-bot     # needs TELEGRAM_BOT_TOKEN
docker compose up predict-resolver
```

`app`, `signing` and `predict-resolver` wait for the `migrate` service to exit successfully, so a fresh stack comes up with a migrated schema. Data lives in `postgres-data` and `redis-data`; `wake-data` holds only the encrypted key store. Secrets come from `backend/.env`, which `docker-compose.yml` reads but does not require — the compose file carries local-only session and curator values so the stack can be signed into out of the box.

## Known limits, stated plainly

- `fee_bps` on a leader is validated (0–500) and stored, but nothing charges it — there is no payout path.
- No payments of any kind. Subscription tiers and trials (`backend/subscription.py`) exist as state only.
- Session tokens are not revocable: there is no server-side session store, so a leaked token is valid until `WAKE_SESSION_TTL_DAYS` passes and "log out" can only mean discarding it on the client. The trade-off was made deliberately for a backend that survives a Redis flush, and it is the reason the TTL is bounded at 180 days.
- The rate limiter fails open when Redis is unreachable — a dead Redis must not take the terminal away from someone with open positions. `/ready` reports that state instead of hiding it.
- Predict markets are an internal LMSR AMM: prices and payouts are computed against the pool in this database, not against a counterparty on an exchange.
- The LLM decision path is covered by fallback tests (`test_llm_agent.py`) — no key, network error, malformed JSON, invalid action — but not by a call to a real model.
- `leader_listener.py`'s websocket connection is not exercised by tests (they cover the snapshot-diffing logic around it); it needs a network to verify.
- A leader's `handle` is whatever the registering user types. The account index behind it is not free-text any more — it is taken from the wallet-verified follower record — but the handle itself is unverified.
- `/markets/overview` costs 18 candle requests per refresh and is cached for 60 seconds.

## Security

- Secrets come from environment variables only; `backend/.env` is gitignored, as are `*.db` and `*.enc`.
- Identity is a signed token (`WAKE_SESSION_SECRET`), never an identifier in the request body: no endpoint lets a caller name whose positions, follows or subscription they want to read.
- Wallet sign-in proves ownership with an EIP-191 signature over a single-use challenge; the address is recovered from the signature and the Lighter account index is read from the server-side record, not from the request.
- `WAKE_DRY_RUN` defaults to `true`, and turning it off on mainnet additionally requires `WAKE_MAINNET_LIVE=true`; the process refuses to start otherwise. Order sizes always round down.
- Every path that can reach Lighter — the signing service, the copy-trading listener and the agent runner — checks `WAKE_DRY_RUN` in its own process before touching the SDK. While it is on, `/place-order` returns the order it would have sent and nothing reaches the exchange; `/health` of both services reports which mode they are in.
- Curator endpoints require the `X-Curator-Token` header, compared with `hmac.compare_digest` over bytes; if the token is not configured on the server they answer 500 instead of allowing anonymous market creation or resolution.
- `X-Forwarded-For` is honoured only from `WAKE_TRUSTED_PROXY_IPS`, and only the rightmost address in the chain — otherwise a client could pick the IP that rate limits and audit records show for it.
- Every SQL statement goes through SQLAlchemy Core/ORM with bound parameters; there is no string-built SQL in the backend.
- Keys are encrypted at rest (`encrypted_key_store.py`) — this is encryption, not an HSM.
- `/health` and `/ready` need no token; everything else that reads or writes state does. Errors are one JSON shape — `{error: {code, message}}` — so a client can branch on `code` instead of parsing a sentence.

To use this with real funds: get an external security audit, replace the file keystore with HSM/KMS, and get legal advice for your jurisdiction. Report vulnerabilities privately through GitHub's security advisory feature rather than a public issue.

## Documentation

- [README.ru.md](README.ru.md) — русская версия
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md) — trust boundaries and the production checklist
- [CHANGELOG.md](CHANGELOG.md)
- [LICENSE](LICENSE) — MIT

## License

MIT — see [LICENSE](LICENSE).
