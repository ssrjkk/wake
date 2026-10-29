// Ряды доходности по свечам — выровненные по ЧАСУ, а не по индексу массива.
//
// Корзина риска (Risk.tsx) считает ковариацию по нескольким рынкам сразу, и
// бэкенд (portfolio_risk._aligned_tails) приводит ряды к общему хвосту по
// индексам. Это работает ровно до тех пор, пока i-й элемент у всех рынков не
// означает один и тот же час. Прежний способ — `candles.map(c => c.c)` и
// приведение на бэкенде — ломался в двух местах:
//
//   1) пропущенное наблюдение сдвигает ВСЁ, что после него: ряд строится из
//      свечей, а не из календаря, и один выброшенный час у одного рынка
//      начинает сопоставлять его часы с часом позже у остальных;
//   2) параллельные запросы к /candles могут пересечь часовой рубеж — один
//      рынок отдаёт ряд, кончающийся 13:00, сосед уже с 14:00, и «последние 30
//      значений» у них про разные сутки.
//
// Здесь ключом служит метка свечи: доходность считается только по соседним
// часам, а ряды сдаются уже по общему набору часов, поэтому индекс в них
// означает время одинаково для всех.
import type { Candle } from "./lighter";

const HOUR_MS = 3_600_000;

export type AlignedReturns = {
  /** Часовые метки общего окна по возрастанию. Пусто — значит считать нечего. */
  hours: number[];
  /** market_id → доходности ровно по тем же `hours`; длины массивов равны. */
  returns: Map<number, number[]>;
  /** Рынки без единой доступной часовой доходности (новый листинг, нет свечей). */
  skipped: number[];
};

/** Простые доходности по закрытиям, помеченные часом, к которому они относятся.
 *
 *  Метка — время ЗАКРЫТИЯ пары (более поздняя свеча): сравнение 12:00→13:00
 *  принадлежит часу 13:00. Нулевое или неконечное закрытие — отсутствующие
 *  данные, а не наблюдение: деление на него даёт Infinity, а Infinity в ряду
 *  превращает волатильность портфеля в Infinity. */
function hourlyReturns(candles: Candle[]): Map<number, number> {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const out = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const current = sorted[i];
    // Разрыв в сетке — это не часовая доходность: сравнивать закрытие 15:00 с
    // закрытием 13:00 значит выдать два часа за один.
    if (current.t - prev.t !== HOUR_MS) continue;
    if (!(prev.c > 0) || !Number.isFinite(current.c) || current.c <= 0) continue;
    out.set(current.t, current.c / prev.c - 1);
  }
  return out;
}

export function alignHourlyReturns(
  series: { marketId: number; candles: Candle[] }[]
): AlignedReturns {
  const byMarket = series.map((s) => ({
    marketId: s.marketId,
    returns: hourlyReturns(s.candles),
  }));
  const withData = byMarket.filter((m) => m.returns.size > 0);
  const skipped = byMarket.filter((m) => m.returns.size === 0).map((m) => m.marketId);

  if (withData.length === 0) return { hours: [], returns: new Map(), skipped };

  // Listwise-вырубка по часам: остаётся только то, что есть у всех. Матрица
  // корреляций, посчитанная по одной и той же выборке, полуопределена по
  // построению; набор попарных «общих хвостов» — нет.
  let hours = [...withData[0].returns.keys()].sort((a, b) => a - b);
  for (const market of withData.slice(1)) {
    hours = hours.filter((h) => market.returns.has(h));
  }

  const returns = new Map<number, number[]>();
  for (const market of withData) {
    returns.set(market.marketId, hours.map((h) => market.returns.get(h) as number));
  }
  return { hours, returns, skipped };
}
