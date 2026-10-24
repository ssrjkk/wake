# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There have been no tagged releases yet. Everything below `Unreleased` is dated
from the commit history rather than from a release.

## [Unreleased]

### Added
- `leaders.active` (migration `004_leader_active`), `PATCH /leaders/{id}/active`
  and `GET /leaders/mine`, plus the "Публиковать мои сделки" switch in the
  Terminal. The switch existed as three user-facing instructions and zero
  controls: `Terminal.tsx` declared `isCopyable`/`toggleCopyable` in its props
  and never destructured them, and the only "off" was a `useState` reset — the
  leader row stayed live, `active_follows_for_leader()` kept returning his
  followers, and the engine went on trading other people's accounts. Publication
  is now server state, read back on every session so a reload cannot disagree
  with the engine.
- `probeSigner()` in the Terminal: the order path signs in a local
  `signing_service.py`, and the button used to be enabled regardless of whether
  that process is reachable from this origin. A chip now reads
  "подписание: не проверялось / проверяю… / отвечает / недоступно", is asked on
  click and again before each confirmation — not on mount, because a public page
  probing localhost is both a red console error the user never asked for and a
  request Chrome's Private Network Access cuts short anyway — and the failure
  toast no longer prints a bare `localhost:8787` at a production user.
- `MARKETS_TABS` in `App.tsx`: the Lighter book was refetched every 15 s for the
  whole life of the page, including on Overview/Discover/Earn/Predict where no
  component reads it and including while the window was hidden. It now polls only
  for the five tabs that consume it and only while the document is visible, and
  the backend probe exists in one function instead of two copies.
- `openInterestUsd()` in `src/lib/lighter.ts` and `unhedged_vol_usd` in the
  `HedgeSuggestion` type: the backend has been sending the unhedged baseline all
  along, and without it "resulting volatility $800" reads as nothing.
- `failure_card()` / `safe_payload()` in `backend/telegram_bot.py` and handler
  tests on `Message`/`CallbackQuery` doubles: `/markets`, `/funding` and `/price`
  previously let `lighter_rest` exceptions escape into aiogram, so a Lighter
  outage made the bot silent — indistinguishable from "no such market". The
  callback is now acknowledged before the data is fetched, because a multi-second
  fetch past Telegram's window answers `query is too old` and sends nothing.
- Backend tests for the publication lifecycle (5 in `test_db.py`, one HTTP cycle
  in `test_api_smoke.py` including the simulate-mirror proof that an inactive
  leader plans no orders); frontend tests for `/leaders/mine`, the active switch,
  `openInterestUsd`, market categories against live symbol forms, and the avatar
  palette; two browser tests for the switch and the signing chip (420 backend,
  122 unit, 18 browser).
- `min={0}`/`valueAsNumber` on the remaining numeric inputs (copy allocation,
  carry capital) and a single in-flight guard on the Predict claim button, whose
  second click used to return "already claimed" where the user expected his money.
- `snapshot()` helper in the position-tracker tests: the findings that matter
  here are about a snapshot containing some markets and not others, which a
  one-position builder cannot express.

- `backend/quant.py`: one rounding implementation for the whole backend. There
  were two private `_round_down` functions, and the arithmetic in
  `funding_arb.py` cut 0.29 of a coin to 0.28 because `int(0.29 * 100)` is
  `int(28.999999999999996)` — measured, not theorised. `round_down` (order size,
  never up) and `scale_to_int` (price in market ticks, nearest tick) are Decimal
  based now and shared by the funding calculator, the copy engine and the agent
  runner.
- `lighter_rest.get_price_at(market_id, when_s)`: the close of the minute that
  contained a given moment, read from historical candles. Price markets resolve
  on this instead of "the price right now", so a resolver that woke up a week
  late cannot settle "BTC above 100k on 1 October" with October's price.
- `GET /leaders/{id}/followers` — the leader's own console over follower rows,
  gated on ownership of the leader. `GET /follows/by-leader/{id}` stays public
  but returns aggregates only.
