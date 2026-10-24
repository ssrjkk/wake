"""
Telegram-бот Wake: карточки рынков, funding, Predict-рынки и кнопка на полный
интерфейс (Mini App).

Что здесь проверено, а что — нет, по частям:

  - Числа берутся из lighter_rest.py, тем же кодом, которым в этом проекте сняты
    живые ответы mainnet (orderBooks, candles, funding-rates). Сеть задаётся
    config.LIGHTER_NETWORK — бот не может смотреть в тестнет, пока сайт и
    резолюция рынков читают mainnet.
  - /funding считается в этом процессе теми же funding_arb.funding_rate_rows,
    что отдаёт GET /funding/rates на сайте. Разбор ставок живёт в одном месте
    специально: две копии разъехались бы молча, и спор «кому верить — боту или
    странице» решался бы по скриншотам. Бэкенд для funding не нужен.
  - /predict — единственный раздел, который ходит на HTTP: Predict-рынки живут в
    базе Wake, их неоткуда взять, кроме как из api/predict.py. Если бэкенда нет,
    бот так и пишет вместо пустого списка.
  - Текст-формообразователи (price_report/markets_report/predict_report/
    funding_report/sparkline) — чистые функции, прогнаны тестами на фикстурах
    ФОРМЫ живого ответа: test_telegram_bot.py.
  - Обвязка хендлеров прогоняется на двойниках Message/CallbackQuery: проверяется
    граница ошибок (источник данных молча не имеет права обрывать ответ бота) и
    порядок вызовов (callback подтверждается до долгого обращения к Lighter).
  - НЕ прогонялся отсюда сам цикл Telegram: polling требует токен от @BotFather и
    процесс 24/7. Поэтому Bot создаётся лениво в main() — модуль импортируется и
    тестируется без токена, а хендлеры остаются тонкой обвязкой над тестированными
    функциями.

Как это ложится в Telegram:

  - Команды регистрируются в меню бота при старте (set_my_commands): список
    появляется и в «/»-автодополнении, и в кнопке Menu. Без этого шага бот на
    /price физически отвечает, но узнать об этом можно только из чужого
    скриншота.
  - Ответы — HTML: заголовок и числа в моноширинном блоке, поэтому колонки
    оборотов и ставок не разъезжаются. Всё, что пришло извне (вопрос
    Predict-рынка, тикер из callback), проходит через esc().
  - Список рынков и карточка funding отдают тикеры кнопками: выбор тапом, а не
    ручным вводом. callback_data проверяется регуляркой — это поле клиент
    подставить может.
  - Обычное слово BTC / eth / BTC-USDC в чате — тот же /price: синтаксис команды
    помнить не нужно.

Запуск:
    pip install -r requirements.txt
    export TELEGRAM_BOT_TOKEN=...            # @BotFather -> /newbot
    export WAKE_MINIAPP_URL=https://...      # сайт целиком: кнопка открывает его вебвью, для Telegram нужен https
    export WAKE_BACKEND_URL=http://...       # где лежит backend/app.py (нужно только для /predict)
    python telegram_bot.py
"""

import asyncio
import datetime
import html
import logging
import re

import httpx
from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

import lighter_rest
from config import BACKEND_URL, LIGHTER_NETWORK, MINIAPP_URL, TELEGRAM_BOT_TOKEN
from funding_arb import base_asset, funding_rate_rows, venue_rate_rows

log = logging.getLogger(__name__)

WAKE_MINIAPP_URL = MINIAPP_URL
WAKE_BACKEND = BACKEND_URL

# Тикер наружу: значение приходит и из callback_data, и из текста сообщения.
# 12 символов с запасом покрывают книгу Lighter, минимальный ряд — самый
# длинный там же ("1000PEPE" начинается с цифры, поэтому первая позиция не
# обязана быть буквой). Буква внутри обязательна: "1" и "$" тикерами не считаются.
TICKER_RE = re.compile(r"(?=.*[A-Z])[A-Z0-9$]{1,12}")

# Бот создаётся в main(), а не на импорте: aiogram валидирует токен в конструкторе,
# и без TELEGRAM_BOT_TOKEN модуль не удавалось даже импортировать в тестах.
dp = Dispatcher()

