# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

There have been no tagged releases yet. Everything below `Unreleased` is dated
from the commit history rather than from a release.

## [Unreleased]

### Added
- `GET /audit` — the audit trail finally has a reader. `audit_log.py` had two
  read functions and nothing called either, so the deploy guide could only tell
  the operator to go look at the database; now the newest events come back over
  HTTP behind the same curator token as the other operator endpoints, with
  `actor`/`action`/`failed_only`/`since` filters, `details` decoded into an
  object, and one ceiling (`audit_log.MAX_ROWS`, 500 rows) shared by the layer
  and the route.
- `backend/test_order_example.py` — the manual order script is now tested as the
  operator runs it: a subprocess per environment, because every check lives at
  module import.
- `test_api_smoke.py::TestFailureResponseContract` — pins the middleware stack
  order and asserts that 429, 500 and the `ValueError`-to-400 conversion all
  arrive with `Access-Control-Allow-Origin`, `X-Content-Type-Options` and the CSP
  intact.
- `WAKE_LOG_LEVEL` is validated against the names `logging` actually has.
- A CI step that asks `pip` to resolve `urllib3>=2.1.0` together with
  `lighter-sdk>=1.1.8`. Today the resolution is impossible — that is the whole
  reason the urllib3 advisories stay ignored — and the step fails on the first
  day it becomes possible, naming the ignore list and the SECURITY.md section to
  delete. Checked against PyPI on 2026-10-25: 1.1.8 (2026-10-19) is still the
  newest release and still requires `urllib3<2.1.0`.
- `src/components/theme.gate.test.ts` — the rule that lived only as a comment in
  `index.css` («no gradients, no blur: this is an instrument panel») is now a
  test. It reads every panel and fails on a gradient, a shadow or a blur in
  component code, on a colour literal outside the token palette, and — the other
  way round — on a legacy literal that the code has already outgrown, so the
  allow-list can only shrink. Checked by mutation: a `linear-gradient` and a new
  hex in `Risk.tsx` both turn it red.
- Theme primitives that panels were each inventing by hand: `.menu-card`,
  `.overlay-shell`, `.field-box`, `.row-button`, `.btn-secondary`,
  `.btn-accent`, `.btn-danger`, `.btn-up` / `.btn-down`, `.market-card`,
  `.skeleton`, `.panel-error`, `.range`, and toast variants through
  `data-variant` instead of an inline border colour.
- Telegram bot: `/help` is laid out by section (Рынки / Funding / Predict /
  Интерфейс) with the descriptions still taken from `BOT_COMMANDS`; a shorter
  command menu is registered for groups (`BotCommandScopeAllGroupChats`) —
  seven autocomplete lines in a chat where the bot was summoned once is noise;
  the markets and funding cards carry a text link to their section beside the
  web-app button.

- Telegram Mini App window integration in `src/lib/telegram.ts`. The page now
  tells Telegram it is ready (`ready()`), expands itself to full height
  (`expand()`), paints the window header and background from the theme tokens,
  copies the safe-area insets Telegram reports into `--tg-safe-*` CSS variables,
  binds the header back arrow to the stack of open panels and gives haptic
  feedback under the outcome of an order, a subscription or a sign-in. Before
  this the module read only `initData`: inside Telegram the app opened as a
  half-height webview with a light header over a dark terminal, and the home
  indicator lay across the order panel.
- `src/lib/layers.ts` — the stack of open panels. `Modal` registers itself while
  mounted, so `closeTopLayer()` answers "what does back close" for a panel the
  shell knows nothing about: the order confirmation lives in the Terminal, the
  Predict ticket lives in Predict, and neither is reachable from `App.tsx`.
- `src/lib/tabs.ts` — one list of the nine sections: it draws the navigation,
  numbers the Alt+1…Alt+9 shortcuts and defines which `?tab=` values an external
  link may carry. The shortcut map and the deeplink whitelist were separate
  copies of it and drifted silently.
- Bottom tab bar on narrow screens and inside the Mini App: the same `<nav>`
  element, repositioned by CSS, with an icon per section, the active section
  scrolled into view and content padded above it. Nine captions in a strip under
  the header used to scroll away on the first swipe.