- Tests for the copy engine's order payload (all four side/reduce combinations,
  tick scaling, index uniqueness), for `quant`, for `net.client_ip` proxy chains,
  for portfolio data garbage (zero closes, NaN, unequal series, missing market),
  and a source-hygiene test that fails when characters from CJK scripts appear in
  the repository — that happened three times in Russian text and no review caught
  it.


- Screens in both READMEs, captured from this build against live data: the
  Terminal, Overview and Funding at 1440 px, the Terminal and Overview at 390 px,
  and the Telegram bot's cards rendered from the HTML `telegram_bot.py` actually
  sends. Panels that need the Wake backend are shown in their honest
  "backend unavailable" state rather than with invented numbers.
- `/spread SYMBOL` in the bot: the same asset's funding across every venue
  Lighter reports, through `funding_arb.venue_rate_rows` — the parser behind
  `GET /funding/venues`, extracted so the endpoint and the bot cannot disagree.
  It prints rates, not a spread: the venues pay on different epochs.
- The bot's market list paginates (`ещё →` / `← назад`), and the rank numbers
  continue across pages instead of restarting.
- The bot's "Open Wake" button deep-links: `?tab=terminal&asset=BTC` from a price
  card, `?tab=funding` and `?tab=predict` from those answers. `src/lib/deeplink.ts`
  validates the tab against the shell's own list and the ticker against a profile,
  so a hand-edited link cannot select an unknown view.
- A line-width test for the bot's numeric reports: Telegram renders `<pre>`
  monospaced and does not wrap, so a line longer than the bubble is clipped
  without warning.

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
- `WAKE_SESSION_TTL_DAYS` defaults to 7, and 30 is now the ceiling. The token has
  no revocation list and never will — `session.py` says the short lifetime is
  what makes that acceptable, and 30 days did not match the claim. Re-login is a
  wallet signature or a Telegram tap.
- Resolving a price market is anchored in time: the resolver and the curator's
  manual trigger both ask for the price at the market's `resolve_at`, not at the
  moment they happen to run, and both write a `market_resolution` audit row. The
  manual trigger answers the price it used and when it was taken from.
- `GET /funding/rates` ranks by who pays first rather than by absolute rate, and
  `funding_annualized` / `annualized` in the REST answers come from
  `funding_arb.annualized_yield` instead of a second copy of `× 24 × 365` in the
  routers — one formula per project, so the page and the bot cannot drift.
- Unfollowing no longer removes the `follows` row. Rows with `deleted_at` are
  excluded from every list, from the public AUM and from what the mirror engine
  will act on; the journal of what already happened stays attached to them.
- `/agent/step` body is `{market_id, resolution, candles, base_size_usd}`:
  `recent_prices`, `size_decimals` and `price_decimals` are no longer accepted
  from the caller. The answer carries `data` — symbol, resolution, number of
  candles, last price and network — so a decision can be checked against the same
  window the panel shows.
