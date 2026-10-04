"""
Telegram-бот Wake: /price, /markets, /funding, /predict и кнопка на полный
интерфейс (Mini App).

Что здесь проверено, а что — нет, по частям:

  - Числа берутся из lighter_rest.py, тем же кодом, которым в этом проекте сняты
    живые ответы mainnet (orderBooks, candles, funding-rates). Сеть задаётся
    config.LIGHTER_NETWORK — бот не может смотреть в тестнет, пока сайт и
    резолюция рынков читают mainnet.
  - Формат ответов бэкенда (/predict/markets, /funding/rates) — из api/predict.py
    и api/funding.py, оба роута покрыты тестами (test_predict_integration.py,
    test_api_smoke.py).
  - Текст-формообразователи (price_report/markets_report/predict_report) — чистые
    функции, прогнаны тестами на фикстурах формы живого ответа: test_telegram_bot.py.
  - НЕ прогонялся отсюда сам цикл Telegram: polling требует токен от @BotFather и
    процесс 24/7. Поэтому Bot создаётся лениво в main() — модуль импортируется и
    тестируется без токена, а хендлеры остаются тонкой обвязкой над тестированными
    функциями.

Запуск:
    pip install -r requirements.txt
    export TELEGRAM_BOT_TOKEN=...            # @BotFather -> /newbot
    export WAKE_MINIAPP_URL=https://...      # сайт целиком: кнопка открывает его вебвью, для Telegram нужен https
    export WAKE_BACKEND_URL=http://...       # где лежит backend/app.py
    python telegram_bot.py
"""

import asyncio
import datetime
import os

import httpx
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command
from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

import lighter_rest
from config import LIGHTER_NETWORK, TELEGRAM_BOT_TOKEN
from funding_arb import base_asset

WAKE_MINIAPP_URL = os.environ.get("WAKE_MINIAPP_URL", "http://localhost:5173/")
WAKE_BACKEND = os.environ.get("WAKE_BACKEND_URL", "http://localhost:8000")

# Бот создаётся в main(), а не на импорте: aiogram валидирует токен в конструкторе,
# и без TELEGRAM_BOT_TOKEN модуль не удавалось даже импортировать в тестах.
dp = Dispatcher()


def fmt_usd(value: float) -> str:
    if value >= 1_000_000_000:
        return f"${value / 1_000_000_000:.2f}B"
    if value >= 1_000_000:
        return f"${value / 1_000_000:.1f}M"
    if value >= 1_000:
        # Один знак обязательно: без него $1,500 показывалось как $2K, т.е. цифра
        # в интерфейсе расходилась с деньгами юзера на треть.
        return f"${value / 1_000:.1f}K".replace(".0K", "K")
    return f"${value:,.2f}"


def fmt_price(value: float) -> str:
    if value >= 1000:
        return f"{value:,.2f}"
    if value >= 1:
        return f"{value:.4f}".rstrip("0").rstrip(".")
    return f"{value:.6f}".rstrip("0").rstrip(".")


def fmt_pct(value: float) -> str:
    return f"{value * 100:+.2f}%"


def find_perp(symbol: str) -> dict | None:
    """Активный перп Lighter по вписанному тикеру.

    lighter_rest.get_order_books отдаёт и спот, и неактивные рынки, а подписи
    разные ("ETH" против "ETH/USDC"), поэтому сопоставление по базовому активу,
    а не по точному совпадению строки."""
    wanted = base_asset(symbol)
    for book in lighter_rest.get_order_books(LIGHTER_NETWORK):
        if book.get("market_type") != "perp" or book.get("status") != "active":
            continue
        if base_asset(str(book.get("symbol", ""))) == wanted:
            return book
    return None


