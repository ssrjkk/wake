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
  // «.0» срезается во всех трёх полосах: $2.0M и $3.00B читаются как точность,
  // которой нет, а $2K — как круглое число, которым оно и является.
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`.replace(".00B", "B");
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`.replace(".0M", "M");
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

export type ToastVariant = "success" | "error" | "info";

// Панели вызывают setToast одной строкой — вариант не передают. От него зависят
// цвет плашки и вид вибрации в мини-аппе, то есть «понял ли человек, что его
// деньги не двинулись». Поэтому классификатор смотрит на форму фразы, а тест
// держит реальные строки приложения: фраза, расходившаяся с тем, что она
// обещает, должна быть поймана тестом, а не оказаться зелёной.
// Ошибки в этом приложении формулируются по-разному, но все они содержат либо
// отрицание («не подтвер…», «не запис…»), либо отказ («отклонил», «отказ»).
// Основания срезаются на корне: «не подтвердил» и «не подтверждён» — одна и та же
// причина, написанная в двух падежах.
const FAILURE =
  /не удалось|не отвечает|не передал|не подтвер|не подключ|не запис|не начисл|не прош|не принял|отклонил|недоступ|не выполнен|отказ|не на чём|должен быть больше|минимальный ордер|нет свечей/i;
// Совершённое действие, а не требование к человеку: «подтверждён(?!н)» не
// подхватывает «подтверждённый вход», иначе отказ войти окрасился бы зелёным.
const SUCCESS =
  /отправлен|записан|забрано|добавлен|начат|подтверждён(?!н)|успешно|вошёл|добро пожаловать|публикация (включена|выключена)/i;

export function toastVariant(message: string): ToastVariant {
  if (FAILURE.test(message)) return "error";
  if (SUCCESS.test(message)) return "success";
  return "info";
}

// ── Подписи оси цен ─────────────────────────────────────────────────────────
//
// Ось — шкала, а не отсчёт: точное значение человек видит крупным числом в
// шапке и в подсказке графика. Полное «78 901.400138» в оси — это не точность,
// а шум разряда, который к тому же не влезает в box оси: на крупном тексте
// подпись выползала за правый край экрана (ловит e2e/design-gate.spec.ts).

/** Компактная цена для оси: тысячи и миллионы читаются суффиксом, а не шестью
 *  знаками после запятой. */
export function fmtAxisPrice(value: number, decimals: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return fmt(value, decimals);
}

/** Сколько знаков после запятой может позволить себе ось.
 *
 *  `maxChars` считается от измеренной ширины подписи, поэтому ответ зависит и
 *  от шрифта рынка (decimals), и от того, насколько крупно человек читает. */
export function axisDecimals(values: number[], marketDecimals: number, maxChars: number): number {
  const digits = Math.max(0, Math.floor(marketDecimals));
  for (let d = digits; d > 0; d--) {
    const widest = Math.max(0, ...values.map((v) => fmt(v, d).length));
    if (widest <= maxChars) return d;
  }
  return 0;
}
