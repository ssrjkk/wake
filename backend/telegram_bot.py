"""
[!]   НЕ ЗАПУСКАЛОСЬ И НЕ ЗАРЕГИСТРИРОВАНО. Живой Telegram-бот — это токен от
@BotFather (реальная регистрация в Telegram) плюс процесс, работающий 24/7
на сервере. Ни то, ни другое не делается из этой песочницы — то же
ограничение, что с деплоем сайта весь этот разговор. Код написан по
стандартному, документированному aiogram v3, тем же принципом честности,
что и весь остальной непроверенный сетевой код в проекте.

pip install aiogram httpx
Получить токен: @BotFather в Telegram -> /newbot -> вставить в TELEGRAM_BOT_TOKEN
Запуск: python3 telegram_bot.py
"""

import asyncio
import os

try:
    from aiogram import Bot, Dispatcher, F
    from aiogram.filters import Command
    from aiogram.types import Message, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
except ImportError:
    Bot = Dispatcher = F = Command = Message = InlineKeyboardMarkup = InlineKeyboardButton = WebAppInfo = None

import httpx

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
WAKE_MINIAPP_URL = os.environ.get("WAKE_MINIAPP_URL", "https://example.com/miniapp")  # заменить на реальный домен мини-аппа
LIGHTER_API = "https://testnet.zklighter.elliot.ai/api/v1"  # testnet по умолчанию — тот же принцип, что и весь бэкенд
WAKE_BACKEND = os.environ.get("WAKE_BACKEND_URL", "http://localhost:8000")

bot = Bot(token=TELEGRAM_BOT_TOKEN) if Bot else None
dp = Dispatcher() if Dispatcher else None


def _miniapp_keyboard() -> "InlineKeyboardMarkup":
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=" Открыть Wake", web_app=WebAppInfo(url=WAKE_MINIAPP_URL))]
    ])


if dp:
    @dp.message(Command("start"))
    async def cmd_start(message: "Message"):
        await message.answer(
            "Wake — терминал на Lighter: перпы, споты, копи-трейдинг, Predict-рынки.\n\n"
            "/price BTC — текущая цена\n"
            "/markets — список рынков\n"
            "/predict — открытые Predict-рынки\n"
            "Или открой полный интерфейс кнопкой ниже.",
            reply_markup=_miniapp_keyboard(),
        )

    @dp.message(Command("price"))
    async def cmd_price(message: "Message"):
        parts = message.text.split()
        symbol = parts[1].upper() if len(parts) > 1 else "BTC"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{LIGHTER_API}/orderBooks", params={"filter": "perp"})
                resp.raise_for_status()
                markets = resp.json().get("order_books", [])
            market = next((m for m in markets if m["symbol"] == symbol), None)
            if not market:
                await message.answer(f"Рынок {symbol} не найден. Попробуй /markets для списка.")
                return
            await message.answer(
                f"{symbol}-PERP\n"
                f"Комиссия тейкера: {market['taker_fee']}\n"
                f"Мин. размер: {market['min_base_amount']}\n"
                f"(Точная цена — в мини-аппе, здесь только метаданные рынка)"
            )
        except httpx.HTTPError as e:
            await message.answer(f"Lighter API недоступен: {e}")

    @dp.message(Command("markets"))
    async def cmd_markets(message: "Message"):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{LIGHTER_API}/orderBooks", params={"filter": "perp"})
                resp.raise_for_status()
                markets = resp.json().get("order_books", [])
            top = ", ".join(m["symbol"] for m in markets[:20])
            await message.answer(f"Рынков всего: {len(markets)}\nПервые 20: {top}\n\nПолный поиск — в мини-аппе.")
        except httpx.HTTPError as e:
            await message.answer(f"Lighter API недоступен: {e}")

    @dp.message(Command("predict"))
    async def cmd_predict(message: "Message"):
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{WAKE_BACKEND}/predict/markets")
                resp.raise_for_status()
                markets = resp.json()
            if not markets:
                await message.answer("Открытых Predict-рынков пока нет.")
                return
            lines = [f"• {m['question']} — {m['price_yes']*100:.0f}% YES" for m in markets[:10]]
            await message.answer("Открытые рынки:\n" + "\n".join(lines), reply_markup=_miniapp_keyboard())
        except httpx.HTTPError as e:
            await message.answer(f"Backend недоступен: {e} (запущен ли backend/app.py?)")

    @dp.message(F.text)
    async def fallback(message: "Message"):
        await message.answer("Не понял. /start — список команд.")


async def main():
    if bot is None:
        raise RuntimeError("aiogram не установлен — pip install aiogram")
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN не задан — получи у @BotFather")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
