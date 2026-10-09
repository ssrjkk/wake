# Wake

[![CI](https://github.com/ssrjkk/wake/actions/workflows/ci.yml/badge.svg)](https://github.com/ssrjkk/wake/actions/workflows/ci.yml)
[![python-3.12+](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)



Trading terminal for [Lighter](https://lighter.xyz) (zk perp DEX): a React web app, a FastAPI backend, and a Telegram bot with a Mini App — the bot and the site read and write the same backend.

Default configuration is **mainnet** with `WAKE_DRY_RUN=true`: real market data from the real network, and no order ever leaves the process until you turn dry-run off yourself.

Live frontend: https://wake-7k6.pages.dev  
Live backend: https://wake-backend-production-3483.up.railway.app

## Screenshots

<!-- TODO: Add demo screenshot -->

## Screenshots

<!-- TODO: Add demo screenshot -->

## Contact

- **Telegram:** [@ssrjkk](https://t.me/ssrjkk)
- **GitHub:** [@ssrjkk](https://github.com/ssrjkk)

## What each panel does

| Panel | Where the data comes from | Works without the Wake backend |
| --- | --- | --- |
| Обзор (Overview) | Market ranking by real 24h quote volume (`/markets/overview`, 18 perp markets, cached 60 s) plus open Predict markets | no |
| Терминал (Terminal) | Order book, candles and recent trades from Lighter's public REST | reads yes; sending an order needs the signing service |
| Discover | Leaders ranked by follower count and AUM, follow / pause / unfollow | no |
| Портфель (Portfolio) | Your positions on Lighter looked up by L1 address (public REST); subscriptions and the copy-engine log from the backend | positions yes, copy state no |
| Earn | Copy subscription state and trial activation | no |
| Predict | LMSR price and event markets: creation, quoting, resolution, claims | no |
| Агент (Agent) | Per-market decision with per-market win-rate memory | no |
| Risk | Cross-asset exposure and hedge sizing | no |
| Funding | Lighter funding rate next to Binance, Bybit and Hyperliquid for the same `market_id` (all four come from Lighter's `/funding-rates`), annualised at 24 epochs/day | rates yes; the arb check and sizing call the backend |

Those three keep working with no backend, which is why the site does not go blank when the backend is missing — see [src/lib/backend.ts](src/lib/backend.ts).

## Connecting

Two identity paths, both landing on the same follower record:

**Telegram.** The Login Widget button renders only when the frontend is built with `VITE_TELEGRAM_BOT_NAME` (bot username, no `@`) and the backend runs with `TELEGRAM_BOT_TOKEN`. The backend recomputes the widget's check string and compares HMACs (`POST /auth/telegram`), and validates Mini App `initData` separately (`POST /auth/telegram/init`). Without the token the panel states that Telegram login is off rather than showing a button that will 401.

**Wallet.** Injected wallets (MetaMask, Rabby) work with no configuration; WalletConnect QR needs `VITE_WALLETCONNECT_PROJECT_ID`. The connected L1 address is registered as the follower (`POST /followers`), and positions are read back from Lighter by that address.

## Quick start

### Frontend

```bash
npm install
cp .env.example .env    # optional: the defaults are mainnet + localhost services
npm run dev             # http://localhost:5173
```

### Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --port 8000
```

Swagger UI at `http://localhost:8000/docs`, machine-readable schema (37 paths) at `/openapi.json`. Run it from `backend/`: the SQLite paths are relative to the working directory, so starting it from the repo root silently creates a second database.

### Copy trading without a seed script

There is no demo-leader seeder. Register a leader through the API, then a follower:

```bash
curl -X POST http://localhost:8000/leaders \
  -H 'Content-Type: application/json' \
  -d '{"lighter_account_index": 12345, "handle": "your-handle", "fee_bps": 8}'

curl -X POST http://localhost:8000/followers \
  -H 'Content-Type: application/json' \
  -d '{"l1_address": "0xYourAddress"}'

curl -X POST http://localhost:8000/follows \
  -H 'Content-Type: application/json' \
  -d '{"follower_id": "0xYourAddress", "leader_id": "<leader_id>", "allocation_usd": 500, "max_leverage": 3}'
```

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

Commands: `/start`, `/help`, `/price BTC`, `/markets`, `/funding`, `/predict`, `/predict resolved`. The bot's answers come from the same endpoints the site uses (`/markets/overview`, `/funding/rates`, `/predict/markets`), so the two cannot drift apart. `WAKE_MINIAPP_URL` is the address the bot's "Open Wake" button opens — Telegram requires it to be https.

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
| `VITE_BACKEND_URL` | Railway URL | baked into the bundle, not changeable at runtime; set `http://localhost:8000` in `.env` for local dev |
| `VITE_SIGNING_SERVICE_URL` | `http://localhost:8787` | |
| `VITE_WALLETCONNECT_PROJECT_ID` | empty | empty means no QR connector; injected wallets still work |
| `VITE_TELEGRAM_BOT_NAME` | empty | empty disables the Telegram login panel |
| `VITE_SENTRY_DSN` | empty | leave empty until a real project exists |

### Backend (`backend/.env`)

[backend/.env.example](backend/.env.example) documents every variable with its code default. The ones that change behaviour:

| Variable | Default | What it gates |
| --- | --- | --- |
| `WAKE_LIGHTER_NETWORK` | `mainnet` | name → REST host, WS host and market ids together |
| `WAKE_DRY_RUN` | `true` | `false` means live orders with real money |
| `WAKE_CORS_ORIGINS` | `http://localhost:5173` | comma-separated list of frontends allowed to call the API |
| `WAKE_CURATOR_TOKEN` | empty | empty answers 500 on every curator endpoint; a wrong `X-Curator-Token` answers 403 |
| `TELEGRAM_BOT_TOKEN` | empty | bot process and Telegram login verification |
| `WAKE_MASTER_KEY` | empty | encrypts the key store; keep it in a secrets manager, not on disk |
| `WAKE_DB_PATH` / `WAKE_AUDIT_DB_PATH` | `wake.db` / `audit.db` | two separate SQLite files |
| `WAKE_RATE_LIMIT_CAPACITY` / `WAKE_RATE_LIMIT_REFILL` | 40 / 20 | token bucket per client |
| `ANTHROPIC_API_KEY` | empty | only the LLM decision path; without it the agent runs the rule engine |

## Testing

```bash
# backend — run from backend/
python -m unittest discover          # 210 tests
python test_db.py
python test_predict_db.py
python test_predict_integration.py
python test_audit_log.py             # these four are standalone scripts, not part of discovery

# frontend
npx tsc --noEmit
npx vitest run                       # 61 tests in 8 files
npm run build

# end-to-end (starts its own dev server; PW_PORT avoids a port clash)
PW_PORT=5178 npx playwright test     # 6 tests, chromium
```

`test_api_smoke.py` walks every API route over HTTP, so a router that fails to import or a path that 500s fails CI rather than the first click.

## Architecture

### Backend (FastAPI)

- `backend/app.py` — app, middleware (CORS, rate limiting by client IP, optional Sentry), router registration, `/health`
- `backend/api/` — HTTP routers by product area:
  - `auth.py` — Telegram Login Widget and Mini App `initData` verification
  - `markets.py` — `/markets/overview`: perp ranking by 24h quote volume
  - `copy_trading.py` — followers, leaders, follows, mirror log
  - `predict.py` — price and event markets, curator-gated resolution
  - `agent.py` — decisions, memory, subscriptions
  - `portfolio.py` — cross-asset risk and hedge
  - `funding.py` — venue comparison and carry calculations
- Core logic lives in root modules and is tested on its own: `mirror_engine.py`, `leader_position_tracker.py`, `predict_amm.py`, `predict_resolution.py`, `portfolio_risk.py`, `funding_arb.py`, `agent_decision.py`, `agent_memory.py`, `risk_limits.py`, `rate_limiter.py`, `cache.py`, `db.py`, `predict_db.py`, `audit_log.py`
- Configuration is read once in `backend/config.py`

### Frontend (React + TypeScript + Vite + Tailwind + wagmi)

- `src/App.tsx` — tab shell, connection state, the backend health probe
- `src/components/` — one file per panel
- `src/lib/backend.ts` — the only place that calls the Wake backend; every error a panel shows is produced here
- `src/lib/lighter.ts` — Lighter public REST client
- `src/lib/predict.ts`, `src/lib/telegram.ts`, `src/lib/leaders.ts`, `src/lib/config.ts`

## Deployment

### Frontend: Cloudflare Pages (this is what runs)

Project `wake` → https://wake-7k6.pages.dev.

- build command `npm run build`, output directory `dist`, Node 24
- set the `VITE_*` variables as build env vars; they are compiled into the bundle, so changing one requires a rebuild
- `public/_redirects` contains `/* /index.html 200` so deep links into the SPA resolve

One consequence worth knowing: because Pages answers *any* unknown path with `index.html` and status 200, an API request to a host with no backend returns HTML. `src/lib/backend.ts` turns that into a readable "there is no backend at this address" message instead of a JSON parse error, and the panels print which three still work.

Deploy from the repo:

```bash
npm run build
npx wrangler pages deploy dist --project-name wake
```

### Backend: Railway (this is what runs)

The backend runs on Railway via Docker (`Dockerfile` at the repo root, `railway.json` configures the build). Environment variables are set through the Railway dashboard or CLI.

```bash
railway variables set WAKE_DRY_RUN=true WAKE_LIGHTER_NETWORK=mainnet
railway variables set WAKE_CORS_ORIGINS="https://wake-7k6.pages.dev"
railway service redeploy --service wake-backend
```

See [RAILWAY_DEPLOY.md](docs/RAILWAY_DEPLOY.md) for the full setup guide.

**Alternative: Docker Compose (local or self-hosted)**

```bash
docker compose up app              # :8000
docker compose up signing          # :8787
docker compose up telegram-bot     # needs TELEGRAM_BOT_TOKEN
docker compose up predict-resolver
```

Databases persist in the `wake-data` volume; secrets come from `backend/.env`, which `docker-compose.yml` reads but does not require.

## Known limits, stated plainly

- `fee_bps` on a leader is validated (0–500) and stored, but nothing charges it — there is no payout path.
- No payments of any kind. Subscription tiers and trials (`backend/subscription.py`) exist as state only.
- Agent memory, subscriptions and risk state in `backend/api/agent.py` live in per-process dictionaries — they are gone on restart. The copy-trading and Predict data is in SQLite; this is not.
- The LLM decision path (`backend/llm_agent.py`) has no automated test. It falls back to the tested rule engine when the call fails or no key is set.
- `leader_listener.py`'s websocket connection is not exercised by tests (they cover the snapshot-diffing logic around it); it needs a network to verify.
- SQLite for local dev and copy-trading/Predict data; PostgreSQL is available for production (see `backend/database.py`, `backend/pg_models.py`, `alembic/`). Agent memory and subscriptions are per-process and lost on restart.
- A leader's `handle` is whatever the registering user types; it is not matched to a verified Lighter account.
- `/markets/overview` costs 18 candle requests per refresh and is cached for 60 seconds.

## Security

- Secrets come from environment variables only; `backend/.env` is gitignored, as are `wake.db`, `audit.db`, `*.enc` and dev keystores.
- `WAKE_DRY_RUN` defaults to `true`; order sizes always round down.
- Curator endpoints require the `X-Curator-Token` header and compare it with `hmac.compare_digest`; if the token is not configured on the server they stay closed instead of allowing anonymous market creation or resolution.
- SQL is parameterized throughout; CORS and the rate limiter are env-driven.
- Keys are encrypted at rest (`encrypted_key_store.py`, optional KMS mode) — this is encryption, not an HSM.

To use this with real funds: get an external security audit, replace the file keystore with HSM/KMS, and get legal advice for your jurisdiction. Report vulnerabilities privately through GitHub's security advisory feature rather than a public issue.

## Documentation

- [README.ru.md](README.ru.md) — русская версия
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [LICENSE](LICENSE) — MIT

## License

MIT — see [LICENSE](LICENSE).


## Installation

```bash
git clone https://github.com/ssrjkk/wake.git
cd wake
pip install -r requirements.txt
```

## Usage

```bash
python main.py
```