- `public/favicon.svg`, `public/og.png`, `public/apple-touch-icon.png` and
  `scripts/brand-assets.mjs`, which renders the two rasters from the same markup
  with the Playwright Chromium already used by e2e. The site had no icon at all
  (every tab asked Pages for `/favicon.ico` and got the SPA back) and no
  `og:image`, so a link shared in Telegram rendered as a bare URL. The preview
  card carries no invented numbers.
- `?tab=predict&market=<uuid>`: a Predict market opens where the bot's card
  pointed — scrolled into view, ringed and labelled "из ссылки" — and the filter
  switches to "Все" when the market behind the link is already resolved, because
  "no markets" would be a lie about a market that exists.
- Telegram bot surface: `/start` is a welcome with the eight most liquid markets
  as buttons instead of a second copy of `/help`; the bot's name and both
  descriptions are written at startup (`set_my_name`,
  `set_my_short_description`, `set_my_description`); `/predict` lists markets as
  buttons and answers with a card of one market — state, YES/NO in cents, the
  threshold and the Lighter market behind it, time left, volume, the LMSR pool
  with its subsidy and the curator's evidence link; every card repeats its
  section as a plain text link, which survives the http address where Telegram
  rejects a `web_app` button.

- `backend/test_agent_execution.py`, `backend/test_lighter_rest.py`,
  `backend/test_key_store.py` (61 checks): the three modules that carried a
  «не тестировалось мной» note in their own headers are now tested. The agent
  suite drives the real HTTP path with `urlopen` substituted, so the payload
  sent to the signing service is asserted as market-scaled integers
  (`base_amount=97`, `price=10_300_000` for $100 of BTC at 103 000 with 5/2
  decimals), and each of the three submission outcomes — `sent`, `failed`,
  `unknown` — has its own case. The Lighter client suite pins URL construction,
  which statuses repeat and which do not, and what a candle must contain to be
  used at all. The keystore suite pins the atomic write, the missing file, the
  wrong master key and the listener's boundary.
- `usable_candles()` in `backend/lighter_rest.py` and `_json_safe()` in
  `backend/app.py` — two boundaries that did not exist before. The first drops
  candle rows whose `o/h/l/c/V` are not finite positive numbers, because one
  such row is enough to make the whole public market overview fail to
  serialize. The second sanitizes validation-error details: a rejected `NaN`
  produced a 422 whose own body could not be serialized, which turned every
  `allow_inf_nan=False` refusal into a 500.
- `unknown` as a distinct execution status for the agent, styled and explained in
  the Agent panel: a submission whose response was lost is neither a fill nor a
  rejection. The panel shows the `client_order_index` so the order can be found
  in Lighter instead of being re-issued.
- `backend/test_properties.py`: 27 seeded property checks over the money math,
  complementing the example-based suites rather than repeating them — they test
  the inequalities a single case cannot. `round_down` never grows a magnitude and
  always lands on the market grid; `scale_to_int` is within half a tick, measured
  in `Decimal` so float noise cannot hide a miss; every `compute_mirror_plan`
  answer accounts for each follower exactly once and any order it emits is
  finite, on the grid, not below `min_base_amount`, inside both the allocation
  share and the margin ceiling, and a mirrored close is never larger than the
  follower's own position; the LMSR market's liability `q·p − C(q)` never exceeds
  the declared `b·ln2` reserve and prices sum to exactly 1.0; portfolio variance
  obeys the triangle inequality, `diversification_score` stays in `[0, 1]`, and
  the *sign* of a negative correlation is pinned (opposite series must cancel the
  exposure, and an anticorrelated hedge must be opened in the same direction as
  the position); both cash-and-carry legs stay inside the capital. Randomised
  with `random.Random(seed)` per check, not hypothesis: a failure reproduces with
  the same numbers, and no new dependency enters the image.
