# Wake

Trading terminal for [Lighter](https://lighter.xyz) (zk perp DEX) with copy trading, prediction markets, AI agent, portfolio risk management, and funding rate arbitrage. Includes Telegram bot and Mini App.

Default configuration uses **testnet** with `WAKE_DRY_RUN=true` — no real money.

## Features

- **Perpetual & spot trading** via Lighter protocol
- **Copy trading** — follow leaders and mirror their positions automatically
- **Prediction markets** — LMSR-based price and event markets with curator-gated resolution
- **AI agent** — momentum-based trading decisions with persistent memory
- **Portfolio risk** — cross-asset risk analysis across all positions
- **Funding arbitrage** — automated funding rate arbitrage strategies
- **Telegram integration** — bot commands and Mini App for mobile access

## Quick Start

### Frontend

```bash
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

You need a WalletConnect project ID from [cloud.walletconnect.com](https://cloud.walletconnect.com). Set it in `src/wagmi.ts`.

### Backend

```bash
cd backend
pip install -r requirements.txt
python seed_demo_leaders.py
uvicorn app:app --reload --port 8000
```

Backend runs on `http://localhost:8000` with Swagger docs at `/docs`.

### Signing Service

```bash
cd backend
uvicorn signing_service:app --port 8787
```

Signing service handles order signing. Requires Lighter API keys for live trading.

## Configuration

### Frontend

Copy `.env.example` to `.env`:

```
VITE_LIGHTER_NETWORK=testnet
VITE_BACKEND_URL=http://localhost:8000
VITE_SIGNING_SERVICE_URL=http://localhost:8787
```

### Backend

Copy `backend/.env.example` to `backend/.env`:

```
LIGHTER_BASE_URL=https://testnet.zklighter.elliot.ai
LIGHTER_ACCOUNT_INDEX=
LIGHTER_API_KEY_INDEX=0
LIGHTER_API_KEY_PRIVATE_KEY=

WAKE_CURATOR_TOKEN=
TELEGRAM_BOT_TOKEN=
WAKE_MASTER_KEY=
WAKE_DRY_RUN=true
```

See `backend/.env.example` for all available options.

## Testing

### Backend

```bash
cd backend
python -m unittest discover -v
python test_db.py
python test_predict_db.py
python test_predict_integration.py
python test_audit_log.py
```

141 tests covering all backend modules including HTTP smoke tests for all API endpoints.

### Frontend

```bash
npx tsc --noEmit
npm run build
```

## Architecture

### Backend

FastAPI application with modular structure:

- `backend/app.py` — main application, middleware (CORS, rate limiting), router registration
- `backend/api/` — HTTP routers by product area:
  - `copy_trading.py` — followers, leaders, follows, mirror simulation
  - `predict.py` — prediction markets (price and event markets)
  - `agent.py` — AI agent and subscription management
  - `portfolio.py` — cross-asset portfolio risk
  - `funding.py` — funding rate arbitrage

Core logic in root modules (`mirror_engine.py`, `predict_amm.py`, `portfolio_risk.py`, `funding_arb.py`, etc.), tested independently.

Configuration via environment variables in `backend/config.py`.

### Frontend

React + TypeScript + Vite + Tailwind CSS + wagmi for wallet connections.

Main application in `src/App.tsx` with tabs for Terminal, Discover, Portfolio, Earn, Predict, AI Agent, Funding, and Risk.

## Deployment

### Docker

```bash
docker-compose up
```

Runs backend on port 8000 and signing service on port 8787.

### Manual

1. Deploy backend to Railway/Render/Fly.io
2. Deploy frontend to Vercel/Netlify
3. Set environment variables
4. Configure domain and SSL

## Security

- All secrets via environment variables, never hardcoded
- SQL injection protection via parameterized queries
- CORS configured via environment variables
- Rate limiting with token bucket algorithm
- Encrypted key storage at rest (not HSM-grade)

For production use with real funds:
- External security audit required
- Replace `encrypted_key_store.py` with HSM/KMS
- Complete `backend/GO-LIVE-CHECKLIST.md` (if present in your fork)
- Obtain legal counsel for your jurisdiction

## Contributing

Contributions welcome. Please ensure:

- All backend tests pass (`python -m unittest discover`)
- Frontend builds without errors (`npm run build`)
- TypeScript strict check passes (`npx tsc --noEmit`)
- No hardcoded secrets or credentials
- Follow existing code style

## License

MIT License — see [LICENSE](LICENSE) file.

---

# Русская версия

Торговый терминал для [Lighter](https://lighter.xyz) (zk perp DEX) с копи-трейдингом, рынками предсказаний, AI-агентом, управлением портфельными рисками и арбитражем funding rate. Включает Telegram-бот и Mini App.

По умолчанию используется **testnet** с `WAKE_DRY_RUN=true` — без реальных денег.

## Возможности

- **Перпетуалы и споты** через протокол Lighter
- **Копи-трейдинг** — автоматическое копирование позиций лидеров
- **Рынки предсказаний** — LMSR-рынки цен и событий с кураторской резолюцией
- **AI-агент** — торговые решения на основе momentum с постоянной памятью
- **Портфельные риски** — кросс-ассетный анализ рисков всех позиций
- **Funding арбитраж** — автоматизированные стратегии арбитража funding rate
- **Telegram интеграция** — команды бота и Mini App для мобильного доступа

## Быстрый старт

### Фронтенд

```bash
npm install
npm run dev
```

Фронтенд работает на `http://localhost:5173`.

Нужен WalletConnect project ID с [cloud.walletconnect.com](https://cloud.walletconnect.com). Установите его в `src/wagmi.ts`.

### Бэкенд

```bash
cd backend
pip install -r requirements.txt
python seed_demo_leaders.py
uvicorn app:app --reload --port 8000
```

Бэкенд работает на `http://localhost:8000`, Swagger документация на `/docs`.

### Signing Service

```bash
cd backend
uvicorn signing_service:app --port 8787
```

Сервис подписи обрабатывает подпись ордеров. Требует Lighter API ключи для реальной торговли.

## Конфигурация

### Фронтенд

Скопируйте `.env.example` в `.env`:

```
VITE_LIGHTER_NETWORK=testnet
VITE_BACKEND_URL=http://localhost:8000
VITE_SIGNING_SERVICE_URL=http://localhost:8787
```

### Бэкенд

Скопируйте `backend/.env.example` в `backend/.env`:

```
LIGHTER_BASE_URL=https://testnet.zklighter.elliot.ai
LIGHTER_ACCOUNT_INDEX=
LIGHTER_API_KEY_INDEX=0
LIGHTER_API_KEY_PRIVATE_KEY=

WAKE_CURATOR_TOKEN=
TELEGRAM_BOT_TOKEN=
WAKE_MASTER_KEY=
WAKE_DRY_RUN=true
```

Смотрите `backend/.env.example` для всех доступных опций.

## Тестирование

### Бэкенд

```bash
cd backend
python -m unittest discover -v
python test_db.py
python test_predict_db.py
python test_predict_integration.py
python test_audit_log.py
```

141 тест покрывает все модули бэкенда, включая HTTP smoke-тесты всех API эндпоинтов.

### Фронтенд

```bash
npx tsc --noEmit
npm run build
```

## Архитектура

### Бэкенд

FastAPI приложение с модульной структурой:

- `backend/app.py` — главное приложение, middleware (CORS, rate limiting), регистрация роутеров
- `backend/api/` — HTTP роутеры по продуктовым областям:
  - `copy_trading.py` — followers, leaders, follows, симуляция зеркалирования
  - `predict.py` — рынки предсказаний (рынки цен и событий)
  - `agent.py` — AI-агент и управление подписками
  - `portfolio.py` — кросс-ассетные портфельные риски
  - `funding.py` — арбитраж funding rate

Основная логика в корневых модулях (`mirror_engine.py`, `predict_amm.py`, `portfolio_risk.py`, `funding_arb.py` и т.д.), протестирована независимо.

Конфигурация через переменные окружения в `backend/config.py`.

### Фронтенд

React + TypeScript + Vite + Tailwind CSS + wagmi для подключения кошельков.

Главное приложение в `src/App.tsx` с вкладками Terminal, Discover, Portfolio, Earn, Predict, AI Agent, Funding и Risk.

## Деплой

### Docker

```bash
docker-compose up
```

Запускает бэкенд на порту 8000 и signing service на порту 8787.

### Вручную

1. Задеплойте бэкенд на Railway/Render/Fly.io
2. Задеплойте фронтенд на Vercel/Netlify
3. Установите переменные окружения
4. Настройте домен и SSL

## Безопасность

- Все секреты через переменные окружения, ничего не захардкожено
- Защита от SQL injection через параметризованные запросы
- CORS настраивается через переменные окружения
- Rate limiting с алгоритмом token bucket
- Шифрование ключей at rest (не HSM-уровня)

Для продакшен использования с реальными средствами:
- Требуется внешний аудит безопасности
- Замените `encrypted_key_store.py` на HSM/KMS
- Пройдите чек-лист готовности к продакшену
- Получите юридическую консультацию для вашей юрисдикции

## Contributing

Contributions приветствуются. Пожалуйста, убедитесь:

- Все тесты бэкенда проходят (`python -m unittest discover`)
- Фронтенд собирается без ошибок (`npm run build`)
- TypeScript strict check проходит (`npx tsc --noEmit`)
- Нет захардкоженных секретов или учётных данных
- Следуйте существующему стилю кода

## Лицензия

MIT License — смотрите файл [LICENSE](LICENSE).
