import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
} from "lightweight-charts";
import type { Candle } from "../lib/lighter";
import {
  chartSummary,
  fullTimeLabel,
  priceFormat,
  shapeSeries,
  tickLabel,
  timeToMs,
  type CandlePoint,
} from "./chart";
import { fmt, fmtUsdCompact } from "./utils";

/* Значение для случая, когда токен шкалы не прочитан (в jsdom размеров нет).
   Страховка, а не правило: рисуются значения из --fs-label. */
const LABEL_FALLBACK_PX = 10.5;

/* Свечи и оборот живут в одной панели, как на бирже: оборот прижат к нижней
   кромке своей шкалой, а шкала цены не заходит под него. */
const VOLUME_TOP = 0.78;
const PRICE_TOP_MARGIN = 0.1;
const PRICE_BOTTOM_MARGIN = 0.24;

type Theme = {
  up: string;
  down: string;
  upSoft: string;
  downSoft: string;
  line: string;
  lineStrong: string;
  surface: string;
  fg3: string;
  accent: string;
  font: string;
  labelPx: number;
};

/* Цвета и шрифт читаются из токенов темы, а не пишутся в конфиг библиотеки:
   canvas рисуется не CSS-ом, и var(--up) в него не передать. Второй причины
   нет — панелям цвет числом печатать и так запрещено. */
function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const token = (name: string) => cs.getPropertyValue(name).trim();
  const px = parseFloat(token("--fs-label"));
  return {
    up: token("--up"),
    down: token("--down"),
    upSoft: token("--up-soft"),
    downSoft: token("--down-soft"),
    line: token("--line"),
    lineStrong: token("--line-strong"),
    surface: token("--bg-1"),
    fg3: token("--fg-3"),
    accent: token("--accent"),
    font: token("--font-mono"),
    labelPx: Number.isFinite(px) && px > 0 ? px : LABEL_FALLBACK_PX,
  };
}

interface PriceChartProps {
  candles: Candle[];
  decimals: number;
}