- `src/lib/net.ts`: every external request now carries a timeout — 10 s for the
  public REST (Lighter, Arcus), 15 s for the Wake backend, and a `TimeoutError`
  is turned into "нет ответа за 10 с" instead of a DOMException in a toast.
  Before this, nine GET calls had no signal at all: one TCP connection that was
  accepted but never answered left the panel on "загружаю…" for the lifetime of
  the tab, while the 15–60 s poll intervals stacked new requests on top of it.
  `POST /place-order` deliberately keeps no timeout — aborting a request that
  may already have reached the exchange invites a retry with a new
  `client_order_index`, i.e. a second order; the disabled button is what
  prevents the duplicate there.
- `isArcusOnline()` in `src/lib/arcus.ts`, next to the `isArcusPerp()` it
  belongs with, and a test that pins the live value set (`ONLINE`/`OFFLINE`) so
  a future rename fails loudly instead of greying out the whole table.
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
  138 unit, 18 browser).
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
### Changed
- The browser build is silent. `vite build` used to print, on every run, that
  `ox/_esm/tempo/internal/virtualMasterPool.js` imports `node:worker_threads`
  and that the module was externalized for browser compatibility. The tempo
  branch is pulled in by wagmi's barrel and cut by tree-shaking before it ever
  reaches a chunk, so the noise described a module the client never loads — but
  a warning that is always there trains nobody to read it. `vite.config.ts` now
  swallows exactly that one message, matched on the importer's path (a
  `node:`-import from anywhere else still prints), and the comment records why
  the match cannot be widened into a post-build check: in Vite 8 an
  externalized node module leaves no specifier string, no chunk import and no
  module entry behind, so nothing in `dist` can be asserted about it. Verified
  both ways — clean build prints nothing, a deliberate `node:worker_threads`
  import in `src/main.tsx` prints again.
- `viem` moved to 2.57.11 (newest patch of the declared range).
- Predict and Dashboard stopped painting `linear-gradient` panels with drop
  shadows: both now use the surfaces, borders and typographic scale declared in
  `index.css`, and the Predict filters became the same segmented control the
  network switch uses. `App.tsx` no longer contains a single colour literal —
  the sign-in window, the market picker, the copy card and the profile menu are
  classes now.
- Documentation screenshots re-captured from this build (2026-10-25): the panel
  shots, the mobile terminal and the bot cards.

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
- `audit_log.failed_actions_since()` — unread by the application, unbounded, and
  unable to filter by actor or action. `recent_actions()` grew those two filters
  and the row ceiling, so one reader covers both cases.
- `@app.exception_handler(Exception)` from `app.py`, replaced by the error
  envelope middleware (see Fixed) — the handler was outside the layers that sign
  a response, which no handler inside FastAPI can fix.

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
- Refusals reached the browser unsigned. Starlette inserts each middleware at
  position 0, so the layer registered last is the outermost, and the rate
  limiter had been registered last: its 429 — and every 500 and `ValueError`
  400, which FastAPI renders in `ServerErrorMiddleware`, outside our stack —
  left without `Access-Control-Allow-Origin`, so the browser withheld the
  response from JavaScript entirely. "Too many requests, retry in 6 seconds"
  looked exactly like "the backend is down", which is the state the frontend
  reports when it cannot read a code. The stack is now built CORS → security
  headers → error envelope → rate limiter, `Retry-After` is in
  `expose_headers`, and the untyped error handler moved inside it.
- `place_order_example.py` put a real order on mainnet from one variable.
  `WAKE_LIGHTER_NETWORK=mainnet` is both the config default and the production
  value, and the script never read `WAKE_DRY_RUN`, so an operator following the
  README with the production env file sent a live order with no confirmation. It
  now requires `WAKE_MAINNET_LIVE` as well — the same pair of switches the rest
  of the product refuses to start on without. Its environment parsing also
  stopped crashing: `WAKE_ORDER_SIZE_USD=nan` used to reach `math.floor`,
  `WAKE_ORDER_SIDE=SELL` used to mean *buy* rather than a refusal, and
  `client_order_index` used the wall clock, which collides inside a second and
  would be swallowed as a duplicate by the signing service's idempotency cache.
