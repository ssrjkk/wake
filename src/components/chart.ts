import {
  type CandlestickData,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/lighter";
import { fmt } from "./utils";

/* Модель ряда живёт отдельно от панели не для порядка в файлах: компонент,
   который экспортирует ещё и функции, ломает fast refresh, а эти пять функций
   тестируются сами по себе — на них держатся подпись шкалы, точность оси и
   строка считывания, и испортить их можно молча, без единого изменения в
   разметке.

   График рисует lightweight-charts (TradingView, Apache-2.0) — библиотека, на
   которой стоят графики бирж, чей интерфейс тут эталон. Выбор по смыслу, а не
   по моде: обводка над SVG-графиком умела рисовать только линию по закрытиям, и
   подпись «Свечи 1ч» над ней была неправдой — часовой размах (high/low) во всех
   ответах Lighter есть, но на экран он не попадал. */

export type CandlePoint = CandlestickData<UTCTimestamp>;
export type VolumePoint = HistogramData<UTCTimestamp>;

/* Ряд → точки библиотеки. Время переводится в секунды: UTCTimestamp — это
   секунды, а Lighter отдаёт миллисекунды, и ряд на миллисекундах уехал бы в
   54 000 год. Дедупликация и сортировка обязательны: библиотека бросает на
   неупорядоченном ряде и на повторе времени, а порядок t — свойство
   конкретного ответа площадки, не контракт фронта. Точки с нечисловыми ценами
   отбрасываются: NaN библиотека рисует как ноль, то есть как настоящую цену,
   которой не было. */
export function shapeSeries(
  candles: Candle[],
  colors: { up: string; down: string }
): { points: CandlePoint[]; volume: VolumePoint[] } {
  const bySecond = new Map<number, Candle>();
  for (const c of candles) {
    const sec = Math.round(c.t / 1000);
    if (![c.o, c.h, c.l, c.c].every((v) => Number.isFinite(v))) continue;
    if (!bySecond.has(sec)) bySecond.set(sec, c);
  }
  const sorted = [...bySecond.entries()].sort((a, b) => a[0] - b[0]);
  return {
    points: sorted.map(([sec, c]) => ({
      time: sec as UTCTimestamp,
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
    })),
    // Оборот — в деньгах (V = quote volume), как колонка «Оборот» в шапке:
    // базовый объём (v) на разных рынках несравним, USDC-эквивалент сравним.
    // Полупрозрачный слой, а не сплошной цвет: рейка не должна перетягивать
    // внимание со свечи своего же часа.
    volume: sorted.map(([sec, c]) => ({
      time: sec as UTCTimestamp,
      value: Number.isFinite(c.V) ? c.V : 0,
      color: c.c >= c.o ? colors.up : colors.down,
    })),
  };
}

const two = (n: number) => String(n).padStart(2, "0");

/** Подпись деления шкалы времени. Полная дата печатается только на границе
 *  суток, и правило выводится из самой метки, а не из предыдущей нарисованной:
 *  при зуме набор подписей иначе съехал бы относительно того, что на экране. */
export function tickLabel(ms: number): string {
  const d = new Date(ms);
  return d.getHours() === 0 && d.getMinutes() === 0
    ? `${two(d.getDate())}.${two(d.getMonth() + 1)}`
    : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function fullTimeLabel(ms: number): string {
  const d = new Date(ms);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Сколько знаков печатает ось цены. Библиотека умеет не больше восьми, и
 *  precision обязан совпадать с minMove: decimals приходит от площадки
 *  (supported_price_decimals), то есть из ответа внешнего узла. */
export function priceFormat(decimals: number): { precision: number; minMove: number } {
  const precision = Math.min(8, Math.max(0, Math.floor(decimals) || 0));
  // Не Math.pow(10, -n): libm платформы даёт последний ULP наугад
  // (0.0001 против 0.00009999999999999999). Парсинг десятичной записи
  // обязателно округляется по IEEE одинаково везде.
  return { precision, minMove: Number(`1e-${precision}`) };
}

/** Сводка для скринридера: ряд лежит на canvas, текста в DOM у него нет. */
export function chartSummary(candles: Candle[], decimals: number): string {
  if (candles.length === 0) return "Свечей по этому рынку нет.";
  const first = candles[0];
  const last = candles[candles.length - 1];
  return (
    `Свечи 1ч, ${candles.length} шт: с ${fullTimeLabel(first.t)} по ${fullTimeLabel(last.t)}. ` +
    `Максимум ${fmt(Math.max(...candles.map((c) => c.h)), decimals)}, ` +
    `минимум ${fmt(Math.min(...candles.map((c) => c.l)), decimals)}, ` +
    `последнее закрытие ${fmt(last.c, decimals)}.`
  );
}

/* Время на шкале приходит тем же типом, что лёг в setData: ряд строится из
   UTCTimestamp, бизнес-дата в него передать невозможно. */
export function timeToMs(time: Time): number {
  return (time as UTCTimestamp) * 1000;
}
