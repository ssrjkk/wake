# AGENTS.md — read this first (Wake)

RU: файл для любых ИИ-агентов и людей, заходящих в репозиторий. Прочитай до любых правок.

## What this is
Wake: a terminal on the Lighter ecosystem (zk perp DEX) with copy trading, Polymarket-style prediction
markets (LMSR), an AI agent with memory, cross-asset portfolio risk, and funding-rate arbitrage.
Also a Telegram bot and a Telegram Mini App. Frontend: Vite/React/TS/Tailwind/wagmi in `src/`.
Backend: Python (stdlib-first, FastAPI for HTTP) in `backend/`. REST-слой разделён на роутеры
по продуктам: `backend/app.py` — тонкий FastAPI-файл (middleware + include_router),
`backend/api/` — каждый продукт в своём модуле (copy_trading, predict, agent, portfolio, funding).
Чистая логика каждого продукта — в корневых модулях `backend/*.py` и протестирована в `test_*.py`.

## Non-negotiable rules
1. No real money by default. Testnet is the default network and `WAKE_DRY_RUN=true` is the default.
   Do not flip either, or hardcode mainnet, before `backend/GO-LIVE-CHECKLIST.md` is signed off by named humans.
2. Key custody: `encrypted_key_store.py` is encryption-at-rest only (NOT HSM-grade) and `kms_key_store.py`
   was never run. Never use them for third-party users' real trading keys in production.
3. Predict module: event markets carry regulatory risk. Re-verify current rules before opening to any jurisdiction.
4. Copy trading with delegated keys and fees on leveraged trading may count as a regulated investment service,
   and Lighter has its own geographic restrictions. Not researched to jurisdiction level. Get counsel.
5. Honesty convention: files are labelled tested vs untested. Never claim "works" for code that was not run.
   Never executed in the authoring sandbox (no network): FastAPI endpoints, the WebSocket loop, KMS, Stripe,
   Postgres, the Telegram bot, live Lighter order signing. Keep those labels accurate.
6. Order sizes: always round down, never up. Use each market's `supported_size_decimals` and
   `supported_price_decimals`. Never hardcode market ids (live API: ETH=0, BTC=1); look up by symbol.
7. Do not silently rewrite unverified facts: quote asset USDC vs USDG, and L1 testnet = Sepolia, are assumptions.

## Verify before claiming done
- `cd backend && python3 -m unittest discover -v` (135 tests when written), plus the script-style checks:
  `test_db.py`, `test_predict_db.py`, `test_predict_integration.py`, `test_audit_log.py`.
- Frontend cannot be compiled in the authoring sandbox. Bracket balance of (){}[] is NOT enough: an unclosed
  `<div>` survived several rounds. Check JSX tag balance with a character-level scanner; multi-line tags break
  line-based regex counters.
- Prefer invariant/fuzz checks: LMSR price in [0,1], portfolio vol <= naive sum, capped size <= requested.
- Your own verification tooling can be wrong. Most "bugs" found late were in test/fuzz harnesses
  (mismatched series lengths, scale-invariant correlation, cold-start token bucket), not in product code.
  Diagnose before "fixing".

## Known gaps (do not assume these work)
- Order execution through `signing_service.py` and the `leader_listener.py` WebSocket loop: never run live.
- `get_funding_rate` parses response keys defensively (`funding_rates` / `rates`); the exact schema was not confirmed live.
- Agent and subscription state is in memory (not persisted to DB).
- Telegram Mini App uses the Telegram user id as a temporary identity; there is no wallet linking inside the WebView.
- Telegram bot was never registered with BotFather.
- Event-market creation requires `WAKE_CURATOR_TOKEN` (simple hmac token in `X-Curator-Token` header) — a stopgap,
  not a full auth layer.

## Environment facts
Authoring sandbox: no network (npm/pip blocked), no docker; `/home/claude` resets between tasks,
`/mnt/user-data/outputs` persists. The latest full snapshot is `wake-web3-app.zip`.

## Map
README.md, PROJECT-STATUS.md, TASKS.md, ROADMAP-TO-PRODUCTION.md, IMPLEMENTATION-PLAN.md,
backend/GO-LIVE-CHECKLIST.md, TESTNET-GUIDE.md, DEPLOY-TESTNET.md, ECOSYSTEM-FIT.md,
GROWTH-OPPORTUNITIES.md.