- Portfolio risk could report "zero risk" for input that has no answer.
  Correlations were computed pairwise over each pair's own tail, which does not
  have to produce a positive-semidefinite matrix, and `max(0.0, variance)` then
  hid the negative under a zero; a series of `1e154`-sized values went further
  and made the variance `inf - inf = nan`, which `max(0.0, nan)` also reads as
  `0.0`. The basket is now aligned to one common window before the matrix is
  built, the response bounds the magnitude of a return series (`1e300` used to
  be an `OverflowError`, i.e. a 500), and anything still non-finite is refused
  by name instead of being rounded to a comfortable number.
- `audit_log.log_action` promised that a failed write never becomes a 500 on a
  completed money action, and kept that promise only for the database:
  `json.dumps(details)` sat *before* the `try`, so a `Decimal` — the natural
  type for money in the SQLAlchemy models — threw straight through. Serialising
  now happens inside the guard, with `default=str` so the event still reaches
  the table, and the fallback log line itself cannot fail (`_event_line` prints
  a circular `details` with `repr` instead of raising while describing the
  raise).
- A corrupted rate-limit bucket was diagnosed as "Redis unavailable". The
  limiter read `tokens`/`last_refill` with a bare `float()` inside
  `except Exception`, so a bad field meant an unlimited key until TTL, a
  misleading log and no repair. Bad data and transport failure are now separate
  branches: the bucket is deleted and re-initialised with its own log line,
  `allow()` fails open only on `RedisError`, and a bug in the limiter's own code
  propagates instead of quietly disabling limits.
- A Lighter response that is not JSON — a load balancer's HTML on a 200, which
  is what planned maintenance looks like — surfaced as `json.JSONDecodeError`, a
  `ValueError`, and the HTTP layer reads `ValueError` as "the client's request
  was bad": an upstream failure answered 400 with a parser message. `_get()` now
  speaks one failure type (`RuntimeError` for transport, non-JSON and
  wrong-shaped payload alike), and `"key": null` in a response reads as an empty
  list rather than crashing the parser.
- Shutdown closed Redis and PostgreSQL in one line without `finally`: a Redis
  socket that had gone stale mid-run made `aclose()` raise out of the lifespan
  and the database pool was never disposed.
- `api/guards.py` and `session.py` carried the explanation of their own 503 as a
  comment *after* the `raise`, where it reads as dead code; it moved into the
  docstring that the reader is actually shown.
- `cache.py` documented itself as something to replace in production while
  production had been running on it for months.
- Documents that had drifted from the code: the curator endpoints answer 503,
  not 500 (three files said 500); `X-Curator-Token` is in the CORS
  `allow_headers` list, so `SECURITY.md` no longer claims the header is
  unreachable from a browser; the Risk router's "16/16 tests" claim is gone,
  because counts rot and the properties being asserted do not.
- `.wake-modal` padded itself by a flat 16 px, so in the Telegram mini app a
  dialog hung over the home-indicator gesture; the overlay now respects the same
  safe-area variables as the shell.
- `Skeleton` drew its own background and animation inline; it is the `.skeleton`
  class, so the loading state of every panel changes when the theme changes.
- The funding card's note was shown only when a web-app button existed, which
  tied an explanation of `/spread` to a keyboard layout; the hint and the link
  are independent now.

- `verifyTelegramLogin` sent `photo_url` because the Login Widget hands it over,
  and Telegram does not sign that field: the recomputed check string diverged and
  a correctly signed login answered 401. The payload now carries exactly the
  signed fields.
- `hasMiniAppUser` looked for the substrings `user=` and `hash=` in `initData`,
  so a username containing `user=` counted as a signed user. The string is now
  parsed as the parameter set it is (`parseInitData`), and a signature is present
  only when `user`, `auth_date` and `hash` all parse.
- The toast variant was inferred from three `includes()` calls, so
  "Кошелёк не подключился: …" — a failure — rendered as neutral info and buzzed
  as info. `toastVariant()` in `src/components/utils.ts` classifies it, and its
  test enumerates the strings the panels actually print.
- `telegram_bot.card()` glued the note to the last row of the table it followed;
  the note is a different kind of sentence and now gets its own line.
- The price card opened with the symbol the card title had just printed and
  mixed market facts with trading conditions in one block; the network and the
  symbol are in the title, price and 24h change share a line, and conditions
  start after a blank line.

