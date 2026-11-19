import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Search } from "lucide-react";
import {
  getCandles,
  getTicker,
  getRecentTrades,
  getFundingRates,
  getOrderBookDepth,
  getApiHost,
  getSignerHealth,
  isTradeable,
  placeOrderViaSigningService,
  SignerNetworkMismatch,
  TICKER_TTL_MS,
  type LighterNetwork,
  type OrderBook,
  type OrderBookDepth,
  type Candle,
  type SignerHealth,
  type Ticker,
  type Trade,
} from "../lib/lighter";
import { SIGNING_SERVICE_URL } from "../lib/config";
import { errorText } from "../lib/backend";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { fmt, fmtUsdCompact, stamp, usd } from "./utils";
import { Modal, Skeleton } from "./ui";
import OrderBookPanel from "./OrderBookPanel";
import PriceChart from "./PriceChart";

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
   бэкенде, который считает оборот по 24 часовым свечам. Виток опроса и кэш
   принадлежат getTicker в lib/lighter.ts: там же, где живёт сеть, к ключу
   которой они привязаны. */
const TICKER_ROWS = 12;

/* Сколько часовых свечей берёт график. Подпись над графиком печатает фактическое
   число прочитанных свечей, а не эту константу: правка аргумента запроса или
   короткий хвост у нового рынка оставляли бы подпись с чужим числом — ровно та
   находка, из-за которой подпись «48 шт» уже краснела в прошлом. */
const CANDLE_COUNT = 48;

/* Сколько уровней цены показывает стакан с каждой стороны. 20 — это уже не
   «всё влезает без прокрутки»: лестница скроллится внутри панели (см.
   .book-scroll), а середина книги и баланс сторон вынесены над прокруткой,
   поэтому за best bid / best ask следят, не доходя до двадцатого уровня.
   Больше 20 нет смысла и в ответе: глубина за ними на живых рынках Lighter
   измеряется сотыми долями оборота, а 40 строк в панели никто не читает. */
const DEPTH_LEVELS = 20;

/* Виток опроса книги. Чаще свечей (20 с) и реже ленты сделок (4 с): заявки
   переставляются быстрее, чем закрывается час, но каждый виток стоит 45 КБ
   ответа — см. DEPTH_ORDERS в src/lib/lighter.ts. */
const DEPTH_POLL_MS = 5000;

