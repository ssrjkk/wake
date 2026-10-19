# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There have been no tagged releases yet. Everything below `Unreleased` is dated
from the commit history rather than from a release.

## [Unreleased]

### Added

- Signed session tokens (`backend/session.py`): `wk1.<payload>.<HMAC-SHA256>`,
  verified with `hmac.compare_digest` before the expiry check. Without
  `WAKE_SESSION_SECRET` the server answers 503 instead of signing with a
  guessable key.
- Wallet proof-of-ownership sign-in (`backend/wallet_auth.py`): EIP-191 challenge
  binding address, nonce and expiry, stored in Redis with a 300-second TTL and
  consumed with `GETDEL`, address recovered from the signature and normalised to
  EIP-55.
- Two Telegram sign-in paths in `backend/api/auth.py` — Login Widget and Mini App
  `initData` — with the distinct key derivations each one requires, a 24-hour
  freshness limit, and an audit row for accepted and rejected sign-ins alike.
- Shared access guards (`backend/api/guards.py`) and proxy-aware client IP
  (`backend/net.py`).
- `/ready` readiness endpoint, separate from `/health`: it checks PostgreSQL and
  Redis and reports which one failed.
- Endpoints that read owner state from the session instead of the request:
  `/subscription`, `/subscription/trial`, `/agent/memory`, follow and mirror-log
  routes, Predict positions, trades, claims.
- Alembic as the only schema path (`001_initial`, `002_agent_owner_indexes`),
  with `alembic check` in CI failing on drift.
- Tests for the signing service (`backend/test_signing_service.py`): dry-run
  returns the order without sending it, live mode sends it, malformed payloads
  fail as 422 before any SDK call, replayed `client_order_index` is deduplicated.
- A `PgCase` test base (`backend/testsupport.py`): backend tests run against a
  real PostgreSQL, never against mocks or another dialect.
- Session storage in the browser (`src/lib/session.ts`): the token, its subject
  and its expiry live under one versioned key. `src/lib/backend.ts` clears it on
  any 401 and broadcasts the sign-out, so no panel keeps rendering state that
  belongs to a session the server has already rejected.
- Wallet sign-in in the browser (`src/lib/wallet.ts`): the EIP-191 challenge is
  signed by the connected account and the signature is what the server verifies.
- `.empty-state` and `.link-action` in `src/index.css`, the shared treatment for
  a panel with nothing in it.
- CI jobs for lint, dependency audit, backend tests, frontend checks, frontend
  tests, end-to-end and a Docker build.
- `SECURITY.md` and `CONTRIBUTING.md` (English and Russian), documenting the
  trust boundaries, the local gates and the deployment contract.

### Changed

- All backend storage converged on PostgreSQL. A file database would have
  survived a container restart only as long as the container did, and would not
  execute the `ON CONFLICT`, `FOR UPDATE` and case-sensitive `LIKE` behaviour the
  copy engine relies on; `WAKE_DATABASE_URL` now rejects anything that is not
  PostgreSQL at import.
- Rate limiting is a Redis token bucket keyed on the session subject when the
  bearer verifies and on the client IP otherwise, with write methods costing
  three tokens. State lives in Redis so it holds across workers and instances.
- `backend/config.py` validates every setting at import, including the live-trading
  gate: `WAKE_DRY_RUN=false` on mainnet additionally requires
  `WAKE_MAINNET_LIVE=true`, or the process refuses to start.
- `backend/signing_service.py` now applies `WAKE_DRY_RUN` itself. Before this, the
  browser-reachable `/place-order` ignored it, so the documented promise that no
  order leaves the process until dry-run is turned off did not hold for the
  Terminal. `/health` reports the mode, and the Terminal says plainly when an
  order was not sent.
- Order requests are bounded by pydantic (`base_amount` and `price` positive,
  `market_index` non-negative), and the compose stack publishes the signing port
  on `127.0.0.1` only.