def price_report(symbol: str, book: dict, stats: dict, funding: dict | None) -> str:
    lines = [
        f"{symbol} · market_id {book['market_id']}",
        f"Цена (close последней 1ч свечи): {fmt_price(stats['price'])}",
        f"Изменение за 24ч: {fmt_pct(stats['change_24h'])}",
        f"Оборот за 24ч: {fmt_usd(stats['quote_volume_24h'])}",
        f"Открытый интерес: {fmt_open_interest(book)} базового актива",
        f"Мин. размер: {book['min_base_amount']} · шаг: {book['supported_size_decimals']} знаков",
    ]
    if funding is None:
        lines.append("Funding: нет ставки по этому рынку")
    else:
        # direction — это КТО платит: "long" означает, что ставку получают шорты
        # перпа (и именно так строится cash-and-carry: шорт перпа + лонг спота).
        pays = "лонги" if funding["direction"] == "long" else "шорты"
        lines.append(
            f"Funding: {funding['rate'] * 100:.4f}%/ч (годовая ≈ {funding['rate'] * 24 * 365 * 100:.1f}%), платят {pays}"
        )
    return "\n".join(lines)


def fmt_open_interest(book: dict) -> str:
    """open_interest в книге — в БАЗОВЫХ единицах актива ("372.658848" для BTC),
    строкой, и между рынками несопоставим. Поэтому здесь это именно количество
    актива, а не $, и ранжирование по нему было бы ложью. Пустое поле — "—",
    а не "0.0000": ноль в книге означает отсутствие данных, а не нулевой OI."""
    raw = book.get("open_interest")
    if raw is None or raw == "":
        return "—"
    try:
        return f"{float(raw):,.4f}"
    except (TypeError, ValueError):
        return "—"


def markets_report(overview: dict, limit: int = 10) -> str:
    """Ранжирование по реальным $-оборотам за 24ч (сумма quote-объёма часовых
    свечей), а не по алфавиту и не по open interest в базовых единицах."""
    rows = overview["rows"][:limit]
    if not rows:
        return "Данных по рынку нет — Lighter API не ответил."
    lines = [
        f"Топ {len(rows)} перпов Lighter по обороту за 24ч ({overview['network']}):"
    ]
    for i, r in enumerate(rows, 1):
        lines.append(
            f"{i:>2}. {r['symbol']:<9} {fmt_price(r['price']):>10}  "
            f"{fmt_pct(r['change_24h']):>8}  {fmt_usd(r['quote_volume_24h']):>8}"
        )
    missing = overview.get("no_market") or []
    if missing:
        lines.append(f"Без активного перпа: {', '.join(missing)}")
    lines.append("Полный список и поиск — в мини-аппе.")
    return "\n".join(lines)


def _fmt_left(resolve_at: float, now: datetime.datetime) -> str:
    delta = datetime.datetime.fromtimestamp(resolve_at, tz=datetime.timezone.utc) - now
    total = int(delta.total_seconds())
    if total <= 0:
        return "срок истёк"
    days, rem = divmod(total, 86400)
    # rem // 60 — минуты, из них уже парсим часы: деление на 3600 давало бы
    # "5ч 0м" там, где осталось 5 часов 20 минут.
    hours, minutes = divmod(rem // 60, 60)
    if days:
        return f"осталось {days}д {hours}ч"
    if hours:
        return f"осталось {hours}ч {minutes}м"
    return f"осталось {minutes}м"


def predict_report(
    markets: list, limit: int = 10, now: datetime.datetime | None = None
) -> str:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    rows = markets[:limit]
    if not rows:
        return "Открытых Predict-рынков нет. Резолвленные — командой /predict resolved."
    lines = [f"Predict-рынки Wake ({len(rows)}):"]
    for m in rows:
        volume = fmt_usd(float(m.get("volume_usd") or 0))
        trades = int(m.get("trade_count") or 0)
        if m.get("status") == "resolved":
            detail = f"   исход: {m.get('outcome') or 'не указан'} · объём {volume} · сделок {trades}"
        else:
            detail = f"   {float(m['price_yes']) * 100:.0f}% YES · объём {volume} · сделок {trades}"
            if m.get("resolve_at"):
                detail += f" · {_fmt_left(float(m['resolve_at']), now)}"
        lines.append(f"• {m['question']}\n{detail}")
    lines.append("Купить долю и забрать выигрыш — в мини-аппе.")
    return "\n".join(lines)


def funding_report(rates: list, limit: int = 10) -> str:
    rows = rates[:limit]
    if not rows:
        return "Подходящих ставок funding нет — бэкенд не ответил или все рынки платят шортам."
    lines = [
        "Funding Lighter (эпох 1 час), годовая по убыванию. Показаны рынки, где ставку"
    ]
    lines.append(
        "получают шорты перпа — только они забираются cash-and-carry без займа актива:"
    )
    for r in rows:
        lines.append(
            f"• {str(r['symbol']):<9} {r['hourly_rate'] * 100:.4f}%/ч → "
            f"{r['annualized'] * 100:.1f}% годовых · платят "
            f"{'лонги' if r['direction'] == 'long' else 'шорты'}"
        )
    lines.append("Список пар, где физически есть обе ноги (перп+спот), — в мини-аппе.")
    return "\n".join(lines)


def _miniapp_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Открыть Wake", web_app=WebAppInfo(url=WAKE_MINIAPP_URL)
                )
            ]
        ]
    )


