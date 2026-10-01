# Wake — терминал на Lighter

> [!]  **Читать первым:** `AGENTS.md` (правила для любого ИИ-агента и человека в этом репо).

Терминал поверх Lighter (zk perp DEX): перпы и споты, копи-трейдинг,
Prediction markets (LMSR), AI-агент с памятью, cross-asset portfolio risk,
funding-rate арбитраж. Плюс Telegram-бот и Telegram Mini App.

По умолчанию — **testnet** и `WAKE_DRY_RUN=true`, без реальных денег.

## Быстрый старт

```bash
npm install && npm run dev           # фронтенд (Vite) на :5173

cd backend
pip install -r requirements.txt
python seed_demo_leaders.py           # демо-лидеры, иначе Copy упадёт на FK
uvicorn app:app --reload --port 8000  # бэкенд; /docs — Swagger
uvicorn signing_service:app --port 8787  # подпись ордеров (только свои ключи)
```

Нужен свой WalletConnect project id (cloud.walletconnect.com) в `src/wagmi.ts`.

Конфигурация фронтенда — через env (см. `.env.example`):
`VITE_BACKEND_URL`, `VITE_SIGNING_SERVICE_URL`, `VITE_LIGHTER_NETWORK`.
Бэкенд — `backend/.env` из `backend/.env.example` (`LIGHTER_*`, `WAKE_CURATOR_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `WAKE_MASTER_KEY`).

## Что реально работает (проверено)

- **Бэкенд целиком.** 141 тест зелёный (`cd backend && python3 -m unittest discover -v`),
  включая HTTP smoke-тесты (`test_api_smoke.py`), которые реально гоняют каждый эндпоинт
  через FastAPI TestClient: копи-трейдинг, полный predict-цикл (create→trade→resolve→claim),
  funding-arb, portfolio risk, subscription, agent.
- **Живой Lighter testnet.** `orderBooks` (перпы BTC/ETH/SOL + спот), свечи, funding-rates
  реально доступны и отдаются в UI.
- **Фронтенд.** `tsc --noEmit` и `npm run build` проходят.
- **Signing service** поднимается и честно отвечает понятной ошибкой без ключей.

## Что требует внешнего (не кода)

- **Живая подпись ордера** — нужен Lighter API key (app.lighter.xyz, testnet-режим).
  `place_order_example.py` читает ключи из env, без правки кода.
- **Telegram-бот** — нужен токен от @BotFather (`TELEGRAM_BOT_TOKEN`).
- **KMS / Stripe / Postgres** — код написан, требует реальные аккаунты/инфраструктуру.
- **WebSocket-цикл копи-движка** (`leader_listener.py`) — логика протестирована, живое
  WS-соединение требует funded testnet-аккаунта.
- **HSM/KMS для чужих ключей** — `encrypted_key_store.py` это encryption-at-rest, НЕ
  custody-grade. Гейт на продакшн — `backend/GO-LIVE-CHECKLIST.md`.

## Архитектура бэкенда

`backend/app.py` — тонкий FastAPI-слой: middleware (CORS, rate limiting) + сборка роутеров
из `backend/api/`, каждый продукт в своём модуле:

- `api/copy_trading.py` — followers/leaders/follows + `/simulate-mirror`
- `api/predict.py` — предсказания (price/event рынки), кураторская авторизация
- `api/agent.py` — AI-агент + подписка
- `api/portfolio.py` — cross-asset portfolio risk
- `api/funding.py` — funding rate арбитраж

Чистая логика каждого продукта — в корневых модулях (`mirror_engine.py`, `predict_amm.py`,
`portfolio_risk.py`, `funding_arb.py`, ...), протестирована в `test_*.py`. Конфигурация
(пути БД, лимиты rate limiting) — в `backend/config.py`, переопределяется env
(`WAKE_DB_PATH`, `WAKE_AUDIT_DB_PATH`, `WAKE_RATE_LIMIT_CAPACITY`, `WAKE_RATE_LIMIT_REFILL`).

Добавление нового продукта = новый модуль в `api/` + `include_router` в `app.py`.

## Полезные ссылки

- Sub-accounts and API keys: https://docs.lighter.xyz/perpetual-futures/sub-accounts-and-api-keys
- Signing Transactions: https://apidocs.lighter.xyz/docs/trading
- Partner Attribution (комиссия Wake как интегратора): https://apidocs.lighter.xyz/docs/partner-integration
- Python SDK: https://github.com/elliottech/lighter-python
- Полный индекс API для агентов: https://apidocs.lighter.xyz/llms.txt