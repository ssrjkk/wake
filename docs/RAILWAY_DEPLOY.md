# Backend Deployment on Railway

The backend is one Docker image (`Dockerfile` at the repo root) that needs a PostgreSQL and a Redis. Without them the process still starts and answers `/health`, while `/ready` reports `database: fail, redis: fail` — `/health` is liveness, not readiness, and sign-in and every write fail in that state.

## 1. Services

| Service | Why it is needed | What it provides |
| --- | --- | --- |
| Backend (Dockerfile) | API, `/auth/*`, copy trading, Predict | the domain the frontend sends to `VITE_BACKEND_URL` |
| PostgreSQL | the only store: followers/leaders/follows, Predict markets, subscriptions, agent history, audit | a connection string for `WAKE_DATABASE_URL` |
| Redis | token-bucket rate limiting and single-use wallet challenges | a connection string for `WAKE_REDIS_URL` |
| Signing service (optional) | signs Lighter orders | a second service from the same image, command `uvicorn signing_service:app --host 0.0.0.0 --port $PORT` |
| Telegram bot (optional) | answers `/price`, `/markets`, `/funding`, `/predict` and opens the Mini App | a second service from the same image, command `python telegram_bot.py`; needs `TELEGRAM_BOT_TOKEN`, `WAKE_MINIAPP_URL` (https) and `WAKE_BACKEND_URL` (the API service's own domain — `localhost` in its container is not the API) |

Railway hands out the connection strings when you attach a service. A plain `postgresql://…` without a driver is fine: `backend/config.py` appends `+asyncpg` while validating, and alembic uses the same value.

## 2. Variables

Required — without them part of the product does not work at all:

```
WAKE_SESSION_SECRET    signs session tokens; empty means every sign-in answers 503
WAKE_CURATOR_TOKEN     operator endpoints (markets, resolution, simulate-mirror); empty means 503
WAKE_DATABASE_URL      the PostgreSQL string from the attached service
WAKE_REDIS_URL         the Redis string from the attached service
WAKE_CORS_ORIGINS      the frontend origin, comma-separated, e.g. https://wake-7k6.pages.dev
```

Generate a secret:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

```bash
railway variables set WAKE_SESSION_SECRET="…" WAKE_CURATOR_TOKEN="…"
railway variables set WAKE_CORS_ORIGINS="https://wake-7k6.pages.dev"
```

Defaults worth knowing:

```
WAKE_LIGHTER_NETWORK = mainnet    one name decides the REST host, the WS host and the market indexes
WAKE_DRY_RUN = true               false means live orders
WAKE_SESSION_TTL_DAYS = 30
WAKE_RATE_LIMIT_CAPACITY / REFILL = 40 / 20
TELEGRAM_BOT_TOKEN                needed by the bot process and by Telegram login verification (503 without it)
WAKE_MINIAPP_URL = http://localhost:5173/   the address the bot's Open Wake button opens; Telegram accepts https only, so on http the bot drops the button and logs why
WAKE_BACKEND_URL = http://localhost:8000    where the bot fetches Predict markets from; on Railway this must be the API service's own https domain
```

The bot registers its command menu at startup (`set_my_commands`), so nothing has to be typed into BotFather for `/price` and friends to appear in Telegram's autocomplete. What BotFather still owns is the web-view domain itself (`/setdomain`), and that is a manual step in his account.

`WAKE_DB_PATH` and `WAKE_AUDIT_DB_PATH` are gone from these instructions: there is no file database any more, and nothing reads those variables.

## 3. Migrations

`alembic upgrade head` creates the schema, not the application: production code has no DDL privileges, and "the tables will appear on their own" leaves you with a database whose structure drifts from the migrations. The image ships `alembic.ini` and `alembic/`, and `railway.json` overrides the image command with one that migrates before the API comes up:

```
sh -c "alembic upgrade head && uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"
```

If the migration fails, the service does not start and the deploy log names the reason (usually an unreachable database) instead of showing a green instance that cannot answer a single request. Docker Compose solves the same problem differently: the image command stays API-only there, and a one-shot `migrate` container runs ahead of `app`, `signing` and `predict-resolver`. To look at the schema separately:

```bash
railway run alembic heads     # expected head is the one in backend/alembic/versions
```

CI runs `alembic check`, which compares the models against the migrations, so `pg_models.py` and `alembic/` cannot drift apart quietly.

## 4. Verification

```bash
curl -s https://<domain>/health
# {"status":"ok","network":"mainnet","dry_run":true}

curl -s https://<domain>/ready
# {"status":"ready","checks":{"database":"ok","redis":"ok"}}

curl -s -o /dev/null -w "%{http_code}\n" https://<domain>/subscription
# 401 — the endpoint is alive and wants a token; 404 would mean the image is older than the schema
```

Then sign in with a wallet from the live frontend and call `GET /follows` with the token it returned.

## 5. Proxies and rate limiting

Behind Railway the connection address is the proxy's address. Without `WAKE_TRUSTED_PROXY_IPS` every client shares one bucket and one audit entry. A signed token already removes the worst of it — the bucket key is the session subject — but anonymous traffic and the IP recorded at sign-in still say "proxy". Read the real address out of the `ip` field of a `sign_in` row after the first login and put it into `WAKE_TRUSTED_PROXY_IPS`. `X-Forwarded-For` is accepted only from that address, and only its rightmost element.

The trail is readable without a database session — `GET /audit` returns the newest events and needs the same `X-Curator-Token` as the operator endpoints:

```bash
curl -sS "$BACKEND/audit?action=sign_in&limit=5" \
  -H "X-Curator-Token: $WAKE_CURATOR_TOKEN"
```

`details` comes back as an object, `success=0` marks a rejected attempt, and `failed_only=true` keeps only those. One response is capped at 500 rows (`audit_log.MAX_ROWS`), so `?limit=` cannot be used to pull the whole table into memory.

## 6. Live orders

Two independent switches, deliberately: `WAKE_DRY_RUN` has a single value, and a typo in a deploy would otherwise put other people's money into a live network.

```bash
railway variables set WAKE_DRY_RUN=false WAKE_MAINNET_LIVE=true
```

On mainnet the process refuses to start without `WAKE_MAINNET_LIVE=true` and says what is missing. On testnet the second switch is not required — that is where the order path gets checked, with dry-run off.

## 7. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/ready` → `database: fail` | `WAKE_DATABASE_URL` does not point at the attached service, or the schema was never migrated |
| `/ready` → `redis: fail` | `WAKE_REDIS_URL` missing or Redis not attached; the rate limiter then lets everything through (fail open) and wallet sign-in answers 503 |
| Sign-in → 503 `SESSION_NOT_CONFIGURED` | `WAKE_SESSION_SECRET` is empty |
| Sign-in → 503 `CHALLENGE_STORE_UNAVAILABLE` | Redis is unreachable, so a challenge cannot be stored — verifying a signature "on trust" is not an option |
| `POST /leaders` → 403 `LIGHTER_ACCOUNT_NOT_LINKED` | the session came from Telegram; a leader is published by the Lighter account index a wallet sign-in confirmed |
| Operator endpoint → 503 `CURATOR_NOT_CONFIGURED` | `WAKE_CURATOR_TOKEN` is not set on the server |
| Frontend says "there is no backend at this address" | `VITE_BACKEND_URL` was built with a different address, or Pages answered an unknown path with `index.html` — see `src/lib/backend.ts` |
| CORS error in the browser console | the frontend origin is missing from `WAKE_CORS_ORIGINS`; the browser blocks the response, the backend is not failing to send it |
