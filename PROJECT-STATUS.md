# Wake — статус проекта целиком

> [!]  **Читать первым:** `AGENTS.md` (правила для любого ИИ-агента и человека в этом репо).

## Три столпа + связующий слой
1. **Lighter — исполнение.** Реальный wallet connect, рыночный пикер по
   100+ рынкам (крипта/акции/форекс/commodities/спот), risk-лимиты на
   реальном пути исполнения (11 тестов), rate limiting (token bucket,
   9 тестов) — вшит как реальный middleware. Подпись ордера — `signing_service.py`,
   реально поднимается и честно отвечает ошибкой без ключей.
2. **Polymarket-аналог — предсказания.** LMSR (17 тестов), два честно
   разных механизма резолюции (10 тестов), полный цикл create→trade→
   resolve→claim. Event-рынки и резолюция — только куратор с `WAKE_CURATOR_TOKEN`.
3. **AI-трейдер с памятью.** История сделок (14 тестов), momentum-движок
   (11 тестов), LLM-слой с проверенным откатом на baseline.

**Portfolio risk** (16 тестов) связывает все три в один профиль риска —
структурно возможно именно из-за единой маржи Lighter через классы активов.

## Web3-продукты
- `backend/telegram_bot.py` — aiogram-бот (/price, /markets, /predict, кнопка на
  мини-апп). Код готов, требует `TELEGRAM_BOT_TOKEN` от @BotFather.
- `telegram-miniapp/index.html` — Telegram WebApp SDK (тема, haptics), живая
  цена+спарклайн с Lighter, Predict-рынки с рабочими YES/NO, перп-ордер через
  signing service. Адреса — через query-параметры `?backend=&signing=`.
- `Dockerfile.backend`, `docker-compose.yml` — деплой-манифесты (docker не
  проверялся на этой машине).
- `ECOSYSTEM-FIT.md` — скан экосистемы Lighter (Robinhood Wallet/USDG, RWA+Equity
  через Chainlink) — ничего готового, аналогичного Wake, не найдено.

## Числа
141 тест зелёный (135 unit + 6 HTTP smoke через `test_api_smoke.py`, который
реально гоняет каждый эндпоинт через FastAPI TestClient). Fuzz-тестирование на
7 чистых модулях — ноль нарушений. Живой Lighter testnet проверен: orderBooks
(перпы BTC/ETH/SOL + спот), свечи, funding-rates.

## Архитектура бэкенда
`backend/app.py` — тонкий FastAPI-файл: middleware (CORS, rate limiting) +
сборка роутеров. Каждая продуктовая область — в `backend/api/`:
`copy_trading.py`, `predict.py`, `agent.py`, `portfolio.py`, `funding.py`.
Чистая логика — в корневых модулях `backend/*.py`, протестирована в `test_*.py`.
Конфигурация (пути БД, лимиты, токены) — в `backend/config.py` и env.

## Что вне кода
Живая подпись ордера (нужен Lighter API key), регистрация бота (BotFather),
KMS/Stripe/Postgres (внешние аккаунты), WebSocket-цикл копи-движка (нужен
funded testnet-аккаунт). Гейт на продакшн с чужими деньгами —
`backend/GO-LIVE-CHECKLIST.md`.