// Ответ GET /health сервиса подписи. Спрашиваем его ТОЛЬКО по действию
// пользователя: сервис живёт на машине самого человека, и запрос к нему при
// каждой загрузке вкладки даёт красную строку в консоли там, где человек ничего
// не просил, а из публичного источника такой запрос к localhost дополнительно
// режет ещё и браузер (Private Network Access).
//
// Ответ нужен не для «жив/мёртв», а для двух чисел: network и dry_run. Первое
// сравнивается с сетью книги перед отправкой, второе показывает, уйдёт ли ордер
// в Lighter на самом деле.
async function probeSigner(): Promise<SignerHealth | null> {
  try {
    return await getSignerHealth();
  } catch {
    return null;
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
  const [depth, setDepth] = useState<OrderBookDepth>({ asks: [], bids: [] });
  const [depthPending, setDepthPending] = useState(true);
  const [depthError, setDepthError] = useState<string | null>(null);
  const [lastDepthUpdate, setLastDepthUpdate] = useState<Date | null>(null);
  const [tickers, setTickers] = useState<Record<number, Ticker | null>>({});
  const [nonce, setNonce] = useState(0);
  /* Тик: куда и сколько раз изменилась цена. Нужен состоянием, а не выводом из
     свечей при рендере — иначе анимация вспыхивала бы на каждой перерисовке
     страницы, а не на смене числа. */
  const [tick, setTick] = useState<{ dir: "up" | "down" | null; serial: number }>({ dir: null, serial: 0 });
  const lastTick = useRef<{ id: number; price: number } | null>(null);
  // null — «ещё не спрашивали»: чип не врёт «недоступно» до первого вопроса.
  const [signer, setSigner] = useState<SignerHealth | null>(null);
  const [signerChecked, setSignerChecked] = useState(false);
  const [signerBusy, setSignerBusy] = useState(false);

  /* Рынок, снятый с торгов, остаётся и в книге, и в лентах свечей, поэтому
     отсев стоит сделать здесь, а не в каждом месте, где из рынка что-то берут:
     через этот список идут и рельс, и тикет, и ссылка ?asset=… */
  const tradeable = useMemo(() => markets.filter(isTradeable), [markets]);

  const currentMarket = tradeable.find((m) => m.symbol === asset);
  const marketId = currentMarket?.market_id;
  const candlesLoading = marketId != null && candlesPending;
  const tradesLoading = marketId != null && tradesPending;
  const depthLoading = marketId != null && depthPending;
  const isSpot = currentMarket?.market_type === "spot";

  const filteredMarkets = useMemo(() => {
    if (!searchQuery.trim()) return tradeable;
    const q = searchQuery.toUpperCase();
    return tradeable.filter((m) => m.symbol.toUpperCase().includes(q));
  }, [tradeable, searchQuery]);

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
      getCandles(id, "1h", CANDLE_COUNT)
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
    const stopTimer = setIntervalWhenVisible(load, 20000);
    return () => { live = false; stopTimer(); };
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
    const stopTrades = setIntervalWhenVisible(load, 4000);
    return () => { live = false; stopTrades(); };
  }, [marketId]);

  useEffect(() => {
    if (marketId == null) return;
    const id = marketId;
    let live = true;
    function load() {
      getOrderBookDepth(id, DEPTH_LEVELS)
        .then((data) => {
          if (!live) return;
          setDepth(data);
          setDepthError(null);
          setLastDepthUpdate(new Date());
        })
        // Сбой витка не затирает прочитанное: заявки остаются под своим
        // временем, а не исчезают на пять секунд.
        .catch((e) => { if (live) setDepthError(errorText(e)); })
        .finally(() => { if (live) setDepthPending(false); });
    }
    /* Сбрасывать книгу при смене рынка здесь нечего: Terminal перемонтируется
       вместе с рынком (key `${network}:${asset}:${market_id}` в src/App.tsx), и
       состояние начинается с пустого листа само. Чужие заявки под новым
       заголовком — это другая цена, а не «ещё грузится», так что за отсутствие
       сброса отвечает именно key, а не этот эффект. */
    load();
    const stopDepth = setIntervalWhenVisible(load, DEPTH_POLL_MS);
    return () => { live = false; stopDepth(); };
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
  async function checkSigner(): Promise<SignerHealth | null> {
    setSignerBusy(true);
    try {
      const health = await probeSigner();
      setSigner(health);
      setSignerChecked(true);
      return health;
    } finally {
      setSignerBusy(false);
    }
  }

  useEffect(() => {
    const stopTicker = setIntervalWhenVisible(() => setNonce((n) => n + 1), TICKER_TTL_MS);
    return () => stopTicker();
  }, []);

  const lastCandle = candles[candles.length - 1];
  const price = lastCandle?.c ?? null;
  /* Окно изменения — те же последние 24 часовые свечи, что и подписи «Макс/Мин
     24ч» ниже, а не весь ряд: весь часовый ряд — это двое суток, и «+8,4% / 24ч» при
     настоящем суточном ходе в 3% — это не округление, а другая цифра. На новом
     рынке свечей меньше 24, и подпись адаптируется по фактическому числу. */
  const windowStart = candles[Math.max(0, candles.length - 24)];
  const windowHours = Math.min(candles.length, 24);
  const change = lastCandle && windowStart && candles.length >= 2
    ? (lastCandle.c - windowStart.o) / windowStart.o
    : null;
  const up = (change ?? 0) >= 0;

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
  /* Размер тоже печатается знаками площадки: «0.7500» на рынке с
   * supported_size_decimals=5 — это не округление, а потерянные два разряда,
   * и по ним как раз считается минимальный ордер (min_base_amount). */
  const sizeDecimals = currentMarket?.supported_size_decimals ?? 4;

  async function requestOrder() {
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
        `Маржа ${usd(margin, 0)} не влезает в баланс счёта ${usd(accountEquityUsd, 0)} — уменьши размер или плечо`
      );
      return;
    }
    const minQuote = Number(currentMarket.min_quote_amount);
    if (minQuote > 0 && size < minQuote) {
      setToast(`Минимальный ордер по этому рынку — ${minQuote} USDC`);
      return;
    }
    // Перед подтверждением сервис переспрашивается заново и по его ответу
    // сверяется сеть. Человек мог поднять процесс минуту назад, а мог и
    // переключить сеть в шапке, не перезапуская сервис: book рынка при этом
    // testnet-ная, а ордер подписывается mainnet-ключом.
    const health = await checkSigner();
    if (!health) {
      setShowOrderConfirm(false);
      setToast(
        "Ордер не готов: сервис подписи не отвечает. Адрес и причину показывает чип «подписание»."
      );
      return;
    }
    if (health.network !== network) {
      setToast(
        `Несовпадение сети: данные берутся из ${network}, а сервис подписи работает в ${health.network}. ` +
          "Ордер не будет отправлен — market_id и decimals относятся к другой книге."
      );
      return;
    }
    setShowOrderConfirm(true);
  }

  async function placeOrder(signerHealth: SignerHealth) {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    setShowOrderConfirm(false);
    setOrderSending(true);
    setToast("Отправляю на сервис подписи…");
    try {
      const result = await placeOrderViaSigningService(currentMarket, side, size, price, signerHealth);
      setSigner(signerHealth);
      setSignerChecked(true);
      if (result.dry_run) {
        setToast("Сервис подписи работает в сухом режиме: ордер в Lighter не ушёл");
        return;
      }
      setToast(`Ордер отправлен: ${result.tx_hash}`);
    } catch (e) {
      // Несовпадение сети — отказ до отправки, ордер точно не существует.
      // Ошибка с HTTP-кодом означает обратное: сервис жив и объяснил отказ.
      // Всё остальное (TypeError) — запрос не дошёл.
      if (e instanceof SignerNetworkMismatch) {
        setSigner({ ...signerHealth, network: e.signerNetwork });
        setToast(errorText(e, 220));
        return;
      }
      const unreachable = e instanceof TypeError;
      if (unreachable) setSigner(null);
      setToast(
        unreachable
          ? "Ордер не отправлен: сервис подписи не отвечает. Адрес и причину показывает чип «подписание»."
          : `Ордер не отправлен: ${errorText(e, 200)}`
      );
    } finally {
      setOrderSending(false);
    }
  }

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
        </div>

        {/* ── График ───────────────────────────────────────────────────── */}
        <div className="chart-panel">
          <div className="panel-caption">
            <span className="label">Свечи 1ч · Lighter</span>
            <span className="num muted">обновлено {stamp(lastCandlesUpdate)}</span>
          </div>

          {candlesLoading && candles.length === 0 ? (
            <div className="desk-chart panel-pad"><Skeleton height="100%" /></div>
          ) : chartError ? (
            <div className="empty-state desk-chart">
              <p className="panel-lead text-negative">Lighter API не отвечает</p>
              <p className="muted">{getApiHost()} — {chartError}</p>
            </div>
          ) : (
            <div className="desk-chart chart-wipe" key={`chart-${asset}`}>
              <PriceChart candles={candles} decimals={decimals} />
            </div>
          )}
        </div>

        {/* ── Стакан ───────────────────────────────────────────────────── */}
        <OrderBookPanel
          depth={depth}
          decimals={decimals}
          sizeDecimals={sizeDecimals}
          loading={depthLoading}
          error={depthError}
          unavailable={chartError}
          updated={lastDepthUpdate}
        />

        {/* ── Лента сделок ─────────────────────────────────────────────── */}
        <div>
          <div className="panel-caption">
            <span className="label">Лента сделок</span>
            <span className="num muted">обновлено {stamp(lastTradesUpdate)}</span>
          </div>

          <div className="table-scroll tape-scroll">
            {tradesError && trades.length === 0 ? (
              <p className="panel-note text-negative">{tradesError}</p>
            ) : trades.length === 0 ? (
              <p className="panel-note muted">
                {tradesLoading ? "загрузка…" : chartError ? "Сделок нет: Lighter не ответил." : "Сделок в окне выборки нет."}
              </p>
            ) : (
              <table className="data-table tape-table">
                <thead>
                  <tr>
                    <th>Цена</th>
                    <th className="right">Размер</th>
                    <th className="right">Всего</th>
                    <th className="right">Время</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={`${t.id}-${t.timestamp}`} className="trade-row">
                      <td className={`num tape-price ${t.takerBuy ? "text-positive" : "text-negative"}`}>
                        {/* Сторона держится не только на цвете (WCAG 1.4.1):
                            у символа свой знак, а диктор читает слово. */}
                        <span className="tape-side" aria-hidden="true">{t.takerBuy ? "▲" : "▼"}</span>
                        <span className="sr-only">{t.takerBuy ? "покупка" : "продажа"}</span>
                        {fmt(t.price, decimals)}
                      </td>
                      <td className="num right secondary">{fmt(t.size, sizeDecimals)}</td>
                      <td className="num right muted">{fmtUsdCompact(t.size * t.price)}</td>
                      <td className="num right muted">
                        {stamp(t.timestamp ? new Date(t.timestamp) : null)}
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
      <div className="terminal-side">
        <div className="terminal-ticket">
          <div className="seg seg-stretch" role="group" aria-label="Сторона ордера">
            <button aria-pressed={side === "long"} onClick={() => setSide("long")}>Long</button>
            <button aria-pressed={side === "short"} onClick={() => setSide("short")}>Short</button>
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
          />

          <div className="terminal-field-row">
            <label htmlFor="terminal-leverage" className="label">Плечо</label>
            <span className="stat-value">{leverage}x</span>
          </div>
          <input
            id="terminal-leverage"
            className="range"
            type="range"
            aria-label="Плечо"
            min="1"
            max="20"
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
          />

          <div className="kv">
            <span className="label">Маржа</span>
            <b className="num">{usd(size / Math.max(leverage, 1), 0)}</b>
            {!isSpot && (
              <>
                {/* Lighter не отдаёт maintenance margin в книге рынков, поэтому
                  цифра — оценка «1/плечо минус 10%», а не цена биржи. */}
              <span className="label">Ликвидация, оценка</span>
                <b className="num">{liqPrice == null ? "—" : `$${fmt(liqPrice, decimals)}`}</b>
              </>
            )}
          </div>

          <button
            onClick={() => void requestOrder()}
            disabled={orderSending || !currentMarket || price == null}
            aria-busy={orderSending}
            className={`btn-primary ${side === "long" ? "btn-up" : "btn-down"}`}
          >
            {orderSending ? "Отправка…" : !currentMarket ? "Рынок не загружен" : price == null ? "Цена недоступна" : `${side === "long" ? "Открыть long" : "Открыть short"} · ${usd(size, 0)}`}
          </button>

          <p className="fineprint">
            Ордер уходит в <code>signing_service.py</code> по цене последней свечи.{" "}
            {signer
              ? signer.network === network
                ? `Сеть сервиса: ${signer.network}, ход ${signer.dry_run ? "сухой" : "боевой"}.`
                : `Внимание: сервис подписи в сети ${signer.network}, а данные из ${network} — ордер не отправится.`
              : signerChecked
                ? "Сервис подписи не отвечает."
                : "Сервис подписи ещё не спрашивался."}
            {accountEquityUsd != null ? ` Баланс счёта ${usd(accountEquityUsd, 0)}.` : " Баланс счёта не подключён."}
          </p>

          <div className="row">
            <button
              type="button"
              onClick={() => void checkSigner()}
              disabled={signerBusy}
              className={`chip chip-btn ${signerBusy ? "chip-info" : !signerChecked ? "chip-info" : signer ? (signer.network === network ? (signer.dry_run ? "chip-info" : "chip-warn") : "chip-warn") : "chip-warn"}`}
              title={
                `Сервис подписи: ${SIGNING_SERVICE_URL}. Он не опубликован вместе с сайтом — это локальный процесс, ` +
                "который держит твой API-ключ Lighter и спрашивает WAKE_DRY_RUN. Спрашиваем его по клику, а не при " +
                "загрузке страницы: запрос с публичного адреса на localhost браузеры дополнительно режут. " +
                "Красный чип — сервис не запущен, этот источник не добавлен в его WAKE_CORS_ORIGINS, или его сеть " +
                "не совпадает с сетью книги рынков."
              }
            >
              {signerBusy
                ? "подписание: проверяю…"
                : !signerChecked
                  ? "подписание: не проверялось"
                  : !signer
                    ? "подписание: недоступно"
                    : signer.network !== network
                      ? `подписание: сеть ${signer.network} ≠ ${network}`
                      : signer.dry_run
                        ? `подписание: ${signer.network}, сухой ход`
                        : `подписание: ${signer.network}, живой ход`}
            </button>
          </div>

          {/* Копи-режим — не украшение тикета, а запись в базе: publish — это
              leaders.active, по которому mirror_engine вообще видит подписки. */}
          <div className="terminal-copy-block">
            <div className="terminal-copy-row">
              <span className="label">Публиковать мои сделки</span>
              <button
                onClick={toggleCopyable}
                disabled={copySwitchBusy}
                aria-pressed={isCopyable}
                aria-label="Публиковать мои сделки"
                className="btn-ghost"
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

        <div className="side-search">
          <div className="terminal-search">
            <Search />
            <input
              aria-label="Поиск по рынку"
              className="input-mono"
              placeholder="Поиск рынка"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="markets-list">
          <div className="list-head">
            <span>Рынок</span>
            <span>Последняя</span>
            <span>24ч</span>
          </div>
          {dataError && markets.length === 0 ? (
            <p className="panel-note text-negative">{dataError}</p>
          ) : filteredMarkets.length === 0 ? (
            <p className="panel-note muted">
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
                  <span className="row">
                    <b className="num cell-name">{m.symbol}</b>
                    <span className="label">{m.market_type}</span>
                  </span>
                  <span className="num secondary">{t ? fmt(t.price, m.supported_price_decimals) : "—"}</span>
                  <span className={`num right ${t ? (rowUp ? "text-positive" : "text-negative") : "muted"}`}>{pct(t?.changePct ?? null)}</span>
                </button>
              );
            })
          )}
          {tradeable.length > TICKER_ROWS && (
            <button className="link-action list-foot" onClick={() => setMarketPickerOpen(true)}>
              Все рынки ({tradeable.length})
            </button>
          )}
        </div>
      </div>

      {showOrderConfirm && currentMarket && price != null && signer && (
        <Modal label="Подтверждение ордера" onClose={() => setShowOrderConfirm(false)}>
          <div className="overlay-shell">
            <h3 className="panel-title">Подтверждение ордера</h3>
            <div className="kv kv-cols">
              <span className="label">Рынок</span><b className="num">{currentMarket.symbol}</b>
              <span className="label">Сторона</span><b className={`num ${side === "long" ? "text-positive" : "text-negative"}`}>{side === "long" ? "Long" : "Short"}</b>
              <span className="label">Размер</span><b className="num">{usd(size, 0)}</b>
              <span className="label">Цена</span><b className="num">{fmt(price, decimals)}</b>
              {!isSpot && (<><span className="label">Плечо</span><b className="num">{leverage}x</b></>)}
              <span className="label">Маржа</span><b className="num">{usd(size / Math.max(leverage, 1), 0)}</b>
            </div>
            <p className="fineprint">
              {/* Сеть и режим берутся из ответа самого сервиса, а не из
                  переключателя страницы: человек подтверждает именно то, куда
                  уйдёт ордер. */}
              IOC-ордер по рынку · {signer.network} ·{" "}
              {signer.dry_run ? "сервис считает план и не отправляет его в Lighter" : "ордер уйдёт в Lighter"}
              {/* POST ордера без таймаута — сознательно: оборвать по таймеру
                  запрос, который уже мог дойти, значит получить второй ордер с
                  новым индексом. Честнее сказать это здесь, чем молчать. */}
              {!signer.dry_run && " · запрос не отменяется: если сервис не ответит, ордер всё равно мог исполниться — ищи его в open orders Lighter"}
            </p>
            <div className="overlay-actions">
              <button onClick={() => setShowOrderConfirm(false)} className="btn-ghost">
                Отмена
              </button>
              <button
                onClick={() => void placeOrder(signer)}
                className={`btn-action ${side === "long" ? "btn-up" : "btn-down"}`}
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