- Automatic resolution of price markets closed nothing. `resolve_due_markets()`
  called its injected oracle as `price_fn(market_id, network, resolve_at)` while
  `lighter_rest.get_price_at()` is `(market_id, when_s, network)` — so the string
  `"mainnet"` arrived where a timestamp was expected, `int("mainnetmainnet…")`
  raised `ValueError`, and the loop's own "no price, don't guess" branch swallowed
  it as a warning per market. The headline claim «цены на Lighter резолвятся
  автоматически» was false for every market, and the suite that looked like proof
  of it passed because the test stubs took the same permuted arguments. The call
  now matches the real signature, the stubs match it too, and
  `test_real_oracle_closes_a_market` runs the cycle through the actual
  `get_price_at` with only `urlopen` substituted — that seam is what had no cover.
- Predict markets stayed tradeable after their deadline. `record_trade()` checked
  only `status == "open"`, and the resolver closes a market up to
  `WAKE_PREDICT_RESOLVER_TICK` after `resolve_at` — a window in which the outcome
  of a price market is already fixed by the oracle and visible to anyone with a
  chart. Buying the known answer cheaper than a dollar is paid for by the pool,
  up to its `b·ln2` subsidy. The data layer now refuses a past-deadline market
  for both kinds, price and event.
- A zero-sized decision became a trade at the default size.
  `run_agent_step()` computed `decision.size_usd or (closing.size * price if
  closing else base_size_usd)`, so for `long`/`short` a `size_usd` of 0 — which
  is exactly what `_bounded_float()` returns for a missing, non-numeric or
  non-finite field in an LLM answer — silently became `base_size_usd`. A reply
  of `{"action": "long", "size_usd": 0}` opened a $100 position the model never
  sized, while `llm_agent.py` documented the opposite behaviour. The fallback
  now applies only to `close`, whose `size_usd` is 0 by design; anything else
  goes to the limit check and comes back as `blocked_by_risk_limit`.
- An aborted order request was reported as a rejection.
  `_place_order_via_signing_service()` had `timeout=10` and one
  `except Exception` answering `failed` — but the frontend refuses to put a
  timeout on `POST /place-order` for precisely this reason: once the bytes are
  written the outcome is unknown, and the next step derives a fresh
  `client_order_index` from a new uuid, so a «retry» is a second order. Timeout,
  reset after send and an unparsable response now return `status: "unknown"`
  with that index echoed; memory and the daily volume are not charged, and the
  panel says to check Lighter instead of repeating. Refused connections and DNS
  failures stay `failed`, because those provably never left the process.
- `leader_listener.py` built `EncryptedKeyStore()` inside the execution loop and
  handled nothing: no `WAKE_MASTER_KEY`, or a keystore that does not decrypt,
  raised into `handle_leader_event()`, which the WebSocket loop reads as a
  dropped connection — a configuration mistake cost every follower their
  mirroring, repeatedly. `_key_store()` now answers `None` and each order gets a
  `keystore_unavailable` row in `mirror_log`.
- The keystore was rewritten in place. `open(path, "wb")` truncates before
  writing, so a process that died between the two left an empty file: every
  follower's API key gone at once, and the engine answering `no_key` from then
  on. Writes now go to `.tmp` with `fsync` and swap in through `os.replace`, the
  file is created `0600`, the temporary file is removed even when the swap fails,
  and the constructor no longer creates a keystore at a mistyped
  `WAKE_KEYSTORE_PATH` while the real table sits beside it under another name.
- One bad candle could black out the whole page. `stats_from_candles()` trusted
  the numbers it was handed, and Starlette serializes JSON with
  `allow_nan=False`: a `NaN` close meant `ValueError: Out of range float values
  are not JSON compliant`, so `/markets/overview` and the bot's market list
  failed for every market rather than one. Rows that are not finite positive
  prices are dropped before the arithmetic now, and `candles_used` reports how
  many were actually counted.
