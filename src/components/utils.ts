import type { OrderBook } from "../lib/lighter";
import type { MarketCategory } from "./types";
import { FOREX_SYMBOLS, COMMODITY_SYMBOLS, STOCK_SYMBOLS } from "./types";

export function fmt(n: number, d = 0): string {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

const AVATAR_COLORS = ["bg-cyan-500", "bg-violet-500", "bg-amber-500", "bg-emerald-500", "bg-sky-500", "bg-rose-500"];

// Same handle always gets the same colour, without storing anything on the leader.
export function avatarColor(handle: string): string {
  let h = 0;
  for (let i = 0; i < handle.length; i++) h = (h * 31 + handle.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function shortHandle(handle: string): string {
  return handle.replace(/^@/, "").slice(0, 1).toUpperCase();
}

export function usd(n: number, d = 0): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${fmt(Math.abs(n), d)}`;
}

// Три ниже — те же правила, что в backend/telegram_bot.py (fmt_usd / fmt_price /
// fmt_pct). Одна и та же сумма обязана читаться одинаково в Telegram и в браузере:
// две версии правил расходятся на первом же пограничном значении, и $1,500,
// показанное как "$2K", — это уже случавшееся здесь вранье на треть.

// К/M/B-полосы: обороты за 24ч — это сотни миллионов, и "847828634" в таблице
// не читается.
export function fmtUsdCompact(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`.replace(".0K", "K");
  return `$${fmt(value, 2)}`;
}

// Знаков после запятой — по величине цены, и хвостовые нули срезаются: 3.5000
// показывать как "3.5", иначе колонка цен втрое шире без всякой дополнительной
// точности.
export function fmtPrice(value: number): string {
  if (value >= 1000) return fmt(value, 2);
  const digits = value >= 1 ? 4 : 6;
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

// Знак обязателен и у положительных: в столбце изменения "-0.20%" рядом с
// "0.20%" не читается как рост против падения.
export function fmtPct(fraction: number): string {
  const pct = (fraction * 100).toFixed(2);
  return `${fraction >= 0 ? "+" : ""}${pct}%`;
}

export function categorizeMarket(m: OrderBook): MarketCategory {
  if (m.market_type === "spot") return "Spot";
  if (FOREX_SYMBOLS.has(m.symbol)) return "Forex";
  if (COMMODITY_SYMBOLS.has(m.symbol)) return "Commodities";
  if (STOCK_SYMBOLS.has(m.symbol)) return "Stocks";
  return "Crypto";
}
