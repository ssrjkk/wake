# Деплой на тестнет через Docker — точные команды

Написано для выполнения там, где есть сеть — локально или в Claude Code.
Здесь эти команды не выполнялись (нет docker, нет сети — проверено, не
предположено).

## 1. Проверка перед стартом
```bash
docker --version
docker compose version
```

## 2. Секреты
```bash
cp backend/.env.example backend/.env
```
Заполнить в `backend/.env`:
- `LIGHTER_ACCOUNT_INDEX`, `LIGHTER_API_KEY_PRIVATE_KEY` — с app.lighter.xyz (testnet-режим), см. TESTNET-GUIDE.md
- `WAKE_MASTER_KEY` — `python3 -c "from encrypted_key_store import generate_master_key; print(generate_master_key())"`
- Остальное можно оставить пустым для первого прогона (Stripe/AWS/Anthropic — опционально)

## 3. Сборка и запуск
```bash
docker compose build
docker compose up -d
```
Поднимет `app` (порт 8000) и `signing` (порт 8787) — см. `docker-compose.yml`.
`WAKE_DRY_RUN=true` в нём уже прописан по умолчанию — реальные ордера не
уйдут, пока это осознанно не поменяно.

## 4. Проверка, что реально поднялось
```bash
curl http://localhost:8000/docs        # Swagger UI должен открыться
curl http://localhost:8000/predict/markets
docker compose logs -f app             # смотреть логи в реальном времени
```

## 5. Фронтенд отдельно (не в docker-compose — статика, проще через любой хостинг)
```bash
npm install
npm run build
# dist/ — раздать через Vercel/Netlify/nginx, что угодно, отдающее статику
```
Перед билдом поправить `WAKE_BACKEND_URL`/`SIGNING_SERVICE_URL` в
`src/lib/lighter.ts` — сейчас захардкожен `localhost`, для реального
деплоя нужен адрес поднятого контейнера `app`.

## 6. Тестнет, не мейннет — проверить явно
```bash
docker compose exec app python3 -c "from lighter_rest import get_mark_price; print(get_mark_price(0, 'testnet'))"
```
Если вернулась цена ETH — контейнер реально достучался до Lighter testnet.

## Дальше — TASKS.md, этапы 2-3
Это разворачивает инфраструктуру. Реальная торговля на тестнете (регистрация,
краны, первый ордер) — отдельные шаги, уже описанные в `TESTNET-GUIDE.md`,
выполняются после того, как контейнеры реально подняты и отвечают.