BOT_COMMANDS = (
    BotCommand(command="price", description="Карточка рынка: цена, 24ч, funding"),
    BotCommand(command="markets", description="Топ перпов по обороту за 24ч"),
    BotCommand(command="funding", description="Ставки funding по годовой"),
    BotCommand(command="spread", description="Funding одного актива по всем площадкам"),
    BotCommand(command="predict", description="Predict-рынки Wake"),
    BotCommand(command="wake", description="Открыть Wake в Telegram"),
    BotCommand(command="help", description="Что бот умеет"),
)


def esc(value: object) -> str:
    """Экранирование для HTML-режима. Всё, что пришло не из форматеров чисел
    ниже, проходит отсюда: вопрос рынка набирает куратор, тикер — клиент."""
    return html.escape(str(value), quote=False)


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


_SPARK = "▁▂▃▄▅▆▇█"


def sparkline(closes: list, width: int = 24) -> str:
    """Часовые закрытия одной строкой. Плоский ряд рисуется средней чертой:
    пустая строка выглядела бы как «данных нет», хотя данные есть и они не
    менялись."""
    values = [float(c) for c in closes[-width:] if c is not None]
    if len(values) < 2:
        return ""
    lo, hi = min(values), max(values)
    if hi == lo:
        return _SPARK[len(_SPARK) // 2] * len(values)
    top = len(_SPARK) - 1
    return "".join(_SPARK[round((v - lo) / (hi - lo) * top)] for v in values)


def parse_ticker(text: str) -> str | None:
    """Тикер из ввода пользователя: «btc», «BTC-USDC», «1000PEPE» → «BTC»,
    «BTC», «1000PEPE». Непохожее на тикер — None, чтобы вызывающий мог ответить
    «не понял», а не молча искать пустой символ."""
    wanted = base_asset(text or "")
    return wanted if TICKER_RE.fullmatch(wanted) else None


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
        f"Диапазон 24ч: {fmt_price(stats['high_24h'])} – {fmt_price(stats['low_24h'])}",
        f"Открытый интерес: {fmt_open_interest(book)} базового актива",
        f"Мин. размер: {book['min_base_amount']} · шаг: {book['supported_size_decimals']} знаков",
    ]
    spark = sparkline(stats.get("closes") or [])
    if spark:
        lines.append(f"Закрытия по часам: {spark}")
    if funding is None:
        lines.append("Funding: нет ставки по этому рынку")
    else:
        # direction — это КТО платит: "long" означает, что ставку получают шорты
        # перпа (и именно так строится cash-and-carry: шорт перпа + лонг спота).
        payer = funding["direction"]
        pays = {"long": "лонги", "short": "шорты"}.get(payer, "никто")
        lines.append(
            f"Funding: {funding['rate'] * 100:.4f}%/ч (годовая ≈ "
            f"{funding['rate'] * 24 * 365 * 100:.1f}%), платят {pays}"
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


def markets_report(overview: dict, limit: int = 10, offset: int = 0) -> str:
    """Ранжирование по реальным $-оборотам за 24ч (сумма quote-объёма часовых
    свечей), а не по алфавиту и не по open interest в базовых единицах.

    Номер строки — это ранг по обороту на всей выборке, поэтому на второй
    странице он продолжается (11, 12, …), а не начинается с единицы."""
    rows = overview["rows"][offset : offset + limit]
    if not rows:
        return "Данных по рынку нет — Lighter API не ответил."
    lines = [
        f"Рынки Lighter по обороту за 24ч, места {offset + 1}–{offset + len(rows)}"
        f" из {overview['count']} ({overview['network']}):"
    ]
    for i, r in enumerate(rows, offset + 1):
        lines.append(
            f"{i:>2}. {r['symbol']:<9} {fmt_price(r['price']):>10}  "
            f"{fmt_pct(r['change_24h']):>8}  {fmt_usd(r['quote_volume_24h']):>8}"
        )
    missing = overview.get("no_market") or []
    if missing and offset == 0:
        lines.append(f"Без активного перпа: {', '.join(missing)}")
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
    return "\n".join(lines)


def funding_report(rates: list, limit: int = 10) -> str:
    """Список ставок. Строки держим короче ~58 знаков: Telegram набирает <pre>
    моноширинно и не переносит — длинная строка упирается в край пузыря и
    обрезается, а не сворачивается."""
    rows = rates[:limit]
    if not rows:
        return "Ставок funding нет — Lighter не ответил\nили все рынки платят шортам."
    lines = [
        "Funding Lighter (эпох 1 час), годовая по убыванию.",
        "Показаны рынки, где ставку получают шорты перпа:",
        "только они забираются cash-and-carry без займа.",
    ]
    for r in rows:
        lines.append(
            f"• {str(r['symbol']):<9} {r['hourly_rate'] * 100:.4f}%/ч → "
            f"{r['annualized'] * 100:.1f}% годовых · платят "
            f"{'лонги' if r['direction'] == 'long' else 'шорты'}"
        )
    return "\n".join(lines)


def spread_report(symbol: str, venues: list) -> str:
    """Ставки funding одного актива по всем площадкам, которые отдаёт Lighter.

    Разницы «спред, который можно забрать» здесь намеренно нет: интервалы выплат
    у площадок разные, и годовые из этих чисел не выводятся. Это справочный
    срез — где ставка больше, а не сколько можно заработать."""
    if not venues:
        return f"Ставок funding по {symbol} нет: ни одна площадка в ответе Lighter его не отдаёт."
    lines = [f"{symbol} — ставки funding по площадкам (справка, не спред):"]
    for v in venues:
        pays = "лонги" if v["signed_rate"] > 0 else "шорты"
        lines.append(
            f"• {str(v['venue']):<12} {v['signed_rate'] * 100:+.4f}%/эпоху · платят {pays}"
            + (f" · {v['symbol']}" if str(v.get("symbol")) != symbol else "")
        )
    lines.append("Эпохи у площадок разные, к годовой не приводим.")
    return "\n".join(lines)


def card(title: str, body: str, note: str = "") -> str:
    """Заголовок + моноширинное тело. Числа живут в <pre>: Telegram набирает их
    пропорциональным шрифтом, и без моноширинного блока колонки оборотов
    разъезжаются, а сравнение глазам по правому краю — весь смысл списка."""
    text = f"<b>{esc(title)}</b>\n<pre>{esc(body)}</pre>"
    return f"{text}\n{note}" if note else text


def miniapp_url(tab: str = "terminal", asset: str | None = None) -> str:
    """Ссылка на Mini App с нужным разделом и, если нужно, с выбранным рынком.

    Кнопка из карточки BTC должна приводить в терминал на BTC, а не в начало:
    иначе ответ бота и экран не связаны, и рынок приходится искать руками.
    Табы и тикер проверяются здесь, а не на сайте — адрес уходит в Telegram, и
    внятным он должен быть до отправки."""
    if not WAKE_MINIAPP_URL.startswith("https://"):
        return ""
    sep = "&" if "?" in WAKE_MINIAPP_URL else "?"
    url = f"{WAKE_MINIAPP_URL}{sep}tab={tab}"
    if asset and TICKER_RE.fullmatch(asset):
        url += f"&asset={asset}"
    return url


def web_app_button(
    tab: str = "terminal", asset: str | None = None
) -> InlineKeyboardButton | None:
    """Кнопка Mini App — только когда адрес https.

    Bot API отбраковывает web_app с http на валидации ответа: с дефолтным
    localhost бот падал бы с 400 на каждом сообщении с такой клавиатурой, а не
    только там, где кнопка. Лучше кнопка исчезнет, а причина попадёт в лог и в
    ответ /start."""
    url = miniapp_url(tab, asset)
    if not url:
        return None
    return InlineKeyboardButton(text="Открыть Wake", web_app=WebAppInfo(url=url))


def ticker_rows(
    symbols: list, cap: int = 8, offset: int = 0
) -> list[list[InlineKeyboardButton]]:
    """Тикеры кнопками, ровно 4 в ряду: при другом размере ряда Telegram режет
    их по ширине экрана, и на телефоне список превращается в лесенку."""
    wanted = [s for s in symbols if s and TICKER_RE.fullmatch(s)]
    wanted = wanted[offset : offset + cap]
    return [
        [
            InlineKeyboardButton(text=s, callback_data=f"p:{s}")
            for s in wanted[i : i + 4]
        ]
        for i in range(0, len(wanted), 4)
    ]


def nav_keyboard(
    top_rows: list[list[InlineKeyboardButton]] | None = None,
    tab: str = "terminal",
    asset: str | None = None,
) -> InlineKeyboardMarkup:
    """Навигация внизу каждого ответа: разделы + ссылка на полный интерфейс.
    Кнопка интерфейса ведёт в тот раздел, о котором сейчас речь, а карточка
    рынка — ещё и на сам рынок."""
    rows = list(top_rows or [])
    rows.append(
        [
            InlineKeyboardButton(text="Рынки", callback_data="c:markets"),
            InlineKeyboardButton(text="Funding", callback_data="c:funding"),
            InlineKeyboardButton(text="Predict", callback_data="c:predict"),
        ]
    )
    app = web_app_button(tab, asset)
    if app is not None:
        rows.append([app])
    return InlineKeyboardMarkup(inline_keyboard=rows)


async def _get_json(path: str) -> object:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(f"{WAKE_BACKEND}{path}")
        resp.raise_for_status()
        return resp.json()


async def price_payload(ticker: str) -> tuple[str, InlineKeyboardMarkup]:
    book = await asyncio.to_thread(find_perp, ticker)
    if book is None:
        return (
            card(
                f"{ticker}: активного перпа на Lighter нет",
                "Список того, что торгуется прямо сейчас — /markets.",
            ),
            nav_keyboard(),
        )
    market_id = int(book["market_id"])
    stats = await asyncio.to_thread(lighter_rest.get_24h_stats, market_id)
    try:
        funding = await asyncio.to_thread(lighter_rest.get_funding_rate, market_id)
    except RuntimeError:
        funding = None
    return (
        card(
            f"{ticker} · Lighter {LIGHTER_NETWORK}",
            price_report(ticker, book, stats, funding),
            "График и ордер — в веб-терминале." if app_available() else "",
        ),
        # Кнопка ведёт в терминал уже на этом рынке: смотреть карточку и потом
        # искать тот же символ в списке — два лишних тапа на каждый запрос.
        nav_keyboard(tab="terminal", asset=ticker),
    )


MARKETS_PAGE = 10


async def markets_payload(offset: int = 0) -> tuple[str, InlineKeyboardMarkup]:
    overview = await asyncio.to_thread(lighter_rest.get_market_overview)
    total = len(overview["rows"])
    offset = max(0, min(offset, max(0, total - 1)))
    page = overview["rows"][offset : offset + MARKETS_PAGE]
    rows = ticker_rows([str(r["symbol"]) for r in page], cap=MARKETS_PAGE)
    if total > MARKETS_PAGE:
        nav = []
        if offset > 0:
            nav.append(
                InlineKeyboardButton(
                    text="← назад", callback_data=f"m:{offset - MARKETS_PAGE}"
                )
            )
        if offset + MARKETS_PAGE < total:
            nav.append(
                InlineKeyboardButton(
                    text=f"ещё {min(MARKETS_PAGE, total - offset - MARKETS_PAGE)} →",
                    callback_data=f"m:{offset + MARKETS_PAGE}",
                )
            )
        if nav:
            rows.append(nav)
    return (
        card(
            f"Рынки Lighter · {LIGHTER_NETWORK}",
            markets_report(overview, MARKETS_PAGE, offset),
            "Тапни тикер — будет карточка с funding." if page else "",
        ),
        nav_keyboard(rows or None),
    )


async def funding_payload(limit: int = 10) -> tuple[str, InlineKeyboardMarkup]:
    raw = await asyncio.to_thread(lighter_rest.get_funding_rates, LIGHTER_NETWORK)
    # Те же строки, что отдаёт GET /funding/rates: разбор один на сайт и бота.
    rates = [r for r in funding_rate_rows(raw) if r["direction"] == "long"]
    rows = ticker_rows([str(r["symbol"]) for r in rates[:limit]])
    return (
        card(
            f"Funding · Lighter {LIGHTER_NETWORK}",
            funding_report(rates, limit),
            "Ставку по любой площадке можно спросить командой /spread."
            if app_available()
            else "",
        ),
        nav_keyboard(rows or None, tab="funding"),
    )


async def spread_payload(ticker: str) -> tuple[str, InlineKeyboardMarkup]:
    raw = await asyncio.to_thread(lighter_rest.get_funding_rates, LIGHTER_NETWORK)
    venues = await asyncio.to_thread(venue_rate_rows, raw, ticker)
    return (
        card(
            f"Funding {base_asset(ticker)} · площадки",
            spread_report(base_asset(ticker), venues),
        ),
        nav_keyboard(tab="funding"),
    )


async def predict_payload(status: str = "open") -> tuple[str, InlineKeyboardMarkup]:
    try:
        markets = await _get_json(f"/predict/markets?status={status}")
    except (httpx.HTTPError, ValueError) as e:
        return (
            card(
                "Predict недоступен",
                "Рынки предсказаний Wake живут в базе бэкенда, взять их больше "
                "неоткуда.\n"
                f"WAKE_BACKEND_URL = {WAKE_BACKEND}\n{type(e).__name__}: {e}",
            ),
            nav_keyboard(tab="predict"),
        )
    note = (
        "Купить долю и забрать выигрыш — в мини-аппе."
        if app_available()
        else "Купить долю — в веб-терминале."
    )
    return (
        card(f"Predict · {status}", predict_report(markets), note),
        nav_keyboard(tab="predict"),
    )


def app_available() -> bool:
    return web_app_button() is not None


def help_text() -> str:
    """Список команд собирается из BOT_COMMANDS — из того же кортежа, который
    ставится в меню Telegram. Два текста, написанные раздельно, разошлись бы в
    первый же день, когда команду добавили в меню и забыли в справке."""
    nav = (
        "Полный интерфейс — кнопкой ниже."
        if app_available()
        else "Кнопки на Mini App нет: задай WAKE_MINIAPP_URL с https — Telegram "
        "не принимает http-адрес вебвью."
    )
    commands = "\n".join(f"/{c.command:<8} {c.description}" for c in BOT_COMMANDS)
    return (
        "<b>Wake · терминал на Lighter</b>\n"
        f"<pre>{esc(commands)}</pre>"
        "Можно просто написать тикер: <code>BTC</code> или <code>eth</code>.\n"
        f"Числа — публичный REST Lighter в сети {LIGHTER_NETWORK}. Бот ничего не "
        f"выставляет и аккаунт не открывает.\n{nav}"
    )


def failure_card(stage: str, exc: BaseException) -> str:
    """Ответ пользователю на сбой источника данных.

    До этой функции хендлеры не имели границы: lighter_rest бросает RuntimeError
    на пустом ответе Lighter и на битой строке, /markets и /price падали внутри
    aiogram, и бот молчал — человек не получал ни карточки, ни причины. Формат
    карточки совпадает с остальными: тип и текст исключения это то, что человек
    может показать оператору, а «попробуй через минуту» — единственное, что он
    может сделать сам."""
    log.exception("%s: источник данных не ответил", stage)
    return card(
        f"{stage}: данные не получены",
        f"{type(exc).__name__}: {str(exc)[:200] or 'без текста ошибки'}\n"
        f"Lighter API ({LIGHTER_NETWORK}) отвечает нештатно — это сбой источника, "
        "а не «рынка нет». Попробуй через минуту.",
    )


async def safe_payload(stage: str, build) -> tuple[str, InlineKeyboardMarkup]:
    """Вызвать собирателя карточки и не дать его исключению уйти в aiogram.

    Граница намеренно одна и на уровне хендлера: внутри price_payload/funding_payload
    уже различают «данных нет» (честная пустая карточка) и «источник упал»
    (исключение), и второе должно превращаться в текст, а не в тишину."""
    try:
        return await build()
    except Exception as e:
        return failure_card(stage, e), nav_keyboard()


async def _answer(message: Message, stage: str, build) -> None:
    await message.answer_chat_action("typing")
    await message.answer(*await safe_payload(stage, build))


async def _reply(callback: CallbackQuery, stage: str, build) -> None:
    """Сначала подтвердить callback, потом считать данные.

    Порядок важен: карточка собирается секунды (18 свечных запросов на /markets),
    а Telegram живёт ответом на callback ограниченным окном. Подтверждение после
    работы давало «query is too old» и кнопку, которая ждёт крутилку до конца
    жизни сообщения, а потом не присылает ничего."""
    await callback.answer()
    if callback.message is None:
        return
    await callback.message.answer(*await safe_payload(stage, build))


@dp.message(Command("start", "help"))
async def cmd_start(message: Message):
    await message.answer(help_text(), reply_markup=nav_keyboard())


@dp.message(Command("price"))
async def cmd_price(message: Message, command: CommandObject):
    symbol = (command.args or "").strip()
    ticker = parse_ticker(symbol) if symbol else "BTC"
    if ticker is None:
        await message.answer(
            card(
                "Тикер не понятен", f"Написано: {symbol}. Жду что-то вроде BTC или ETH."
            )
        )
        return
    await _answer(message, f"Карточка {ticker}", lambda: price_payload(ticker))


@dp.message(Command("markets"))
async def cmd_markets(message: Message):
    await _answer(message, "Список рынков", markets_payload)


@dp.message(Command("funding"))
async def cmd_funding(message: Message):
    await _answer(message, "Funding", funding_payload)


@dp.message(Command("spread"))
async def cmd_spread(message: Message, command: CommandObject):
    symbol = (command.args or "").strip()
    ticker = parse_ticker(symbol) if symbol else "BTC"
    if ticker is None:
        await message.answer(
            card(
                "Тикер не понятен", f"Написано: {symbol}. Жду что-то вроде /spread BTC."
            )
        )
        return
    await _answer(message, f"Спред {ticker}", lambda: spread_payload(ticker))


@dp.message(Command("predict"))
async def cmd_predict(message: Message, command: CommandObject):
    status = (command.args or "").strip().lower()
    await _answer(
        message,
        "Predict",
        lambda: predict_payload(
            status if status in ("open", "resolved", "all") else "open"
        ),
    )


@dp.message(Command("wake"))
async def cmd_wake(message: Message):
    button = web_app_button()
    if button is None:
        await message.answer(
            card(
                "Ссылки на терминал нет",
                f"Telegram принимает только https, а WAKE_MINIAPP_URL = {WAKE_MINIAPP_URL}.",
            )
        )
        return
    await message.answer(
        card("Wake в браузере", "Кнопка открывает вебвью с этим адресом."),
        reply_markup=InlineKeyboardMarkup(inline_keyboard=[[button]]),
    )


@dp.callback_query(F.data.startswith("p:"))
async def cb_price(callback: CallbackQuery):
    ticker = parse_ticker(callback.data.removeprefix("p:"))
    if ticker is None:
        await callback.answer(
            "Кнопка из старой версии — список рынков: /markets", show_alert=True
        )
        return
    await _reply(callback, f"Карточка {ticker}", lambda: price_payload(ticker))


@dp.callback_query(F.data == "c:markets")
async def cb_markets(callback: CallbackQuery):
    await _reply(callback, "Список рынков", markets_payload)


@dp.callback_query(F.data.startswith("m:"))
async def cb_markets_page(callback: CallbackQuery):
    """Страницы списка: смещение приходит из callback_data, поэтому оно сначала
    приводится к числу — буквенный мусор не должен долетать до среза."""
    try:
        offset = max(0, int(callback.data.removeprefix("m:")))
    except ValueError:
        await callback.answer("Не понял страницу — открой /markets", show_alert=True)
        return
    await _reply(callback, "Список рынков", lambda: markets_payload(offset))


@dp.callback_query(F.data == "c:funding")
async def cb_funding(callback: CallbackQuery):
    await _reply(callback, "Funding", funding_payload)


@dp.callback_query(F.data == "c:predict")
async def cb_predict(callback: CallbackQuery):
    await _reply(callback, "Predict", predict_payload)


@dp.callback_query()
async def cb_unknown(callback: CallbackQuery):
    """Всё нераспознанное — в основном callback от клавиатур прошлой версии бота:
    они живут в чате столько, сколько живёт сообщение."""
    await callback.answer("Кнопка устарела, список команд — /start", show_alert=True)


@dp.message(F.text)
async def fallback(message: Message):
    ticker = parse_ticker(message.text or "")
    if ticker:
        await _answer(message, f"Карточка {ticker}", lambda: price_payload(ticker))
        return
    await message.answer(
        card(
            "Не знакомый запрос",
            "Бот читает команды и тикеры: /markets или BTC. Ордера он не "
            "выставляет и аккаунт не открывает — только числа из публичного API.",
        ),
        reply_markup=nav_keyboard(),
    )


async def register_commands(bot: Bot) -> None:
    """Меню команд ставится при старте, а не руками в @BotFather: иначе
    автодополнение по «/» пустое, и про команды узнают только из чужого
    скриншота. Неудача не роняет бота — polling работает и без меню."""
    try:
        await bot.set_my_commands(list(BOT_COMMANDS))
    except Exception as e:
        log.warning("команды бота не зарегистрированы: %s", e)


async def main():
    if not TELEGRAM_BOT_TOKEN:
        raise RuntimeError("TELEGRAM_BOT_TOKEN не задан — получи у @BotFather")
    if not app_available():
        log.warning(
            "WAKE_MINIAPP_URL=%s: кнопка Mini App не ставится, Telegram требует https",
            WAKE_MINIAPP_URL,
        )
    bot = Bot(
        token=TELEGRAM_BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    await register_commands(bot)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