async def _get_json(path: str) -> object:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{WAKE_BACKEND}{path}")
        resp.raise_for_status()
        return resp.json()


@dp.message(Command("start", "help"))
async def cmd_start(message: Message):
    await message.answer(
        "Wake — терминал на Lighter: перпы, споты, funding, копи-трейдинг, Predict-рынки.\n\n"
        "/price BTC — цена, изменение и оборот за 24ч, funding\n"
        "/markets — топ перпов по реальному обороту\n"
        "/funding — ставки funding по годовой\n"
        "/predict — Predict-рынки Wake (/predict resolved — резолвленные)\n\n"
        "Сеть: " + LIGHTER_NETWORK + ". Полный интерфейс — кнопкой ниже.",
        reply_markup=_miniapp_keyboard(),
    )


@dp.message(Command("price"))
async def cmd_price(message: Message):
    parts = (message.text or "").split()
    symbol = parts[1] if len(parts) > 1 else "BTC"
    try:
        book = await asyncio.to_thread(find_perp, symbol)
        if book is None:
            await message.answer(
                f"Активного перпа {symbol} на Lighter нет. Список — /markets."
            )
            return
        market_id = int(book["market_id"])
        stats = await asyncio.to_thread(lighter_rest.get_24h_stats, market_id)
        try:
            funding = await asyncio.to_thread(lighter_rest.get_funding_rate, market_id)
        except RuntimeError:
            funding = None
        await message.answer(price_report(base_asset(symbol), book, stats, funding))
    except RuntimeError as e:
        await message.answer(str(e))


@dp.message(Command("markets"))
async def cmd_markets(message: Message):
    try:
        overview = await asyncio.to_thread(lighter_rest.get_market_overview)
    except RuntimeError as e:
        await message.answer(str(e))
        return
    await message.answer(markets_report(overview), reply_markup=_miniapp_keyboard())


@dp.message(Command("funding"))
async def cmd_funding(message: Message):
    try:
        body = await _get_json("/funding/rates?limit=10")
    except httpx.HTTPError as e:
        await message.answer(f"Бэкенд недоступен: {e} (запущен ли backend/app.py?)")
        return
    rates = [r for r in body["rates"] if r["direction"] == "long"]
    await message.answer(funding_report(rates))


@dp.message(Command("predict"))
async def cmd_predict(message: Message):
    parts = (message.text or "").split()
    status = (
        parts[1]
        if len(parts) > 1 and parts[1] in ("open", "resolved", "all")
        else "open"
    )
    try:
        markets = await _get_json(f"/predict/markets?status={status}")
    except httpx.HTTPError as e:
        await message.answer(f"Бэкенд недоступен: {e} (запущен ли backend/app.py?)")
        return
    await message.answer(predict_report(markets), reply_markup=_miniapp_keyboard())


@dp.message(F.text)
async def fallback(message: Message):
    await message.answer("Не понял. /start — список команд.")


async def main():
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN не задан — получи у @BotFather")
    bot = Bot(token=TELEGRAM_BOT_TOKEN)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