- `railway.json` runs `alembic upgrade head` before `uvicorn`, so a deployed
  instance is migrated before it serves traffic; the image command stays
  API-only for Compose, which migrates through a one-shot container that the API
  waits on.
- Errors are one JSON shape everywhere — `{error: {code, message}}` — so clients
  branch on `code` instead of parsing a sentence.
- The frontend authenticates every backend call with the session token instead of
  naming an owner in the request body. The copy that promised "trades are written
  to your `follower_id`" described a field the server no longer reads.
- Accent colours have three non-overlapping jobs: the logo orange is identity and
  the primary action (header, active network, active tab, `.btn-primary`), blue is
  a selection inside a panel (filter, slider, selected row) and a hyperlink, and
  green/red mean trade direction and nothing else. The Predict ticket had been
  blue for both buy and sell; it now reads the way the Terminal order ticket does.

### Removed

- SQLite-era scripts: `backend/migrate.py`, `backend/migrate_sqlite_to_pg.py` and
  their test.
- `backend/key_store.py` (plaintext dev keystore) and `backend/kms_key_store.py`
  (untested, needed a dependency that is not installed) — neither was imported
  anywhere. `encrypted_key_store.py` is the one the copy engine uses.
- `backend/_run_local.py`, which patched the rate limiter with a test-only
  dependency; `docker compose up -d postgres redis` is the documented local path.
- The `WAKE_DEV_KEYSTORE_PATH` and `WAKE_KMS_KEY_ID` variables and the README
  claim of an "optional KMS mode", which the removed file could not deliver.

### Fixed

- Order sizes round down to the market's size decimals instead of rounding up
  into a larger position than requested.
- The audit-log index was created against the wrong database in the initial
  migration path.
- CI steps that were red only after the root jobs passed, and two lint errors
  that had held the pipeline red since 2026-10-03.
- The Terminal chart had no price axis and no time axis, so the line had no scale
  to read against. Both are drawn now, with the price column on the right and
  ticks taken from the candles themselves.
- A candle timestamp is epoch milliseconds, but the tooltip multiplied it by 1000
  again and printed a date in the year 58,921.
- Test requests asserted against `String(body)`, which turns an object into
  `"[object Object]"` and lets a wrong payload pass. They parse the body now and
  fail loudly when it is not the JSON the code claims to send.
- CI and compose asked for `redis:8.1-alpine`, a Redis server release that has
  never existed — the number was taken from the Python client pin `redis>=8.1.0`,
  which is a separate version line. Both now run `redis:8-alpine`, and the
  documented local path (`docker compose up`) resolves as well as the gate does.
- `.dockerignore` excluded `backend/alembic/` and `backend/alembic.ini`, which the
  Dockerfile copies two lines later, so `docker build` failed on the migration
  layer and no image — Railway or Compose — could ever contain `alembic upgrade
  head`. The ignore list is a filter on the build context, not on the finished
  image, so a stale entry there reads as "this file is junk" while the build says
  "this file is missing".
- The README linked the bot as `@wake_trade`; the handle registered with
  @BotFather is `@waketrade_bot`, which is also what `data-telegram-login` has to
  receive. Both mentions now carry the real handle.

## Pre-release history

- 2026-10-15 — Tailwind theme restored; the Terminal made usable on mobile.
- 2026-10-13 — dependency bumps: Redis client `>=8.1.0`, SQLAlchemy, Python base
  image `3.12-slim` to `3.14-slim`.
- 2026-10-12 — Dependabot version updates enabled for npm, pip, Docker and
  GitHub Actions; Actions moved to current majors.
- 2026-10-09 — repository structure and documentation pass.
- 2026-10-07 — mobile adaptation for the frontend; CI Docker build, test
  dependencies and lint fixed.
- 2026-10-06 — backend deployed to Railway; `PORT` handled by the app, Dockerfile
  adopted for auto-detection, frontend pointed at the live backend.
- 2026-10-05 — localhost URLs hidden from production error messages.
