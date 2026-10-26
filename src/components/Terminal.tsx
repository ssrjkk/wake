import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Search } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import { getCandles, getRecentTrades, getFundingRates, getApiHost, placeOrderViaSigningService, type LighterNetwork, type OrderBook, type Candle, type Trade } from "../lib/lighter";
import { SIGNING_SERVICE_URL } from "../lib/config";
import { errorText } from "../lib/backend";
import { fmt, usd } from "./utils";
import { Modal, Skeleton } from "./ui";

interface TerminalProps {
  asset: string;
  setAsset: (asset: string) => void;
  markets: OrderBook[];
  dataError: string | null;
  setToast: (toast: string | null) => void;
  isCopyable: boolean;
  copySwitchBusy: boolean;
  toggleCopyable: () => void;
  setMarketPickerOpen: (open: boolean) => void;
  network: LighterNetwork;
  accountEquityUsd?: number;
}

/* Сколько строк списка обеспечено живыми ценами. Каждая строка — один запрос
   свечей (публичного «тикера сразу по всем рынкам» у Lighter нет: /tickers и
   /markets отвечают 403). 12 — тот же порядок, что у /markets/overview на
   бэкенде, который считает оборот по 24 часовым свечам. */
const TICKER_ROWS = 12;
const TICKER_TTL_MS = 60_000;

type Ticker = { price: number; changePct: number | null; volume24h: number };

// Кэш на уровне модуля: список перерисовывается при поиске, и без него каждый
// скролл заново спрашивал бы Lighter по тем же рынкам.
const tickerCache = new Map<number, { at: number; value: Ticker | null }>();

async function getTicker(marketId: number): Promise<Ticker | null> {
  const hit = tickerCache.get(marketId);
  if (hit && Date.now() - hit.at < TICKER_TTL_MS) return hit.value;
  try {
    const candles = await getCandles(marketId, "1h", 24);
    if (!candles.length) {
      tickerCache.set(marketId, { at: Date.now(), value: null });
      return null;
    }
    const last = candles[candles.length - 1];
    const first = candles[0];
    const value: Ticker = {
      price: last.c,
      changePct: first.o ? (last.c - first.o) / first.o : null,
      volume24h: candles.reduce((sum, c) => sum + c.V, 0),
    };
    tickerCache.set(marketId, { at: Date.now(), value });
    return value;
  } catch {
    // Просроченный ответ не должен выбивать цены из всего списка: строка
    // остаётся с прочерком и обновится на следующем витке.
    return null;
  }
}

