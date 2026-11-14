import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CandlestickData,
  HistogramData,
  MouseEventParams,
  UTCTimestamp,
} from "lightweight-charts";
import PriceChart from "./PriceChart";
import {
  chartSummary,
  fullTimeLabel,
  priceFormat,
  shapeSeries,
  tickLabel,
} from "./chart";
import { resetStubCharts, stubCharts, type StubChart } from "../test/chartStub";
import type { Candle } from "../lib/lighter";

/* Класс без контекста 2d: setup.ts подменяет только createChart, и заглушка
   записывает то, что панель отдала библиотеке. Пиксели проверяет Playwright,
   здесь проверяется ряд, шкала, линия последней цены и строка считывания. */
beforeEach(() => {
  resetStubCharts();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOUR = 3_600_000;
const MIDNIGHT = new Date(2026, 10, 13, 0, 0, 0).getTime();

function candle(hour: number, o: number, h: number, l: number, c: number, V = 1000): Candle {
  return { t: MIDNIGHT + hour * HOUR, o, h, l, c, v: 0.5, V };
}

const chart = (): StubChart | undefined => stubCharts()[0];
const seriesOf = (kind: string) => chart()?.series.find((s) => s.kind === kind);
const candleData = () => (seriesOf("Candlestick")?.data ?? []) as CandlestickData<UTCTimestamp>[];
const volumeData = () => (seriesOf("Histogram")?.data ?? []) as (HistogramData<UTCTimestamp> & { color?: string })[];
const priceLines = () => (seriesOf("Candlestick")?.priceLines ?? []) as { price: number }[];

/** Курсор над свечой: библиотека зовёт подписку сама, здесь тот же вызов идёт
 *  через act, чтобы setState успел дорисовать строку считывания. */
function hoverCandle(point: CandlestickData<UTCTimestamp> | null): void {
  const handler = chart()?.crosshair[0];
  if (!handler) throw new Error("подписки на перекрестие нет");
  const api = seriesOf("Candlestick")?.api;
  const param = {
    seriesData: new Map(point && api ? [[api, point]] : []),
    point: point ? { x: 10, y: 10 } : undefined,
  } as unknown as MouseEventParams;
  act(() => handler(param));
}

const legend = () => screen.getByRole("img").textContent ?? "";

describe("shapeSeries: ряд свечей → то, что принимает библиотека", () => {
  it("переводит время из миллисекунд в секунды", () => {
    const row = candle(0, 1, 2, 0.5, 1.5);
    // Lighter отдаёт миллисекунды, UTCTimestamp — секунды. Разница в три порядка
    // выглядит не как баг, а как пустой график.
    expect(shapeSeries([row], { up: "U", down: "D" }).points[0].time).toBe(row.t / 1000);
  });

  it("сортирует ряд и оставляет по одной точке на время", () => {
    const late = candle(5, 1, 2, 0.5, 1.5);
    const early = candle(2, 1, 2, 0.5, 1.5);
    const { points } = shapeSeries([late, early, { ...late, c: 9 }], { up: "U", down: "D" });
    expect(points.map((p) => Number(p.time))).toEqual([early.t / 1000, late.t / 1000]);
    // На повторе времени библиотека бросает, и панель падала бы целиком.
    expect(points[1].close).toBe(1.5);
  });

  it("выбрасывает свечу с нечисловой ценой", () => {
    const rows = [candle(2, 1, 2, 0.5, 1.5), candle(3, 1, Number.NaN, 0.5, 1.5)];
    expect(shapeSeries(rows, { up: "U", down: "D" }).points).toHaveLength(1);
  });

  it("кладёт в оборот деньги, а не базовый литр, и красит по направлению часа", () => {
    const rows = [candle(1, 100, 110, 99, 105, 4000), candle(2, 105, 106, 90, 92, 2500)];
    const { volume } = shapeSeries(rows, { up: "UP", down: "DOWN" });
    // v = 0.5 (базовый объём) в подписи дал бы «$0.50» там, где оборот 4000 USDC.
    expect(volume.map((v) => v.value)).toEqual([4000, 2500]);
    expect(volume.map((v) => v.color)).toEqual(["UP", "DOWN"]);
  });
});

describe("шкалы графика", () => {
  it("печатает полную дату только на границе суток", () => {
    expect(tickLabel(MIDNIGHT)).toBe("13.11");
    expect(tickLabel(MIDNIGHT + 14 * HOUR)).toBe("14:00");
    // Полдень — не граница: дата на 12:00 врала бы о часе метки.
    expect(tickLabel(MIDNIGHT + 12 * HOUR)).toBe("12:00");
  });

  it("держит знаков ровно столько, сколько у рынка", () => {
    expect(priceFormat(4)).toEqual({ precision: 4, minMove: 0.0001 });
    expect(priceFormat(0)).toEqual({ precision: 0, minMove: 1 });
    // decimals приходит из ответа площадки: вне 0…8 библиотека бросает.
    expect(priceFormat(12).precision).toBe(8);
    expect(priceFormat(-3).precision).toBe(0);
  });
});

describe("PriceChart", () => {
  const rows = [candle(10, 100, 118, 99, 105, 4000), candle(11, 105, 110, 92, 96, 2500)];

  it("кладёт весь ряд в серию свечей и в рейку оборота", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    expect(candleData()).toHaveLength(2);
    expect(volumeData()).toHaveLength(2);
    expect(candleData()[1]).toMatchObject({ high: 110, low: 92, close: 96 });
  });

  it("не рисует линию последней цены там, где ряда нет", () => {
    render(<PriceChart candles={[]} decimals={2} />);
    expect(priceLines()).toEqual([]);
    expect(screen.getByText("Свечей по этому рынку нет.")).toBeTruthy();
  });

  it("ставит линию на закрытие последней свечи и передвигает её, а не дублирует", () => {
    const { rerender } = render(<PriceChart candles={rows} decimals={2} />);
    expect(priceLines()).toHaveLength(1);
    expect(priceLines()[0].price).toBe(96);

    rerender(<PriceChart candles={[...rows, candle(12, 96, 101, 95, 99.5, 1200)]} decimals={2} />);
    expect(priceLines()).toHaveLength(1);
    expect(priceLines()[0].price).toBe(99.5);
  });

  it("держит оборот на своей шкале, а не на шкале цены", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    // Общая шкала показала бы в оси цены литры вместо долларов.
    expect(seriesOf("Histogram")?.options.priceScaleId).toBe("volume");
    expect(chart()?.scales.get("volume")?.[0]).toMatchObject({ borderVisible: false });
  });

  it("печатает в строке считывания последний час, пока курсора нет", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    expect(legend()).toContain(fullTimeLabel(rows[1].t));
    expect(legend()).toContain("105.00");
    expect(legend()).toContain("110.00");
    expect(legend()).toContain("92.00");
    expect(legend()).toContain("96.00");
    expect(legend()).toContain("$2.5K");
  });

  it("перестраивает строку считывания под свечу курсора", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    hoverCandle(candleData()[0]);
    expect(legend()).toContain(fullTimeLabel(rows[0].t));
    expect(legend()).toContain("105.00");
    expect(legend()).toContain("$4K");
  });

  it("возвращает последний час, когда курсор ушёл с ряда", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    hoverCandle(candleData()[0]);
    hoverCandle(null);
    expect(legend()).toContain("$2.5K");
  });

  it("описывает ряд словами: у полотна текста в DOM нет", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toContain("2 шт");
    expect(label).toContain("118.00");
    expect(label).toContain("92.00");
    expect(label).toContain("96.00");
  });

  it("красит закрытие часа по его же направлению", () => {
    render(<PriceChart candles={rows} decimals={2} />);
    // Последняя свеча закрылась ниже открытия: без цвета «96.00» рядом со
    // «100.00» читается как рост.
    expect(screen.getByText("96.00").className).toContain("is-down");
  });

  it("применяет знаков рынка к оси цены", () => {
    render(<PriceChart candles={rows} decimals={4} />);
    expect(seriesOf("Candlestick")?.applied).toContainEqual({
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
  });

  it("отписывается от перекрестия и снимает полотно при размонтировании", async () => {
    render(<PriceChart candles={rows} decimals={2} />);
    const created = chart();
    cleanup();
    await waitFor(() => expect(created?.removed).toBe(true));
    expect(created?.crosshair).toHaveLength(0);
  });
});

describe("chartSummary", () => {
  it("не обещает максимум там, где ряда нет", () => {
    expect(chartSummary([], 2)).toBe("Свечей по этому рынку нет.");
  });
});
