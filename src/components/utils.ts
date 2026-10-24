import type { OrderBook } from "../lib/lighter";
import type { MarketCategory } from "./types";
import { FOREX_SYMBOLS, COMMODITY_SYMBOLS, STOCK_SYMBOLS } from "./types";

// Ни один форматтер не показывает "NaN": в таблице чисел это не «нет данных», а
// значение, которое выглядит как настоящее. Причина появления NaN конкретна —
// очищенное поле number() даёт Number("") = 0, а "1e" или "-" дают NaN, и NaN
// проходит через Math.max(0, NaN) = NaN прямо в разметку.
const NOT_A_NUMBER = "—";

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

export function fmt(n: number, d = 0): string {
  const v = finite(Number(n));
  if (v === null) return NOT_A_NUMBER;
  return v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

const AVATAR_COLORS = ["#06b6d4", "#8b5cf6", "#f59e0b", "#10b981", "#0ea5e9", "#f43f5e"];

// Один и тот же handle — один и тот же цвет в Discover, «Моих подписках» и
// модалке копирования, без состояния на лидере. Значение — цвет, а не имя
// класса Tailwind: три из четырёх мест красят аватар через style={{ background }},
// куда «bg-cyan-500» не применим — браузер отбрасывал невалидное значение, и
// аватар был прозрачным кругом с белой буквой.
export function avatarColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function shortHandle(handle: string): string {
  return handle.replace(/^@/, "").slice(0, 1).toUpperCase();
}

export function usd(n: number, d = 0): string {
  const v = finite(Number(n));
  if (v === null) return NOT_A_NUMBER;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${fmt(Math.abs(v), d)}`;
}

// Три ниже — те же правила, что в backend/telegram_bot.py (fmt_usd / fmt_price /
// fmt_pct). Одна и та же сумма обязана читаться одинаково в Telegram и в браузере:
// две версии правил расходятся на первом же пограничном значении, и $1,500,
// показанное как "$2K", — это уже случавшееся здесь вранье на треть.

// К/M/B-полосы: обороты за 24ч — это сотни миллионов, и "847828634" в таблице
// не читается.
export function fmtUsdCompact(value: number): string {
  const v = finite(value);
  if (v === null) return NOT_A_NUMBER;
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`.replace(".0K", "K");
  return `$${fmt(v, 2)}`;
}

// Знаков после запятой — по величине цены, и хвостовые нули срезаются: 3.5000
// показывать как "3.5", иначе колонка цен втрое шире без всякой дополнительной
// точности.
export function fmtPrice(value: number): string {
  const v = finite(value);
  if (v === null) return NOT_A_NUMBER;
  if (v >= 1000) return fmt(v, 2);
  const digits = v >= 1 ? 4 : 6;
  return v.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

// Знак обязателен и у положительных: в столбце изменения "-0.20%" рядом с
// "0.20%" не читается как рост против падения.
export function fmtPct(fraction: number): string {
  const v = finite(fraction);
  if (v === null) return NOT_A_NUMBER;
  const pct = (v * 100).toFixed(2);
  return `${v >= 0 ? "+" : ""}${pct}%`;
}

export function categorizeMarket(m: OrderBook): MarketCategory {
  if (m.market_type === "spot") return "Spot";
  if (FOREX_SYMBOLS.has(m.symbol)) return "Forex";
  if (COMMODITY_SYMBOLS.has(m.symbol)) return "Commodities";
  if (STOCK_SYMBOLS.has(m.symbol)) return "Stocks";
  return "Crypto";
}
