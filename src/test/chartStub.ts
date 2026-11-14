import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType } from "lightweight-charts";

/* Что записывает заглушка. Настоящий lightweight-charts рисует на canvas, а в
   jsdom контекста 2d нет: библиотека падала бы на монтировании любой панели,
   которая график не рисует. Заглушка хранит то, что в неё положили, поэтому
   тест проверяет ряд, ось и линию цены, а не «компонент не упал». Пиксели
   остаются за Playwright. */

export type StubSeries = {
  kind: SeriesType;
  options: Record<string, unknown>;
  applied: Record<string, unknown>[];
  data: unknown[];
  priceLines: Record<string, unknown>[];
  api: ISeriesApi<SeriesType>;
};

export type StubChart = {
  host: HTMLElement;
  options: Record<string, unknown>;
  applied: Record<string, unknown>[];
  series: StubSeries[];
  scales: Map<string, Record<string, unknown>[]>;
  crosshair: ((param: MouseEventParams) => void)[];
  fits: number;
  removed: boolean;
};

const created: StubChart[] = [];

export function stubCharts(): StubChart[] {
  return created;
}

export function resetStubCharts(): void {
  created.length = 0;
}

/** Один вызов createChart → одна запись в stubCharts(). Возвращается объект,
 *  по форме совпадающий с тем, что читает PriceChart; остальная часть
 *  интерфейса библиотеки панелям не нужна. */
export function createChartStub(host: HTMLElement, options: Record<string, unknown> = {}): IChartApi {
  const chart: StubChart = {
    host,
    options,
    applied: [],
    series: [],
    scales: new Map(),
    crosshair: [],
    fits: 0,
    removed: false,
  };
  created.push(chart);

  const api = {
    addSeries: (
      definition: { type: SeriesType },
      seriesOptions: Record<string, unknown> = {}
    ): ISeriesApi<SeriesType> => {
      const entry: StubSeries = {
        kind: definition.type,
        options: seriesOptions,
        applied: [],
        data: [],
        priceLines: [],
        api: null as unknown as ISeriesApi<SeriesType>,
      };
      const seriesApi = {
        setData: (data: unknown[]) => {
          entry.data = [...data];
        },
        update: (item: unknown) => {
          entry.data = [...entry.data, item];
        },
        applyOptions: (next: Record<string, unknown>) => {
          entry.applied.push(next);
        },
        createPriceLine: (line: Record<string, unknown>) => {
          entry.priceLines.push(line);
          return {
            applyOptions: (next: Record<string, unknown>) => {
              Object.assign(line, next);
            },
            price: () => Number(line.price ?? 0),
          };
        },
        removePriceLine: () => {
          entry.priceLines.length = 0;
        },
      };
      entry.api = seriesApi as unknown as ISeriesApi<SeriesType>;
      chart.series.push(entry);
      return entry.api;
    },
    applyOptions: (next: Record<string, unknown>) => {
      chart.applied.push(next);
    },
    priceScale: (scaleId: string) => ({
      applyOptions: (next: Record<string, unknown>) => {
        const list = chart.scales.get(scaleId) ?? [];
        list.push(next);
        chart.scales.set(scaleId, list);
      },
    }),
    timeScale: () => ({
      fitContent: () => {
        chart.fits += 1;
      },
    }),
    subscribeCrosshairMove: (handler: (param: MouseEventParams) => void) => {
      chart.crosshair.push(handler);
    },
    unsubscribeCrosshairMove: (handler: (param: MouseEventParams) => void) => {
      chart.crosshair = chart.crosshair.filter((h) => h !== handler);
    },
    remove: () => {
      chart.removed = true;
    },
  };
  return api as unknown as IChartApi;
}