- The Funding table labels each venue column as a rate per that venue's epoch and
  states that epochs differ (Lighter's is one hour, confirmed from the live API);
  previously Binance and Bybit numbers sat next to an hourly rate with no unit,
  which invited exactly one wrong conclusion.


- The market row of the Terminal became an instrument instead of a header: a grid
  with named areas (symbol, quote, stats, tape) rather than a flex-wrap that
  dropped the numbers wherever there was room. The quote is set in a display
  mono — Azeret Mono 700, tabular, tight-tracked — used only for the big number
  and the wordmark; tables and labels keep JetBrains Mono and Inter.
- New signature element: the hourly tick tape. One bar per candle of the same 48
  candles the chart already uses (no extra requests), height is the hour's range
  relative to the largest in the window on a 0.7 power, colour is that hour's
  direction, and the forming hour is capped in the accent. It answers "how did
  the day move" before you read a single number, and it is exposed to screen
  readers as one labelled image.
- Motion now marks data change, not page furniture: the quote flashes green/red
  when the price actually ticks, the chart wipes in left-to-right once per market
  switch, a new trade slides into the tape, the active tab's underline draws
  itself, and each market row carries a 2px liquidity rank along its bottom edge.
  All of it is switched off by `prefers-reduced-motion`, which the browser suite
  asserts.
- Playwright runs one worker locally too. On an 8 GB machine where several
  browser agents work at once, four chromiums plus the dev server starved
  navigation past the 30 s timeout and the whole suite failed on "not visible";
  serially the same 14 tests finish in about twenty seconds.

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
- The Terminal's market rail reshuffled on every poll. `/orderBooks` returns the
  same 214 active perps in a different order each call (measured on mainnet
  2026-10-24: three consecutive requests put BTC at index 14, 207 and 58), and
  the rail was "first 12 rows of the response" — so the row being watched moved
  out from under the cursor, and the market actually open on the desk was often
  not in the list at all. The rail is ordered by `market_id` now, and the
  selected market is pinned into the visible slice when it falls outside it.
- The Terminal's price change was computed over all 48 hourly candles and
  labelled "/ 24ч" — a two-day move presented as a daily one, with the up/down
  colour derived from it. It now uses the same last-24 window as the high/low and
  turnover rows and prints the number of hours actually covered.
- `avatarColor()` returned Tailwind class names. `App.tsx` put them in
  `className` (worked), `Portfolio.tsx` and `Earn.tsx` put them in
  `style={{ background }}` (browser discarded the value, so the avatars were
  transparent circles), and `Discover.tsx` used a hard-coded blue instead — three
  renderings of the same trader. It returns a hex colour now and all four sites
  use it.
- `Discover` ranked leaders by `... || b.aumUsd - b.aumUsd`: always zero, so the
  documented AUM tie-break never fired. Comparison is against the backend
  contract now, and the panel reports when the list could not be loaded instead
  of printing "no leaders yet" over a dead backend.
- `OrderBook.open_interest_usd` was typed `number` while the live `/orderBooks`
  returns the string `"9920884.729544"`. The hedge candidate pool only worked
  because `<` and `-` coerce strings; it is typed `string` and parsed explicitly.
- `Portfolio` indexed `STATUS_STYLE[r.status]` with no fallback: `mirror_log.status`
  is a plain `String` column, and a status the frontend does not know crashed the
  whole panel — the panel that exists to show what the engine did to a person's
  money.
- A failed `GET /follows` produced an empty subscription list, which reads as "you
  copy nobody" and invites a duplicate follow. The error is surfaced as its own
  strip now.
- `Risk`'s "Найти хедж" silently hedged `riskPositions[0]`, and the result card
  showed only the resulting volatility. The target is selectable and named in the
  card, which now shows baseline → hedged, and the market picker has a search box
  instead of the first 60 rows of the book.
- Four inline styles declared `marginTop`/`marginBottom` and then `margin: 0` in
  the same object — the later key won, so the reason/error/tx lines in Agent and
  the hedge line in Risk sat flush against the text above them.
- `README` and `Discover`/`Earn` copy about the fee: `fee_bps` is per copied
  trade, applied to turnover in the projection, and nothing charges it yet —
  "б.п. от профита" described a performance fee that does not exist in the code.
- A leader whose position **leaves the snapshot** produced no event at all.
  `leader_position_tracker.apply_position_update()` compared only the markets
  present in `msg["positions"]`, so if Lighter drops a flattened position from
  the channel instead of sending it with size 0, the copy engine never learned
  about the exit and the follower stayed in a market the leader had left — with
  no further event ever coming. The tracker now reconciles: absent market =
  full close at the last known price, and the entry is dropped from state so the
  next appearance counts as an open rather than a second close. Zero-size rows
  are handled too, and close exactly once.
- `signing_service._idempotency_cache` grew forever. The TTL was checked when an
  index was read and nothing ever removed an entry, so the process holding the
  signing key accumulated one record per order for its whole life. Expired
  entries are dropped on write and the map has a ceiling.
- Numbers from an LLM answer entered the money path unchecked:
  `float(parsed.get("size_usd", 0))` accepted NaN and inf, and `check_order()`
  cannot stop them because *every* comparison with NaN is False — the result was
  `allowed=True` with a NaN size, which then died in JSON serialisation
  (Starlette writes with `allow_nan=False`) as a 500 on `/agent/step`. Values are
  clamped at parse time, and `risk_limits.check_order()`/`record_executed()`
  gained the same guard, because a NaN that reaches the counters poisons them for
  the rest of the day: afterwards no order can pass and none can be closed.
- `get_market_overview()` sized its thread pool by the number of markets
  (`max_workers=len(known)`), with a blocking `urllib` call plus retries in each
  worker — several simultaneous `/markets/overview` requests multiplied threads
  and sockets. The pool is capped.
- When the signing service refused an order, the agent reported
  `HTTP Error 400: Bad Request` and threw away the response body, which is the
  only thing naming the reason (margin, tick size, price band). The reason is now
  carried into the failure result and the log.
- The Terminal's shares field and every number formatter handled NaN as if it
  were data: `Math.max(0, Number("1e"))` is NaN, `NaN <= 0` is False, so the
  trade button stayed enabled and the table printed "NaN" and "-$NaN" in columns
  where a real figure is expected. Inputs read `valueAsNumber`, formatters print
  an em dash for anything non-finite.
- `priority_execution` was listed as the Pro-only feature and asserted by a test
  — while no endpoint, panel or scheduler read it anywhere. Removed; the tier
  tables now state what is actually enforced, and the test says out loud that
  Pro and the trial grant the same rights and differ only in duration.
- `agent_memory.recent_trades()` sorted the entire history for every agent step
  to show ten rows. Trades arrive from PostgreSQL ordered by `opened_at` and
  `record_open` appends, so the tail *is* the recency window; it is sliced now.

- Copy-trading execution, three faults that each cost money on their own.
  `leader_listener.py` sent `price=int(event.price)` un-scaled by the market's
  `supported_price_decimals` (live check: all 246 order-book rows carry the
  field) — a DOGE order left at price 0, a BTC order with a limit two orders of
  magnitude below the market, so IOC buys never filled. Closing a position sent
  the position's own side instead of the opposite one, so closing a long was a
  buy: the follower's position stayed open while the engine's belief in its size
  moved anyway. And `current_mirrored_size` was updated whether Lighter accepted
  the order or rejected it, so one rejection desynchronised the tracked position
  from the account for good. `test_leader_listener.py` pins all three.
- The mirror listener died on any single bad event — one malformed WebSocket
  message, one failed order, one dropped connection and the process was gone,
  silently, while followers believed copy trading was running. Handling is
  isolated per event and the stream reconnects with capped backoff.
- `predict_amm.LMSRMarket.price_yes()` raised `OverflowError` when the NO side
  was heavy (`math.exp(1000)`), which took down `GET /predict/markets` because
  the price is computed for every row of the list. The stable form handled one
  direction; both are handled now.
- `DELETE /follows/{id}` answered 500 for anyone the engine had ever mirrored:
  `mirror_log.follow_id` has no ON DELETE rule, so the foreign key blocked the
  delete. Unfollowing sets `deleted_at` (revision `003_follow_tombstone_unique`)
  and keeps the journal, which is the only answer to "what did the engine do with
  my money".
- Audit writes can no longer fail a request that already moved money.
  `audit_log.log_action` ran after `record_trade` committed, so a database
  hiccup produced a 500 on a successful trade and a client that retried got a
  second one. A failed audit row now surfaces at ERROR level with the event
  serialised, and the response stays the truth.
- `session.verify()` answered 401 when `WAKE_SESSION_SECRET` was missing — the
  same config fault `issue()` reports as 503 — pushing clients into a re-login
  loop that cannot succeed. A token whose signature part contains non-ASCII
  characters crashed it with `TypeError` from `hmac.compare_digest` (500); the
  ASCII check is explicit.
- `/agent/step` decided, priced and applied risk limits from `recent_prices`
  supplied by the caller, with `price_decimals` defaulting to 0. The endpoint
  fetches candles and market constraints from Lighter now and reports the window
  it used. Related: the agent's position limits counted `dry_run` trades as
  positions, so a series of simulations could block the first real order with
  "position limit reached" for positions that do not exist.
- `client_order_index` came from the clock in both execution paths
  (`time_ms % 1e6`, `Date.now() % 1e6`). It repeats every ~16.7 minutes and
  collides within one millisecond; the signing service remembers an index for an
  hour and answers a collision with the previous tx_hash without placing the
  order — a success response for an order that never existed. Indexes derive from
  the trade's own UUID now, and the browser path uses `crypto.getRandomValues`.
- Rate limiting charged `/health` and `/ready`. Behind a proxy every orchestrator
  probe lands in one bucket, so the health checker could exhaust it, get 429 on
  `/ready` and cause restart loops with no code at fault. Probes and CORS
  preflights are excluded, and `X-Curator-Token` is in `allow_headers` — the
  operator endpoints require it, and preflight blocked any browser caller.
- `portfolio_risk`: `price_returns` divided by a zero close (a real shape for an
  illiquid hourly candle), and NaN travelled through `max(0.0, variance)` into a
  diversification score of exactly 1.0 — "fully hedged" read out of garbage.
  Unequal-length series raised a message no user could act on; correlation now
  compares the common tail, and a hedge candidate that does not lower risk is not
  offered at all. Answers carry the unhedged volume so "after" can be read.
- `lighter_rest._get` retried 4xx three times with sleeps, so a forbidden or
  missing endpoint cost 3.5 seconds and extra quota on every call; only network
  faults and 5xx retry now. `get_funding_rate` raised on a non-numeric
  `market_id` in any row, one bad row breaking the whole page, and one market
  without candles took the entire `/markets/overview` down instead of landing in
  `no_data`.
- `base_asset("BTC -USDC")` kept a trailing space, and that function is the
  matching key between venues — a symbol with stray whitespace silently found no
  rates. Funding ranking changed from absolute value to "who actually pays
  first": by magnitude the list opened with a market where shorts pay, which
  cash-and-carry cannot be built on without a borrow. Zero-rate markets report
  `direction: "none"` rather than claiming shorts pay (109 of 735 live rows).
- `POST /follows` accepted a leader following himself, which is how
  `total_aum_usd` — the number Discover ranks on — becomes self-printed money;
  and `side` in `/simulate-mirror` treated anything not exactly `"long"` as a
  short, so an operator reviewing a typo saw a plan for the other direction.
  Money fields on the funding, portfolio and mirror endpoints now reject NaN and
  infinity at the boundary: they used to reach the response, and Starlette
  refuses to serialise Infinity, so the answer was a 500.
- Telegram widget login: a profile name containing a newline could shift the
  field boundaries of the string being verified, and a missing bot token answered
  401 where the Mini App path uses 503. Two concurrent first logins of one
  account hit the UNIQUE on `l1_address` and returned 500; the insert runs inside
  a savepoint now.
- The Terminal refused valid leveraged orders: the balance check compared the
  order notional to equity while the row above it displayed margin as
  notional/leverage, so $3000 at 5x on a $1000 account was rejected as too big.
  The browser's own order path had the same float truncation as the backend
  (`Math.floor(0.29 * 100)` = 28) and no minimum-order check, so a too-small
  order produced the exchange's error text instead of the market's own minimum.
- Emptying a numeric field in the Funding threshold or the Risk basket produced
  `NaN` from `Number("")`-style parsing: the funding table silently emptied, and
  NaN travelled into the risk calculation. Both read `valueAsNumber` and fall
  back to a usable value; the Funding refresh button also clears a stale error
  banner it had previously kept next to freshly loaded numbers.


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
  (296 → 350 backend, 62/8 → 104/12 frontend), the `docker-build` trigger list and
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