- `get_price_at()` could settle a market on prices from after its deadline. The
  filter was `t <= when_ms`, and by measurement on mainnet (2026-10-24) `t` is
  the minute-aligned start of a candle — so at a round deadline the candle
  chosen was `[deadline, deadline+1min)`, meaning prices up to a minute in the
  future and, when the resolver woke inside that minute, an unfinished candle.
  The oracle now takes the last candle that ended at or before the deadline, so
  no payout is decided by movement nobody had seen yet.
- A validation refusal could not be serialized. `_validation_details()`
  stringified only `ctx`, while Pydantic puts the rejected value itself in
  `input` — so any field with `allow_inf_nan=False` (`/funding-arb/size`,
  `/simulate-mirror`, now Predict too) answered a `NaN` request with a 500.
  Every detail field goes through `_json_safe()` now, and the refusal names the
  rejected value as the string `"nan"`.
- Creating a Predict market accepted numbers that cannot be represented.
  `question`, `lighter_market_id`, `threshold`, `resolve_at` and `b` were plain
  floats: `resolve_at: NaN` reached `datetime.fromtimestamp()` and 500'd the
  curator call, while `threshold: NaN` or `b: Infinity` was stored and then
  poisoned the public `GET /predict/markets` with the same serialization failure
  — one operator typo, broken page for everyone. The models now require finite
  numbers, a positive threshold, a non-negative market index, a horizon of at
  most ten years and a bounded question, and a `Comparator` value that no longer
  matches the enum answers 409 instead of raising `ValueError` out of the
  resolve route. The unused `disputed` field of `EventResolution` — no writer,
  no reader — is gone.
- `_market_constraints()` in `api/agent.py` did
  `int(book["supported_size_decimals"])` unguarded: an active market missing
  either decimals field raised `KeyError` into a 500 on `/agent/step`. It now
  answers 502 `MARKET_DATA_UNUSABLE`, the way the candle path in the same module
  already did, and `build_constraints()` in the listener has always skipped such
  rows rather than defaulting them.
- `round_down()` returned NaN when it was given NaN. Every comparison against
  NaN is False, so `NaN <= 0` and `NaN < min_base_amount` both let the value
  through, and the order died one step later in `scale_to_int()` at execution —
  where it looks like a Lighter failure rather than junk on the way in. `quant.py`
  is now total over its declared domain in the other direction too: non-finite or
  non-numeric input raises `ValueError`, a number too wide for Decimal's 28-digit
  context raises `ValueError` instead of leaking `InvalidOperation`, and
  `is_finite()` is exported so callers guard once instead of writing `<= 0`
  seven different ways.
- `compute_mirror_plan()` could raise instead of answering with a plan. It
  checked the event fields for finiteness but sent the follower fields straight
  into arithmetic — and `Float` columns in PostgreSQL do store NaN. With the
  `round_down()` fix above, a follower row with `allocation_usd = NaN` turned a
  normal market event into `ValueError` inside `handle_leader_event()`, where the
  WebSocket loop reads an exception as a dropped connection: one broken row cost
  every follower of that leader their mirror. Broken follower numbers are now
  skipped as `follower_data_unavailable` — `min(desired_notional, NaN)` returns
  `desired_notional`, so previously a corrupt margin ceiling silently produced an
  order computed as if no ceiling existed — and a size that cannot exist at this
  market's step is skipped as `mirror_size_uncomputable`.
- `size_delta_neutral_position()` promised `None` on unusable input and raised
  `ValueError` instead for a non-finite capital or price (`capital_usd <= 0` does
  not catch NaN). The HTTP route cannot feed it such values — `FundingSizeRequest`
  has `allow_inf_nan=False` — but the function is the module's public contract,
  and the caller that violates it is the next one who writes `funding_arb`
  straight against a live payload.
- The Arcus table on Overview marked every market as not active. It compared
  `status` with `"ACTIVE"` — a value from older documentation — while the live
  `/v1/markets` returns `ONLINE` for 64 rows and `OFFLINE` for 6 (measured on
  mainnet 2026-10-24), so each row rendered grey and spelled the raw wire value.
  Status is now read through `isArcusOnline()`, worded "торгуется" / "выключен",
  and tradeable markets are ordered ahead of the offline ones in the visible 15.
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