export default function PriceChart({ candles, decimals }: PriceChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLineRef = useRef<IPriceLine | null>(null);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [cursor, setCursor] = useState<CandlePoint | null>(null);
  const [labelPx, setLabelPx] = useState(0);

  /* Размер подписи задаёт токен, а библиотека принимает числом, поэтому смену
     шкалы ловит невидимый эталон: человек может читать интерфейс крупнее, и ось
     обязана пересчитаться, а не остаться базовой. */
  const measureProbe = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const px = parseFloat(getComputedStyle(node).fontSize);
      if (Number.isFinite(px) && px > 0) setLabelPx(px);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = readTheme(host);
    setTheme(t);

    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: t.surface },
        textColor: t.fg3,
        fontFamily: t.font,
        fontSize: t.labelPx,
      },
      grid: { vertLines: { color: t.line }, horzLines: { color: t.line } },
      rightPriceScale: {
        borderColor: t.line,
        scaleMargins: { top: PRICE_TOP_MARGIN, bottom: PRICE_BOTTOM_MARGIN },
      },
      timeScale: {
        borderColor: t.line,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time) => tickLabel(timeToMs(time)),
      },
      localization: {
        locale: "ru-RU",
        timeFormatter: (time: Time) => fullTimeLabel(timeToMs(time)),
      },
      crosshair: {
        vertLine: { color: t.lineStrong, width: 1, labelBackgroundColor: t.accent },
        horzLine: { color: t.lineStrong, width: 1, labelBackgroundColor: t.accent },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
    });
    // Отдельная шкала для оборота: на общей ось цены показывала бы литры
    // вместо долларов.
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: VOLUME_TOP, bottom: 0 },
      borderVisible: false,
    });

    const onCrosshair = (param: MouseEventParams<Time>) => {
      const point = param.seriesData.get(series) as CandlePoint | undefined;
      setCursor(point?.time !== undefined ? point : null);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    chartRef.current = chart;
    candlesRef.current = series;
    volumeRef.current = volume;
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      volumeRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

  const shaped = useMemo(
    () => (theme ? shapeSeries(candles, { up: theme.upSoft, down: theme.downSoft }) : null),
    [candles, theme]
  );
  /* Пустой ряд обязан сохранять идентичность: setData и fitContent ниже
     завязаны на неё, и новый [] на каждом рендере перестилал бы график целиком
     и сбрасывал окно, которое человек выбрал сам. */
  const points = useMemo(() => shaped?.points ?? [], [shaped]);
  const volume = useMemo(() => shaped?.volume ?? [], [shaped]);

  useEffect(() => {
    const series = candlesRef.current;
    const hist = volumeRef.current;
    const chart = chartRef.current;
    if (!series || !hist || !chart || !theme) return;
    series.setData(points);
    hist.setData(volume);
    chart.timeScale().fitContent();

    const last = points[points.length - 1];
    if (!last) {
      if (priceLineRef.current) {
        series.removePriceLine(priceLineRef.current);
        priceLineRef.current = null;
      }
      return;
    }
    /* Линия последней цены — по направлению последней свечи, как чип изменения
       в шапке: две одинаковые по смыслу вещи не должны краситься по-разному. */
    const color = last.close >= last.open ? theme.up : theme.down;
    if (priceLineRef.current) {
      priceLineRef.current.applyOptions({ price: last.close, color });
    } else {
      priceLineRef.current = series.createPriceLine({
        price: last.close,
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
    }
  }, [points, volume, theme]);

  // Знаков у оси ровно столько, сколько у рынка: «78901.400138» в оси — это не
  // точность, а разряды, которых на площадке нет.
  useEffect(() => {
    candlesRef.current?.applyOptions({
      priceFormat: { type: "price", ...priceFormat(decimals) },
    });
  }, [decimals]);

  useEffect(() => {
    if (labelPx) chartRef.current?.applyOptions({ layout: { fontSize: labelPx } });
  }, [labelPx]);

  const shown = cursor ?? points[points.length - 1] ?? null;
  const time = shown ? Number(shown.time) : 0;
  const shownVolume = shown ? volume.find((v) => Number(v.time) === time)?.value ?? 0 : 0;

  return (
    <div className="price-chart" role="img" aria-label={chartSummary(candles, decimals)}>
      {/* Эталон размера подписи: по нему график меряет шкалу (см. labelPx). */}
      <span ref={measureProbe} className="axis-probe" aria-hidden="true">0</span>
      <div className="ohlc-legend">
        <span className="ohlc-time">{shown ? fullTimeLabel(time * 1000) : "—"}</span>
        <span className="ohlc-pair">
          <i>O</i>
          <b className="num">{shown ? fmt(shown.open, decimals) : "—"}</b>
        </span>
        <span className="ohlc-pair">
          <i>H</i>
          <b className="num">{shown ? fmt(shown.high, decimals) : "—"}</b>
        </span>
        <span className="ohlc-pair">
          <i>L</i>
          <b className="num">{shown ? fmt(shown.low, decimals) : "—"}</b>
        </span>
        <span className="ohlc-pair">
          <i>C</i>
          <b className={`num${shown ? (shown.close >= shown.open ? " is-up" : " is-down") : ""}`}>
            {shown ? fmt(shown.close, decimals) : "—"}
          </b>
        </span>
        <span className="ohlc-pair">
          <i>Vol</i>
          <b className="num">{shown ? fmtUsdCompact(shownVolume) : "—"}</b>
        </span>
      </div>
      {/* Хост обязан оставаться в DOM и на пустом ряду: эффект создавал chart
          по его размеру, и вместе с удалённым узлом остался бы висящий canvas. */}
      <div ref={hostRef} className="chart-host" />
      {candles.length === 0 && <p className="chart-empty">Свечей по этому рынку нет.</p>}
    </div>
  );
}
