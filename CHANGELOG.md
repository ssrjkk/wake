# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There have been no tagged releases yet. Everything below `Unreleased` is dated
from the commit history rather than from a release.

## [Unreleased]

### Added

- Telegram widget tests for missing configuration, StrictMode, callback updates
  and cleanup; browser tests for focus, Escape, reduced motion, all tabs, mobile
  overflow, Arcus network selection and Predict quote confirmation.
- Frontend dependency auditing in CI and Docker builds on pull requests, with
  migration discovery checked inside the image.
- The price card carries the 24h high/low and a one-line sparkline of hourly
  closes, derived by `lighter_rest.stats_from_candles` — the same arithmetic
  `get_24h_stats` uses, so the bot needs one candle request, not two.
- Tests for the bot's presentation and wiring: HTML escaping of curator- and
  user-supplied text, ticker parsing, block-char sparkline, keyboard contents
  with an http and an https Mini App address, the command menu against the
  handlers that answer it, and payload builders on fixtures shaped like live
  Lighter responses.
- `npm run build` refuses to produce a deployable bundle whose
  `VITE_BACKEND_URL` points at localhost; the dev server is unaffected. The Pages
  project has no build configuration, so the `.env` on the building machine is
  the only thing that decides where a live site sends its requests — and it had
  just shipped `http://localhost:8000` to production.
- `SECURITY.md` documents the bot's own trust boundary: no write path, escaped
  output, validated `callback_data`, and the https rule for the web-app button.

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

- The Telegram bot answers in HTML cards instead of plain lines: numbers sit in a
  monospace block so the volume columns line up, market and funding lists carry
  the tickers as buttons, a bare ticker typed in chat is the same as `/price`, and
  the command menu is registered with Telegram at startup instead of being left
  empty. `/funding` is computed in the bot's own process by
  `funding_arb.funding_rate_rows` — the function whose output `GET /funding/rates`
  returns — so the bot and the page cannot show different annualised numbers, and
  the command works with the backend down. `/predict` still needs the backend
  (the markets live in its database) and now says so, naming `WAKE_BACKEND_URL`,
  instead of returning an empty list.
- `GET /funding/rates` builds its rows through that same shared function instead
  of shaping them inside the router.

- Visual system rebuilt around one rule: flat surfaces with hairlines, a single
  accent for identity and selection, green/red reserved for trade direction.
  Glows, gradient panels, backdrop blur, pulsing dots and scale-in animations are
  gone; `--text-*`/`--bg-*` aliases remain for components not yet migrated.
- The Terminal is a trading desk now: the market row carries symbol, last price,
  24h change, high/low/volume and funding; the candle chart has an explicit height
  so its axis can no longer sit on the trade tape; the order ticket shows margin
  and liquidation before confirmation; and the market list carries a real last
  price and 24h change per row, formatted with that market's own price decimals.
- The "backend unavailable" notice is one line with the explanation behind
  `Почему так`, instead of a panel that occupied the top third of the screen.
- The Terminal chart stops lying about its own axis: the time labels are three
  instead of four (four centred labels did not fit the ~250px plot on a 390px
  screen and touched each other), and the left margin grew to 42px so the first
  label is no longer cut to "1.10 01:00".
- One animation instead of three names for it: `--animate-scale-in` and
  `--animate-slide-up` were aliases of the same 160 ms fade, and one of them had
  no rule behind it at all. Everything that animates on entry now uses
  `animate-fade-in`.

- Frontend dependencies use supported ESLint 10, React Hooks lint rules 7,
  Recharts 3 and TypeScript 6. TypeScript 7 is not compatible with the current
  type-aware lint API; those checks remain enabled. The signing SDK minimum is
  1.1.8, and frontend dependency versions are recorded in the lockfile.
- Backend auditing excludes only the reviewed advisory IDs in `SECURITY.md`,
  not the entire urllib3 package; audit execution errors fail the job.
- Playwright uses explicit empty login settings and its own server so local
  environment files cannot skip tests or change the sign-in scenario.

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

- `base_asset` normalises dash- and dot-separated spellings ("BTC-USDC",
  "BTC.PERP") instead of leaving a trailing separator that matched nothing: the
  quote suffix was stripped but the "-" was not, so `/funding/venues` and any
  ticker typed that way answered "нет ставок funding по символу BTC-" while the
  same market was readable as "BTC".
- `docker-compose.yml` sets `WAKE_BACKEND_URL=http://app:8000` for backend
  services. The bot inherited the code default `http://localhost:8000`, which
  inside its own container is the bot, so `/predict` answered "backend
  unavailable" against a healthy API.
- Modal dialogs choose their own initial focus: the first visible control, or the
  element marked `data-autofocus`. The browser default was the panel itself,
  because a modal body is a scroll container (`max-h` + `overflow-y-auto`) and
  Chromium makes scroll containers focusable — so as soon as a dialog's content
  got tall enough to scroll, keyboard users started inside the wrapper instead of
  on the first control. The focus trap and the initial focus now share one
  `focusables()` helper instead of duplicating the selector.
- The sign-in panel's "Telegram login is off" message uses `.notice` instead of a
  hand-styled div with literal colours.
- The Mini App button is dropped when `WAKE_MINIAPP_URL` is not https. Telegram
  rejects a `web_app` button with an http URL as an invalid *message*, so with
  the documented local default every reply that carried the keyboard failed with
  400.
- Documentation checked against the running system, line by line, and corrected:
  the Pages section claimed a Cloudflare build command, an output directory and a
  Node version, while the project is not connected to Git and carries no build
  configuration or environment variables — `VITE_*` come from the `.env` of the
  machine that runs the build, which is what put the wrong bot handle into
  production. `backend/.env.example` offered `LIGHTER_BASE_URL`/`LIGHTER_WS_URL`
  as overrides no code reads, described the curator answer as 401 instead of 403,
  and named a `_require_curator` that lives in `api/guards.py`; the root
  `.env.example` said a build without `.env` aims at a local backend when
  `src/lib/config.ts` falls back to the deployed Railway URL. Test counts
  (296 → 333 backend, 62/8 → 99/11 frontend), the `docker-build` trigger list and
  the claim that `config.py` validates *every* variable were stale.

- Alembic accepts percent-encoded database passwords instead of interpreting
  their escapes as INI substitutions before opening a connection.
- Muted labels use shared, higher-contrast text tokens; the NO purchase button
  uses dark text on red instead of low-contrast small white text.
- Modal dialogs keep keyboard focus inside, restore it on close, expose labels
  and remain scrollable on mobile. Escape works while editing market search;
  notifications remain accessible inside the modal layer.
- Late API responses no longer replace the active market/account's state after
  switching; recovered candle, trade and Arcus requests clear their old errors.
- Arcus follows the mainnet/testnet selector. Its overview labels market types
  from the API rather than calling every market a zero-fee stock spot token.
- Predict quotations and confirmation are tied to the current outcome, share
  count and price, so editing the order cannot reuse an earlier confirmation.
- The Terminal cannot submit again while the signing-service request is pending;
  its loaded chart and dry-run response are covered by a browser regression test.
- Generated test reports do not reload the dev server, and icon dependencies are
  no longer grouped into the React runtime chunk by an overly broad name match.
- The frontend checks `/ready` as well as `/health`; a live process with failed
  database or Redis checks is not presented as an available backend.
- Backend transport errors preserve their original cause. Russian bot links and
  test documentation match their English counterparts; empty screenshot sections
  no longer present unfinished work as content.

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