// Ответ GET /health сервиса подписи. Спрашиваем его ТОЛЬКО по действию
// пользователя: сервис живёт на машине самого человека, и запрос к нему при
// каждой загрузке вкладки даёт красную строку в консоли там, где человек ничего
// не просил, а из публичного источника такой запрос к localhost дополнительно
// режет ещё и браузер (Private Network Access).
async function probeSigner(): Promise<boolean> {
  try {
    const res = await fetch(`${SIGNING_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const pct = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`);

export default function Terminal({ asset, setAsset, markets, dataError, setToast, isCopyable, copySwitchBusy, toggleCopyable, setMarketPickerOpen, network, accountEquityUsd }: TerminalProps) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);
  const [searchQuery, setSearchQuery] = useState("");
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [candlesPending, setCandlesPending] = useState(true);
  const [tradesPending, setTradesPending] = useState(true);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [showOrderConfirm, setShowOrderConfirm] = useState(false);
  const [orderSending, setOrderSending] = useState(false);
  const [lastCandlesUpdate, setLastCandlesUpdate] = useState<Date | null>(null);
  const [lastTradesUpdate, setLastTradesUpdate] = useState<Date | null>(null);
  const [tickers, setTickers] = useState<Record<number, Ticker | null>>({});
  const [nonce, setNonce] = useState(0);
  /* Тик: куда и сколько раз изменилась цена. Нужен состоянием, а не выводом из
     свечей при рендере — иначе анимация вспыхивала бы на каждой перерисовке
     страницы, а не на смене числа. */
  const [tick, setTick] = useState<{ dir: "up" | "down" | null; serial: number }>({ dir: null, serial: 0 });
  const lastTick = useRef<{ id: number; price: number } | null>(null);
  // null — «ещё не проверяли»: чип не врет «недоступно» до первого вопроса.
  const [signerUp, setSignerUp] = useState<boolean | null>(null);
  const [signerBusy, setSignerBusy] = useState(false);

  const currentMarket = markets.find((m) => m.symbol === asset);
  const marketId = currentMarket?.market_id;
  const candlesLoading = marketId != null && candlesPending;
  const tradesLoading = marketId != null && tradesPending;
  const isSpot = currentMarket?.market_type === "spot";

  const filteredMarkets = useMemo(() => {
    if (!searchQuery.trim()) return markets;
    const q = searchQuery.toUpperCase();
    return markets.filter((m) => m.symbol.toUpperCase().includes(q));
  }, [markets, searchQuery]);

  /* Порядок рельса — по номеру рынка, а не «как вернула книга». Замер живого
     /orderBooks (mainnet, 2026-10-24): три подряд запроса отдают те же 214
     активных перпов в разном порядке, BTC — на 14, 207 и 58 месте. Без
     сортировки список перетасовывался на каждом 15-секундном опросе, и строка,
     за которой следят, уезжала из-под курсора. Выбранный рынок ставим первым,
     если он в видимые строки не попал: иначе на экране «BTC», а в списке его
     нет, и вернуться к нему можно только поиском. */
  const visibleMarkets = useMemo(() => {
    const sorted = [...filteredMarkets].sort((a, b) => a.market_id - b.market_id);
    const index = sorted.findIndex((m) => m.symbol === asset);
    if (index >= TICKER_ROWS) sorted.unshift(sorted.splice(index, 1)[0]);
    return sorted.slice(0, TICKER_ROWS);
  }, [filteredMarkets, asset]);

  const visibleIds = useMemo(
    () => visibleMarkets.map((m) => m.market_id).join(","),
    [visibleMarkets]
  );

  useEffect(() => {
    if (marketId == null) return;
    const id = marketId;
    let live = true;
    function load() {
      getCandles(id, "1h", 48)
        .then((data) => {
          if (!live) return;
          const priceNow = data[data.length - 1]?.c;
          const prev = lastTick.current;
          /* Вспышка только на настоящем тике: первая загрузка рынка и ответ
             провайдера, пришедший после смены рынка, не должны притворяться
             изменением цены. */
          if (priceNow != null) {
            if (prev && prev.id === id && prev.price !== priceNow) {
              const dir = priceNow > prev.price ? "up" : "down";
              setTick((t) => ({ dir, serial: t.serial + 1 }));
            }
            lastTick.current = { id, price: priceNow };
          }
          setCandles(data);
          setCandlesError(null);
          setLastCandlesUpdate(new Date());
        })
        .catch((e) => { if (live) setCandlesError(errorText(e)); })
        .finally(() => { if (live) setCandlesPending(false); });
    }
    load();
    const timer = setInterval(load, 20000);
    return () => { live = false; clearInterval(timer); };
  }, [marketId]);

  useEffect(() => {
    if (marketId == null) return;
    let live = true;
    function load() {
      getRecentTrades(marketId!, 16)
        .then((data) => {
          if (!live) return;
          setTrades(data);
          setTradesError(null);
          setLastTradesUpdate(new Date());
        })
        .catch((e) => { if (live) setTradesError(errorText(e)); })
        .finally(() => { if (live) setTradesPending(false); });
    }
    load();
    const id = setInterval(load, 4000);
    return () => { live = false; clearInterval(id); };
  }, [marketId]);

  useEffect(() => {
    if (marketId == null) return;
    let live = true;
    getFundingRates()
      .then((rows) => {
        if (!live) return;
        const row = rows.find((r) => r.market_id === marketId && r.exchange === "lighter");
        setFundingRate(row?.rate ?? null);
      })
      .catch(() => { if (live) setFundingRate(null); });
    return () => { live = false; };
  }, [marketId]);

  // Цены списка: только видимые строки, с кэшем и общим витком на 60 секунд.
  useEffect(() => {
    const ids = visibleIds ? visibleIds.split(",").map(Number) : [];
    let live = true;
    for (const id of ids) {
      void getTicker(id).then((value) => {
        if (live) setTickers((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }));
      });
    }
    return () => { live = false; };
  }, [visibleIds, nonce]);

  // Сервис подписи спрашивает человек (кнопка-чип) или путь ордера при
  // подтверждении: локальный процесс могут поднять через минуту после того, как
  // страница всё показала, и к этому моменту ответ должен быть свежим.
  async function checkSigner() {
    setSignerBusy(true);
    try {
      setSignerUp(await probeSigner());
    } finally {
      setSignerBusy(false);
    }
  }

  useEffect(() => {
    const id = setInterval(() => setNonce((n) => n + 1), TICKER_TTL_MS);
    return () => clearInterval(id);
  }, []);

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle?.c ?? null;
  /* Окно изменения — те же последние 24 часовые свечи, что и подписи «Макс/Мин
     24ч» ниже, а не весь ряд: 48 свечей это двое суток, и «+8,4% / 24ч» при
     настоящем суточном ходе в 3% — это не округление, а другая цифра. На новом
     рынке свечей меньше 24, и подпись адаптируется по фактическому числу. */
  const windowStart = candles[Math.max(0, candles.length - 24)];
  const windowHours = Math.min(candles.length, 24);
  const change = lastCandle && windowStart && candles.length >= 2
    ? (lastCandle.c - windowStart.o) / windowStart.o
    : null;
  const up = (change ?? 0) >= 0;
  const chartData = candles.map((c, i) => ({ i, t: c.t, v: c.c }));

  const timeTicks = useMemo(() => {
    if (candles.length < 2) return [];
    // Три метки, не четыре: подписи стоят по центру своей точки, и на 390px
    // ширина поля под график ≈ 250px, где четыре метки «21.10 17:00» уже лепились
    // друг к другу. Четыре метки на десктопе читались так же, а на телефоне —
    // ничто.
    const n = Math.min(3, candles.length);
    return Array.from({ length: n }, (_, k) => candles[Math.round((k * (candles.length - 1)) / (n - 1))].t);
  }, [candles]);

  const multiDay = (candles[candles.length - 1]?.t ?? 0) - (candles[0]?.t ?? 0) > 86_400_000;
  // Окно цены с запасом 15% от диапазона: без него recharts берёт [0, max],
  // и кривая при 80k прилипает к верху.
  const priceDomain = useMemo<[number, number]>(() => {
    if (candles.length < 2) return [0, 1];
    const values = candles.map((c) => c.c);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = Math.max((max - min) * 0.15, max * 0.0005);
    return [min - pad, max + pad];
  }, [candles]);
  const two = (n: number) => String(n).padStart(2, "0");
  const tickTime = (t: number) => {
    const d = new Date(t);
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return multiDay ? `${two(d.getDate())}.${two(d.getMonth() + 1)} ${hm}` : hm;
  };

  const stats24h = useMemo(() => {
    if (candles.length < 2) return null;
    const last24 = candles.slice(-24);
    return {
      high: Math.max(...last24.map((c) => c.h)),
      low: Math.min(...last24.map((c) => c.l)),
      volume: last24.reduce((s, c) => s + c.V, 0),
      // Сколько часов реально покрыто. Новый рынок отдаёт меньше 24 свечей, и
      // подпись «24ч» над суммой за 6 часов — это не округление, а другая цифра.
      hours: last24.length,
    };
  }, [candles]);

  /* Лента тиков: величина часа относительно максимального хода в окне. Берётся
     из тех же 48 свечей, что и график, — отдельных запросов лента не делает.
     Степень 0.7, а не линейная доля: один час с ходом в 3% на линейной шкале
     прижимает остальные к нулю, и «как шёл день» перестаёт читаться; в чистом
     квадрате наоборот — тихие часы кричат так же, как громкие. */
  const tape = useMemo(() => {
    if (candles.length < 2) return [];
    const mags = candles.map((c) => Math.abs(c.c - c.o));
    const max = Math.max(...mags);
    return mags.map((m, i) => ({
      height: max > 0 ? Math.max(0.08, Math.pow(m / max, 0.7)) : 0.5,
      up: candles[i].c >= candles[i].o,
      current: i === mags.length - 1,
    }));
  }, [candles]);

  const tapeLabel = useMemo(() => {
    if (!tape.length || !lastCandle) return null;
    const hour = lastCandle.c - lastCandle.o;
    // Делить на открытие часа можно, только если открытие есть: на (o || 1)
    // рынок с ценой в доли доллара получал выдуманное «+0.16%» вместо правдивого
    // «неизвестно» — и отличить это от настоящего числа было нельзя.
    const pctHour = lastCandle.o > 0 ? Math.abs((hour / lastCandle.o) * 100) : null;

    return `Ход цены по часам: ${tape.length} шт, последний час ${
      hour >= 0 ? "рост" : "падение"
    } на ${pctHour == null ? "неизвестно (нет открытия часа)" : `${fmt(pctHour, 2)}%`}`;
  }, [tape, lastCandle]);

  const maxVolume = visibleMarkets.reduce((acc, m) => Math.max(acc, tickers[m.market_id]?.volume24h ?? 0), 0);
  /* Полоса оборота — логарифм, а не доля от максимума: обороты видимых рынков
     расходятся на порядки, и на линейной шкале у половины списка полоса была бы
     нулевой. Порядок сохраняется, пропорция нет — поэтому это ранг
     ликвидности, а не «сколько процентов от лидера». */
  const volRank = (v: number) => (v > 0 && maxVolume > 0 ? Math.log1p(v) / Math.log1p(maxVolume) : 0);

  const liqPrice = useMemo(() => {
    if (price == null) return null;
    const dist = price * (1 / Math.max(leverage, 1)) * 0.9;
    return side === "long" ? price - dist : price + dist;
  }, [price, leverage, side]);

  const decimals = currentMarket?.supported_price_decimals ?? 2;

  function requestOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    if (!(size > 0)) {
      setToast("Размер ордера должен быть больше нуля");
      return;
    }
    // Под плечом залог не size, а size/плечо — ровно то, что показывает строка
    // «Маржа» ниже. Прежняя проверка size > equity отвергала законные ордера:
    // $3000 нотионала при $1000 баланса на 5x — это $600 маржи, и она проходит,
    // а отказ выглядел как сломанный терминал.
    const margin = size / Math.max(leverage, 1);
    if (accountEquityUsd !== undefined && margin > accountEquityUsd) {
      setToast(
        `Маржа $${margin.toFixed(0)} не влезает в баланс счёта $${accountEquityUsd.toFixed(0)} — уменьши размер или плечо`
      );
      return;
    }
    const minQuote = Number(currentMarket.min_quote_amount);
    if (minQuote > 0 && size < minQuote) {
      setToast(`Минимальный ордер по этому рынку — ${minQuote} USDC`);
      return;
    }
    // Перед подтверждением переспрашиваем сервис подписи: если человек поднял
    // его уже после загрузки страницы, прошлый «недоступно» не должен его
    // блокировать, а «доступно» прошлой проверки не гарантирует, что процесс не
    // умер минуту назад.
    void checkSigner();
    setShowOrderConfirm(true);
  }

  async function placeOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    setShowOrderConfirm(false);
    setOrderSending(true);
    // Адрес сервиса в тосте не печатаем: на продакшен-сайте это выглядит как
    // отладочная строчка, а человек, который его настраивал, видит адрес в
    // подсказке чипа «подписание».
    setToast("Отправляю на сервис подписи…");
    try {
      const result = await placeOrderViaSigningService(currentMarket, side, size, price);
      setSignerUp(true);
      if (result.dry_run) {
        setToast("Сервис подписи работает в сухом режиме: ордер в Lighter не ушёл");
        return;
      }
      setToast(`Ордер отправлен: ${result.tx_hash}`);
    } catch (e) {
      // TypeError — это «запрос не дошёл»: сервис не запущен, источник не в его
      // CORS-списке, или сети нет. Ошибка с HTTP-кодом означает обратное —
      // сервис жив и сам объяснил отказ, и вешать на него «недоступен» значило
      // бы отправить человека искать причину не там.
      const unreachable = e instanceof TypeError;
      setSignerUp(!unreachable);
      setToast(
        unreachable
          ? `Ордер не отправлен: сервис подписи не отвечает. Адрес и причину показывает чип «подписание».`
          : `Ордер не отправлен: ${errorText(e)}`
      );
    } finally {
      setOrderSending(false);
    }
  }

  const stamp = (d: Date | null) => (d ? d.toLocaleTimeString("ru-RU", { hour12: false }) : "—");
  const lineColor = up ? "var(--up)" : "var(--down)";
  /* Пока не ответила сама книга, свечей просить не у чего: рынок не выбран.
     Причина тогда общая — dataError, а не ошибка несуществующего запроса. */
  const chartError = candles.length ? null : candlesError ?? (currentMarket ? null : dataError);

  return (
    <div className="terminal-layout">
      <div className="terminal-main">
        {/* ── Строка рынка ─────────────────────────────────────────────── */}
        <div className="terminal-asset-header">
          <button className="desk-symbol" aria-label="Выбрать рынок" onClick={() => setMarketPickerOpen(true)}>
            <span className="desk-symbol-name">{asset}</span>
            <span className="chip">{currentMarket?.market_type ?? "—"}{currentMarket ? ` · #${currentMarket.market_id}` : ""}</span>
          </button>

          <div className="desk-quote">
            <span
              key={tick.serial}
              className={`desk-price${tick.dir ? ` tick-${tick.dir}` : ""}`}
            >
              {price == null ? "—" : `$${fmt(price, decimals)}`}
            </span>
            <span className={`chip ${change == null ? "" : up ? "chip-up" : "chip-down"}`}>
              {change == null ? "нет закрытий" : `${pct(change)} / ${windowHours}ч`}
            </span>
          </div>

          <div className="desk-stats">
            <div className="desk-stat">
              <span className="label">Макс {stats24h ? `${stats24h.hours}ч` : "24ч"}</span>
              <b>{stats24h ? fmt(stats24h.high, decimals) : "—"}</b>
            </div>
            <div className="desk-stat">
              <span className="label">Мин {stats24h ? `${stats24h.hours}ч` : "24ч"}</span>
              <b>{stats24h ? fmt(stats24h.low, decimals) : "—"}</b>
            </div>
            <div className="desk-stat">
              <span className="label">Оборот {stats24h ? `${stats24h.hours}ч` : "24ч"}</span>
              <b>{stats24h ? usd(stats24h.volume, 0) : "—"}</b>
            </div>
            <div className="desk-stat">
              <span className="label">Funding</span>
              <b>{fundingRate == null ? "нет ставки" : `${(fundingRate * 100).toFixed(4)}%/ч`}</b>
            </div>
          </div>

          {/* Лента — последняя в потоке: на узком экране числа должны вестись
              первыми, а полоса хода дорисковывается под них. */}
          {tape.length > 1 && (
            <div className="desk-tape" role="img" aria-label={tapeLabel ?? "Ход цены по часам"}>
              {tape.map((b, i) => (
                <span
                  key={i}
                  className={`tape-bar ${b.current ? "current" : b.up ? "up" : "down"}`}
                  style={{ height: `${Math.round(b.height * 100)}%`, animationDelay: `${Math.min(i * 5, 220)}ms` }}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── График ───────────────────────────────────────────────────── */}
        <div style={{ background: "var(--bg-1)", position: "relative", minHeight: "260px" }}>
          <div className="panel-caption">
            <span className="label">Свечи 1ч · 48 шт · Lighter</span>
            <span className="num muted">обновлено {stamp(lastCandlesUpdate)}</span>
          </div>

          {candlesLoading && candles.length === 0 ? (
            <div className="desk-chart" style={{ padding: "16px 14px" }}><Skeleton height="100%" /></div>
          ) : chartError ? (
            <div className="empty-state desk-chart" style={{ border: "none", justifyContent: "center" }}>
              <p style={{ color: "var(--down)", fontSize: "13px", margin: 0 }}>Lighter API не отвечает</p>
              <p style={{ color: "var(--fg-3)", fontSize: "12px", margin: 0 }}>{getApiHost()} — {chartError}</p>
            </div>
          ) : (
            <div className="desk-chart chart-wipe" key={`chart-${asset}`}>
            <ResponsiveContainer width="100%" height="100%" minWidth={200} minHeight={200}>
              {/* Отступ слева — под половину ширины первой подписи оси: метки
                  стоят по центру своей точки, и на 30px «21.10 01:00» обрезалось
                  по «1.10 01:00». */}
              <AreaChart data={chartData} margin={{ top: 26, right: 30, bottom: 18, left: 42 }}>
                <defs>
                  <linearGradient id="deskFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={lineColor} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--line)" strokeDasharray="0" vertical={false} />
                <XAxis
                  dataKey="t"
                  ticks={timeTicks}
                  tickFormatter={tickTime}
                  stroke="var(--line)"
                  tick={{ fill: "var(--fg-3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  tickLine={false}
                  axisLine={{ stroke: "var(--line)" }}
                  interval={0}
                  tickMargin={8}
                />
                <YAxis
                  orientation="right"
                  width={72}
                  domain={priceDomain}
                  tickFormatter={(v: number) => fmt(v, decimals)}
                  stroke="var(--line)"
                  tick={{ fill: "var(--fg-3)", fontSize: 10, fontFamily: "var(--font-mono)" }}
                  tickLine={false}
                />
                {price != null && (
                  <ReferenceLine y={price} stroke={lineColor} strokeDasharray="3 3" strokeWidth={1} />
                )}
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const point = payload[0].payload as { t: number; v: number };
                    const d = new Date(point.t);
                    return (
                      <div className="chart-tip">
                        <b>{fmt(point.v, decimals)}</b>
                        <span>{d.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                      </div>
                    );
                  }}
                />
                <Area type="monotone" dataKey="v" stroke={lineColor} strokeWidth={1.5} fill="url(#deskFill)" isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* ── Лента сделок ─────────────────────────────────────────────── */}
        <div>
          <div className="panel-caption" style={{ background: "var(--bg-1)" }}>
            <span className="label">Лента сделок</span>
            <span className="num muted">обновлено {stamp(lastTradesUpdate)}</span>
          </div>

          <div className="table-scroll" style={{ maxHeight: "220px", overflowY: "auto", background: "var(--bg-1)" }}>
            {tradesError && trades.length === 0 ? (
              <p style={{ padding: "16px 14px", margin: 0, fontSize: "12px", color: "var(--down)" }}>{tradesError}</p>
            ) : trades.length === 0 ? (
              <p style={{ padding: "16px 14px", margin: 0, fontSize: "12px", color: "var(--fg-3)" }}>
                {tradesLoading ? "загрузка…" : chartError ? "Сделок нет: Lighter не ответил." : "Сделок в окне выборки нет."}
              </p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Цена</th>
                    <th className="right">Размер</th>
                    <th className="right">Время</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={`${t.id}-${t.timestamp}`} className="trade-row">
                      <td className="num right" style={{ color: t.isAsk ? "var(--down)" : "var(--up)", textAlign: "left" }}>
                        {fmt(t.price, decimals)}
                      </td>
                      <td className="num right" style={{ color: "var(--fg-2)" }}>{t.size}</td>
                      <td className="num right" style={{ color: "var(--fg-3)" }}>
                        {t.timestamp ? new Date(t.timestamp).toLocaleTimeString("ru-RU", { hour12: false }) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ── Правая колонка: тикет и список рынков ───────────────────────── */}
      <div style={{ background: "var(--bg-1)", display: "grid", gridTemplateRows: "auto auto minmax(0,1fr)", gap: "1px" }}>
        <div style={{ padding: "12px", display: "grid", gap: "10px" }}>
          <div className="seg" role="group" aria-label="Сторона ордера" style={{ display: "flex" }}>
            <button aria-pressed={side === "long"} onClick={() => setSide("long")} style={{ flex: 1 }}>Long</button>
            <button aria-pressed={side === "short"} onClick={() => setSide("short")} style={{ flex: 1 }}>Short</button>
          </div>

          <label htmlFor="terminal-size" className="label">Размер, USD</label>
          <input
            id="terminal-size"
            className="input-mono"
            type="number"
            min={currentMarket ? Number(currentMarket.min_quote_amount) : 1}
            value={size}
            onChange={(e) => {
              // valueAsNumber, а не Number(e.target.value): Math.max(0, NaN)
              // это NaN, и поле с NaN уходило в расчёт маржи и в ордер.
              const v = e.target.valueAsNumber;
              setSize(Number.isFinite(v) ? Math.max(0, v) : 0);
            }}
            style={{ width: "100%" }}
          />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label htmlFor="terminal-leverage" className="label">Плечо</label>
            <span className="num" style={{ fontSize: "13px", fontWeight: 600 }}>{leverage}x</span>
          </div>
          <input
            id="terminal-leverage"
            type="range"
            aria-label="Плечо"
            min="1"
            max="20"
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />

          <div className="kv">
            <span className="label">Маржа</span>
            <b className="num">{usd(size / Math.max(leverage, 1), 0)}</b>
            {!isSpot && (
              <>
                <span className="label">Ликвидация</span>
                <b className="num">{liqPrice == null ? "—" : `$${fmt(liqPrice, decimals)}`}</b>
              </>
            )}
          </div>

          <button
            onClick={requestOrder}
            disabled={orderSending || !currentMarket || price == null}
            aria-busy={orderSending}
            className="btn-action"
            style={{ background: side === "long" ? "var(--up)" : "var(--down)", color: "var(--on-accent)", opacity: orderSending || !currentMarket || price == null ? 0.45 : 1 }}
          >
            {orderSending ? "Отправка…" : !currentMarket ? "Рынок не загружен" : price == null ? "Цена недоступна" : `${side === "long" ? "Открыть long" : "Открыть short"} · ${usd(size, 0)}`}
          </button>

          <p className="fineprint">
            Ордер уходит в <code>signing_service.py</code> по цене последней свечи. Соло-режим:{" "}
            {network === "mainnet" ? "mainnet" : "testnet"}
            {accountEquityUsd != null ? `, баланс счёта ${usd(accountEquityUsd, 0)}` : ", баланс счёта не подключён"}.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => void checkSigner()}
              disabled={signerBusy}
              className={`chip ${signerBusy ? "chip-info" : signerUp === null ? "chip-info" : signerUp ? "chip-up" : "chip-warn"}`}
              style={{ cursor: signerBusy ? "default" : "pointer" }}
              title={
                `Сервис подписи: ${SIGNING_SERVICE_URL}. Он не опубликован вместе с сайтом — это локальный процесс, ` +
                "который держит твой API-ключ Lighter и спрашивает WAKE_DRY_RUN. Спрашиваем его по клику, а не при " +
                "загрузке страницы: запрос с публичного адреса на localhost браузеры дополнительно режут. " +
                "Красный чип — сервис не запущен, или этот источник не добавлен в его WAKE_CORS_ORIGINS."
              }
            >
              {signerBusy
                ? "подписание: проверяю…"
                : signerUp === null
                ? "подписание: не проверялось"
                : signerUp
                ? "подписание: отвечает"
                : "подписание: недоступно"}
            </button>
          </div>

          {/* Копи-режим — не украшение тикета, а запись в базе: publish — это
              leaders.active, по которому mirror_engine вообще видит подписки. */}
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: "10px", display: "grid", gap: "6px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span className="label">Публиковать мои сделки</span>
              <button
                onClick={toggleCopyable}
                disabled={copySwitchBusy}
                aria-pressed={isCopyable}
                aria-label="Публиковать мои сделки"
                className="btn-ghost"
                style={{ display: "flex", alignItems: "center", gap: "6px", minHeight: "var(--touch)" }}
                title={
                  isCopyable
                    ? "Выключить публикацию: строка leaders остаётся, но копи-движок перестаёт строить план по твоим сделкам"
                    : "Включить публикацию: бэкенд возьмёт индекс аккаунта Lighter из твоего подтверждённого входа"
                }
              >
                {isCopyable && <span aria-hidden="true" className="live-indicator" />}
                {copySwitchBusy ? "Записываю…" : isCopyable ? "включено" : "выключено"}
              </button>
            </div>
            <p className="fineprint">
              {isCopyable
                ? "Ты в списке лидеров: подписчики копируют каждую твою сделку пропорционально своей аллокации. Выключение останавливает зеркалирование, но не отменяет подписки."
                : "Нужен вход, подтверждённый кошельком: индекс аккаунта Lighter берётся из записи входа, а не из запроса."}
            </p>
          </div>
        </div>

        <div style={{ padding: "0 12px 10px" }}>
          <div style={{ position: "relative" }}>
            <Search style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", width: "13px", height: "13px", color: "var(--fg-3)" }} />
            <input
              aria-label="Поиск по рынку"
              className="input-mono"
              placeholder="Поиск рынка"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", paddingLeft: "28px" }}
            />
          </div>
        </div>

        <div className="markets-list">
          <div className="list-head">
            <span>Рынок</span>
            <span>Последняя</span>
            <span style={{ textAlign: "right" }}>24ч</span>
          </div>
          {dataError && markets.length === 0 ? (
            <p style={{ padding: "14px 12px", margin: 0, fontSize: "12px", color: "var(--down)" }}>{dataError}</p>
          ) : filteredMarkets.length === 0 ? (
            <p style={{ padding: "14px 12px", margin: 0, fontSize: "12px", color: "var(--fg-3)" }}>
              Ничего не найдено по «{searchQuery}».
            </p>
          ) : (
            visibleMarkets.map((m) => {
              const t = tickers[m.market_id];
              const rowUp = (t?.changePct ?? 0) >= 0;
              const share = t ? volRank(t.volume24h) : 0;
              return (
                <button
                  key={m.market_id}
                  className="desk-row"
                  style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}
                  aria-current={m.symbol === asset}
                  onClick={() => setAsset(m.symbol)}
                >
                  {t && (
                    <i
                      className="row-vol"
                      aria-hidden="true"
                      style={{ "--w": `${(share * 100).toFixed(1)}%` } as CSSProperties}
                    />
                  )}
                  <span style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                    <b className="num" style={{ color: "var(--fg)", fontWeight: 600 }}>{m.symbol}</b>
                    <span style={{ fontSize: "10px", color: "var(--fg-3)", textTransform: "uppercase" }}>{m.market_type}</span>
                  </span>
                  <span className="num" style={{ color: "var(--fg-2)" }}>{t ? fmt(t.price, m.supported_price_decimals) : "—"}</span>
                  <span className="num right" style={{ color: t ? (rowUp ? "var(--up)" : "var(--down)") : "var(--fg-3)" }}>{pct(t?.changePct ?? null)}</span>
                </button>
              );
            })
          )}
          {markets.length > TICKER_ROWS && (
            <button className="link-action list-foot" onClick={() => setMarketPickerOpen(true)}>
              Все рынки ({markets.length})
            </button>
          )}
        </div>
      </div>

      {showOrderConfirm && currentMarket && price != null && (
        <Modal label="Подтверждение ордера" onClose={() => setShowOrderConfirm(false)}>
          <div className="overlay-shell">
            <h3 className="panel-title" style={{ margin: "0 0 14px" }}>Подтверждение ордера</h3>
            <div className="kv kv-cols" style={{ marginBottom: "16px" }}>
              <span className="label">Рынок</span><b className="num">{currentMarket.symbol}</b>
              <span className="label">Сторона</span><b className="num" style={{ color: side === "long" ? "var(--up)" : "var(--down)" }}>{side === "long" ? "Long" : "Short"}</b>
              <span className="label">Размер</span><b className="num">{usd(size, 0)}</b>
              <span className="label">Цена</span><b className="num">{fmt(price, decimals)}</b>
              {!isSpot && (<><span className="label">Плечо</span><b className="num">{leverage}x</b></>)}
              <span className="label">Маржа</span><b className="num">{usd(size / Math.max(leverage, 1), 0)}</b>
            </div>
            <p className="fineprint" style={{ marginBottom: "14px" }}>
              IOC-ордер по рынку. В сухом режиме сервис считает план и не отправляет его в Lighter.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setShowOrderConfirm(false)} className="btn-ghost" style={{ flex: 1, justifyContent: "center" }}>
                Отмена
              </button>
              <button
                onClick={() => void placeOrder()}
                className="btn-action"
                style={{ flex: 1, background: side === "long" ? "var(--up)" : "var(--down)", color: "var(--on-accent)" }}
              >
                Подтвердить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
