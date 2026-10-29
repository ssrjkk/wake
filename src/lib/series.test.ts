import { describe, expect, it } from "vitest";
import { alignHourlyReturns } from "./series";
import type { Candle } from "./lighter";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

/** Свеча с шагом ровно в час, начиная с метки `from`. */
function candles(closes: number[], from = T0): Candle[] {
  return closes.map((c, i) => ({
    t: from + i * HOUR,
    o: c,
    h: c,
    l: c,
    c,
    v: 1,
    V: 1,
  }));
}

/** Доходности сравниваются с округлением: 110/100-1 в float64 — это
 *  0.10000000000000009, и проверять ровно 0.1 значило бы требовать от
 *  вычисления того, чего оно не делает. Значение проверки — какие ЧАСЫ попали
 *  в ряд и в каком порядке, а не последние знаки мантиссы. */
const rough = (values: number[] | undefined) => (values ?? []).map((v) => Math.round(v * 1e9) / 1e9);

describe("выравнивание рядов доходности по часу", () => {
  it("сплошная сетка даёт n-1 доходность по меткам закрытия", () => {
    const got = alignHourlyReturns([{ marketId: 1, candles: candles([100, 110, 99]) }]);
    expect(got.hours).toEqual([T0 + HOUR, T0 + 2 * HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0.1, -0.1]);
  });

  it("ряды разных по истории рынков равны по длине и стоят на одних часах", () => {
    // BTC — 4 закрытия, новый листинг — 2 последних. Индексное выравнивание
    // сравнивало бы первый час листинга с первым часом BTC; здесь остаётся
    // пересечение, то есть два последних часа для обоих.
    const btc = candles([100, 200, 300, 450]);
    const newMarket = candles([50, 100], T0 + 2 * HOUR);
    const got = alignHourlyReturns([
      { marketId: 1, candles: btc },
      { marketId: 2, candles: newMarket },
    ]);
    expect(got.hours).toEqual([T0 + 3 * HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0.5]);
    expect(rough(got.returns.get(2))).toEqual([1]);
  });

  it("разрыв в сетке не превращается в часовую доходность", () => {
    // Свечи 12:00 и 14:00 — это два часа, а не один: доходность через разрыв
    // попала бы в общее окно как наблюдение за час, которого не было.
    const gap = [
      ...candles([100, 110]),
      ...candles([220], T0 + 2 * HOUR),
    ].map((c, i) => (i === 2 ? { ...c, t: T0 + 3 * HOUR } : c));
    const got = alignHourlyReturns([{ marketId: 1, candles: gap }]);
    expect(got.hours).toEqual([T0 + HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0.1]);
  });

  it("нулевое закрытие выбрасывает пару, а не превращается в -100%", () => {
    // close 0 — это отсутствующие данные: деление на него дало бы либо Infinity,
    // либо «-100 %» и волатильность, которой нет.
    const got = alignHourlyReturns([
      { marketId: 1, candles: candles([0, 100, 100]) },
      { marketId: 2, candles: candles([100, 110, 110]) },
    ]);
    // У рынка 1 жива только вторая пара (100→100), поэтому общее окно — один
    // час, а не ноль и не выдуманное наблюдение за первый час.
    expect(got.hours).toEqual([T0 + 2 * HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0]);
    expect(rough(got.returns.get(2))).toEqual([0]);
    expect(got.skipped).toEqual([]);
  });

  it("рынок без свечей попадает в skipped, общее окно не ломается", () => {
    const got = alignHourlyReturns([
      { marketId: 1, candles: candles([100, 120]) },
      { marketId: 2, candles: [] },
    ]);
    expect(got.skipped).toEqual([2]);
    expect(got.hours).toEqual([T0 + HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0.2]);
  });

  it("общего окна нет — возвращаем пустой ряд, а не выдуманные пары", () => {
    // Два рынка, у которых пересекаются только сами часы, а не пары «час → час
    // предыдущий»: считать такую корреляцию не по чему.
    const got = alignHourlyReturns([
      { marketId: 1, candles: candles([100, 110], T0) },
      { marketId: 2, candles: candles([100, 110], T0 + 5 * HOUR) },
    ]);
    expect(got.hours).toEqual([]);
    expect([...got.returns.keys()]).toEqual([1, 2]);
  });

  it("порядок свечей внутри ответа не важен", () => {
    const shuffled = [
      candles([100, 110, 121])[2],
      candles([100, 110, 121])[0],
      candles([100, 110, 121])[1],
    ];
    const got = alignHourlyReturns([{ marketId: 1, candles: shuffled }]);
    expect(got.hours).toEqual([T0 + HOUR, T0 + 2 * HOUR]);
    expect(rough(got.returns.get(1))).toEqual([0.1, 0.1]);
  });
});
