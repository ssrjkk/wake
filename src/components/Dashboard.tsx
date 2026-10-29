import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, Percent, RefreshCw, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { getMarketOverview, type MarketOverview, type MarketOverviewRow, type OrderBook } from "../lib/lighter";
import { getMarkets as getArcusMarkets, getMidPrices, isArcusOnline, isArcusPerp, type ArcusMarket } from "../lib/arcus";
import { errorText } from "../lib/backend";
import { getPredictMarkets, predictTimeLeft, type PredictMarket } from "../lib/predict";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { fmtPrice, fmtPct, fmtUsdCompact } from "./utils";
import { Skeleton } from "./ui";
import type { Tab } from "./types";

// Бэкенд кэширует обзор на 60 секунд (backend/cache.py), поэтому крутить чаще —
// это не «свежее», а пустые запросы.
const REFRESH_MS = 60_000;
const SHOWN_BY_DEFAULT = 10;

interface DashboardProps {
  setTab: (tab: Tab) => void;
  setAsset: (asset: string) => void;
  // Книга Lighter: по ней видно, откроется ли аркусный тикер в Терминале.
  markets: OrderBook[];
}

export default function Dashboard({ setTab, setAsset, markets }: DashboardProps) {
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [arcusMarkets, setArcusMarkets] = useState<ArcusMarket[]>([]);
  const [arcusPrices, setArcusPrices] = useState<Record<string, string>>({});
  const [arcusError, setArcusError] = useState<string | null>(null);
  // null — это «ещё не загрузилось», [] — «загрузилось и рынков правда нет».
  // Одно состояние на оба случая печатало бы «Открытых рынков нет» до первого
  // ответа бэкенда, а /markets/overview стоит дорого (18 свечных запросов) и не
  // успевает до отрисовки.
  const [predict, setPredict] = useState<PredictMarket[] | null>(null);
  // Ошибка Predict — отдельным состоянием: «рынков нет» и «бэкенд не ответил» —
  // это разные вещи, и показывать первое вместо второго значит прятать поломку.
  const [predictError, setPredictError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Кнопка «обновить» меняет именно зависимость эффекта. Сбросить состояние в
  // null — это не перезагрузка: следующий запрос всё равно произошёл бы только
  // через 60 секунд, и кнопка выглядела бы рабочей, не будучи ею.
  const [nonce, setNonce] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Два независимых эффекта, а не один с двумя await подряд: обзор считается
  // секунды, и последовательное ожидание держало бы Predict пустым всё это время.
  useEffect(() => {
    let alive = true;
    getMarketOverview()
      .then((data) => {
        if (!alive) return;
        setOverview(data);
        setMarketsError(null);
        setLastUpdated(new Date());
      })
      .catch((e) => {
        if (alive) setMarketsError(errorText(e));
      });
    const stopRefresh = setIntervalWhenVisible(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      stopRefresh();
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    getPredictMarkets("open")
      .then((rows) => {
        if (!alive) return;
        setPredict(rows);
        setPredictError(null);
      })
      .catch((e) => {
        if (alive) setPredictError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    getArcusMarkets()
      .then((markets) => {
        if (!alive) return;
        setArcusMarkets(markets);
        setArcusError(null);
        return getMidPrices().then((data) => {
          if (!alive) return;
          setArcusPrices(data.mids);
        });
      })
      .catch((e) => {
        if (alive) setArcusError(errorText(e));
      });
    function pollMids() {
      getMidPrices()
        .then((data) => {
          if (!alive) return;
          setArcusPrices(data.mids);
          setArcusError(null);
        })
        .catch((error) => {
          if (alive) setArcusError(errorText(error));
        });
    }
    const stopMids = setIntervalWhenVisible(pollMids, 30000);
    return () => {
      alive = false;
      stopMids();
    };
  }, []);

  /* Тикеры Lighter по базовому активу: аркусная строка ведёт в Терминал, а тот
      ищет рынок по символу книги. Без проверки клик по «TSLA», которого на
      Lighter нет, открывал бы терминал с надписью «Рынок не загружен» —
      выглядит как поломка Терминала, а не как отсутствие инструмента. */
  const lighterSymbols = useMemo(
    () => new Set(markets.map((m) => m.symbol.toUpperCase())),
    [markets]
  );

  function openMarket(row: MarketOverviewRow) {
    // symbol — ровно то, что лежит в книге Lighter: Terminal ищет рынок по этому
    // же полю, и расхождение (base вместо symbol) открывало бы пустой терминал.
    setAsset(row.symbol);
    setTab("terminal");
  }

  // Торгующиеся рынки впереди: 6 строк из 70 в живом /v1/markets — OFFLINE, и в
  // простом срезе «первые 15» они вытесняют те, по которым что-то видно.
  // Порядок внутри группы сохраняется (sort стабилен).
  const arcusRows = useMemo(
    () => [...arcusMarkets].sort((a, b) => Number(isArcusOnline(b)) - Number(isArcusOnline(a))),
    [arcusMarkets]
  );

  const rows = overview?.rows ?? [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_BY_DEFAULT);
  const missing = [...(overview?.no_market ?? []), ...(overview?.no_data ?? [])];

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div className="panel-head-row">
            <h2 className="panel-title" style={{ fontSize: "var(--fs-heading)" }}>Рынки Lighter</h2>
            <span className="chip chip-accent">zkLighter</span>
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="btn-ghost"
              style={{ marginLeft: "auto" }}
              title="Обновить сейчас"
            >
              <RefreshCw style={{ width: "12px", height: "12px" }} /> обновить
            </button>
            {lastUpdated && (
              <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                {lastUpdated.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
          <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Перпы на zkLighter, отсортированные по фактическому $-обороту за 24 часа: оборот — сумма 24 часовых свечей по каждому
            рынку, а не поле из книги (его в /orderBooks нет). Те же строки и тот же метод, что печатает{" "}
            <code style={{ color: "var(--fg-2)", fontSize: "var(--fs-label)" }}>/markets</code> в Telegram-боте.
          </p>
        </div>

      {marketsError && (
        <div className="terminal-header" style={{ color: "var(--accent)", fontSize: "var(--fs-data)", alignItems: "flex-start" }}>
          <TriangleAlert style={{ width: "14px", height: "14px", marginTop: "2px", flexShrink: 0 }} />
          <span>
            Обзор рынка временно недоступен. Функция требует подключённый бэкенд Wake.
          </span>
        </div>
      )}

      {!overview && !marketsError ? (
        <div className="terminal-header" style={{ flexDirection: "column", gap: "8px" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} height="20px" />
          ))}
        </div>
      ) : !overview ? (
        null
      ) : rows.length === 0 ? (
        <div className="terminal-header" style={{ justifyContent: "center", padding: "40px 16px" }}>
          <div>
            <p style={{ color: "var(--fg-2)", fontSize: "var(--fs-ui)", margin: 0 }}>Ни один рынок не собрался из живых данных</p>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-label)", margin: "4px 0 0 0" }}>
              Бэкенд вернул ответ без рядов — детали в no_market / no_data ниже.
            </p>
          </div>
        </div>
      ) : (
        <div className="terminal-panel">
          <div className="table-scroll">
          <table className="data-table" style={{ minWidth: "700px" }} aria-label="Рынки Lighter">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col" className="left">Актив</th>
                <th scope="col" className="right">Цена</th>
                <th scope="col" className="right">24ч</th>
                <th scope="col" className="right">Оборот 24ч</th>
                <th scope="col" className="right" title="Ставка за часовую эпоху funding">
                  Funding, %/ч
                </th>
                <th scope="col" className="right">Годовая</th>
                <th scope="col" className="left">Платят</th>
                <th scope="col" className="right" title="Открытый интерес в единицах актива">
                  OI, баз.
                </th>
                <th scope="col" className="right">Мин. лот</th>
                <th scope="col" className="right"><span className="sr-only">Открыть</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.market_id} data-action onClick={() => openMarket(r)}>
                  <td className="muted num">{i + 1}</td>
                  <td className="left" style={{ color: "var(--fg)", fontWeight: 600 }}>{r.symbol}</td>
                  <td className="right num" style={{ color: "var(--fg)" }}>{fmtPrice(r.price)}</td>
                  <td className={`right num ${r.change_24h >= 0 ? "text-positive" : "text-negative"}`} style={{ fontWeight: 500 }}>
                    {fmtPct(r.change_24h)}
                  </td>
                  <td className="right num" style={{ color: "var(--fg-2)" }}>{fmtUsdCompact(r.quote_volume_24h)}</td>
                  <td className="right num" style={{ color: "var(--fg-2)" }}>
                    {r.funding_hourly == null ? "—" : (r.funding_hourly * 100).toFixed(4)}
                  </td>
                  <td className="right num" style={{ color: "var(--fg)", fontWeight: 500 }}>
                    {r.funding_annualized == null ? "—" : `${(r.funding_annualized * 100).toFixed(1)}%`}
                  </td>
                  <td className="left">
                    {r.funding_payer == null ? (
                      <span className="muted">нет ставки</span>
                    ) : r.funding_payer === "long" ? (
                      <span className="text-positive" style={{ fontWeight: 500 }}>лонги</span>
                    ) : r.funding_payer === "short" ? (
                      <span className="text-negative" style={{ fontWeight: 500 }}>шорты</span>
                    ) : (
                      <span className="muted">никто (0%)</span>
                    )}
                  </td>
                  <td className="right num" style={{ color: "var(--fg-2)" }}>
                    {r.open_interest_base > 0 ? r.open_interest_base.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                  </td>
                  <td className="right num" style={{ color: "var(--fg-2)" }}>
                    {r.min_base_amount > 0 ? r.min_base_amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                  </td>
                  <td className="right">
                    {/* Ряд открывается и мышью, и клавиатурой: `data-action` даёт
                        строке курсор, но с клавиатуры рынок иначе не открыть. */}
                    <button
                      className="row-open"
                      aria-label={`Открыть ${r.symbol} в Терминале`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openMarket(r);
                      }}
                    >
                      <ArrowRight style={{ width: "12px", height: "12px" }} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="panel-foot">
            <span>
              сеть {overview?.network} · рядов {rows.length}
            </span>
            {rows.length > SHOWN_BY_DEFAULT && (
              <button
                onClick={() => setShowAll((v) => !v)}
                className="link-action"
                style={{ fontSize: "inherit" }}
              >
                {showAll ? "свернуть" : `показать все ${rows.length}`}
              </button>
            )}
            {missing.length > 0 && <span style={{ color: "var(--fg-2)" }}>без данных: {missing.join(", ")}</span>}
          </div>
        </div>
      )}

      <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "var(--fs-heading)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Рынки Arcus</h2>
          <span className="chip chip-up">Robinhood Chain</span>
          {arcusError && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--fs-label)", color: "var(--accent)" }}>
              <TriangleAlert style={{ width: "12px", height: "12px" }} />
              <span>{Object.keys(arcusPrices).length ? "Arcus не отвечает — показаны последние котировки" : "Arcus не отвечает"}</span>
            </div>
          )}
        </div>
        <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", margin: "8px 0 0 0", maxWidth: "800px" }}>
          Рынки из публичного API Arcus: тип PERP или SPOT указан в каждой строке. Mid-цены с{" "}
          <code style={{ color: "var(--fg-2)", fontSize: "var(--fs-label)" }}>api.arcus.xyz/v1/mids</code> каждые 30 секунд; это середина котировок, не цена исполнения.
        </p>
      </div>

      {arcusMarkets.length === 0 && !arcusError ? (
        <div className="terminal-header" style={{ flexDirection: "column", gap: "8px" }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height="20px" />
          ))}
        </div>
      ) : arcusMarkets.length === 0 ? (
        <div className="terminal-header" style={{ justifyContent: "center", padding: "40px 16px" }}>
          <div>
            <p style={{ color: "var(--fg-2)", fontSize: "var(--fs-ui)", margin: 0 }}>Arcus не вернул рынков</p>
            <p style={{ color: "var(--text-muted)", fontSize: "var(--fs-label)", margin: "4px 0 0 0" }}>
              API доступен, но список markets пуст.
            </p>
          </div>
        </div>
      ) : (
        <div className="terminal-panel">
          <div className="table-scroll">
          <table className="data-table" style={{ minWidth: "700px" }} aria-label="Рынки Arcus">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col" className="left">Актив</th>
                <th scope="col" className="left">Тип</th>
                <th scope="col" className="right">Mid-цена</th>
                <th scope="col" className="right">Tick size</th>
                <th scope="col" className="right">Step size</th>
                <th scope="col" className="left">Статус</th>
                <th scope="col" className="right"><span className="sr-only">Открыть</span></th>
              </tr>
            </thead>
            <tbody>
              {arcusRows.slice(0, 15).map((m, i) => {
                const price = arcusPrices[m.marketDisplayName];
                const online = isArcusOnline(m);
                const onLighter = lighterSymbols.has(m.baseAsset.toUpperCase());
                return (
                  <tr
                    key={m.marketId}
                    data-action={onLighter ? "" : undefined}
                    onClick={
                      onLighter
                        ? () => {
                            setAsset(m.baseAsset);
                            setTab("terminal");
                          }
                        : undefined
                    }
                  >
                    <td className="muted num">{i + 1}</td>
                    <td className="left">
                      <div style={{ color: "var(--fg)", fontWeight: 600 }}>{m.marketDisplayName}</div>
                      <div className="muted num">{m.baseAsset}/{m.quoteAsset}</div>
                    </td>
                    <td className="left">
                      <span className="chip">{isArcusPerp(m) ? "PERP" : "SPOT"}</span>
                    </td>
                    <td className="right num" style={{ color: "var(--fg)", fontWeight: 500 }}>
                      {price ? fmtPrice(Number(price)) : "—"}
                    </td>
                    <td className="right num" style={{ color: "var(--fg-2)" }}>{m.tickSize}</td>
                    <td className="right num" style={{ color: "var(--fg-2)" }}>{m.stepSize}</td>
                    <td className="left">
                      <span className={online ? "text-positive" : "muted"} style={{ fontWeight: online ? 500 : 400 }}>
                        {online ? "торгуется" : "выключен"}
                      </span>
                    </td>
                    <td className="right">
                      {/* Терминал читает Lighter: строку Arcus он открывает только
                          по тикеру, который есть в его книге. */}
                      {onLighter ? (
                        <button
                          className="row-open"
                          aria-label={`Открыть ${m.baseAsset} в Терминале`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setAsset(m.baseAsset);
                            setTab("terminal");
                          }}
                        >
                          <ArrowRight style={{ width: "12px", height: "12px" }} />
                        </button>
                      ) : (
                        <span className="muted">нет на Lighter</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {arcusRows.length > 15 && (
            <div className="panel-foot">
              показано 15 из {arcusRows.length} рынков
            </div>
          )}
        </div>
      )}

      <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
          <BarChart3 style={{ width: "14px", height: "14px", color: "var(--info)" }} />
          <h3 style={{ fontSize: "var(--fs-ui)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Predict — открытые рынки</h3>
          <button onClick={() => setTab("predict")} className="link-action" style={{ marginLeft: "auto", fontSize: "var(--fs-label)", gap: "4px" }}>
            торговать <ArrowRight style={{ width: "12px", height: "12px" }} />
          </button>
        </div>
      </div>
        {predictError ? (
          <div style={{ background: "var(--bg-2)", border: "1px solid var(--warn-line)", borderRadius: "6px", padding: "12px 16px", fontSize: "var(--fs-data)", color: "var(--warn)" }}>
            Открытые рынки Predict временно недоступны. Функция требует подключённый бэкенд Wake.
          </div>
        ) : predict === null ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
                <div style={{ height: "12px", width: "96px", background: "var(--bg-2)", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
                <div style={{ marginTop: "12px", height: "16px", background: "var(--bg-2)", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
                <div style={{ marginTop: "8px", height: "6px", background: "var(--bg-2)", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
              </div>
            ))}
          </div>
        ) : predict.length === 0 ? (
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", fontSize: "var(--fs-data)", color: "var(--text-muted)" }}>
            Открытых рынков нет. Резолвленные с исходами — во вкладке Predict; создать рынок может только куратор
            (POST /predict/markets/price или /predict/markets/event с X-Curator-Token).
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
            {predict.slice(0, 4).map((m) => (
              <button key={m.id} className="nav-card" onClick={() => setTab("predict")}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {m.kind === "price" ? "цена на Lighter" : "событие"}
                  </span>
                  <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)" }}>{predictTimeLeft(m.resolve_at)}</span>
                </div>
                <div style={{ color: "var(--fg)", fontSize: "var(--fs-ui)", marginBottom: "12px" }}>{m.question}</div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ flex: 1, height: "6px", background: "var(--bg-2)", borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{ height: "100%", background: "var(--up)", width: `${m.price_yes * 100}%` }} />
                  </div>
                  <span style={{ fontSize: "var(--fs-label)", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{(m.price_yes * 100).toFixed(0)}% YES</span>
                  <span style={{ fontSize: "var(--fs-label)", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                    {fmtUsdCompact(m.volume_usd)} · {m.trade_count} сдел.
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "8px" }}>
        <button className="nav-card" onClick={() => setTab("discover")}>
          <Users style={{ width: "14px", height: "14px", color: "var(--info)", marginBottom: "8px" }} />
          <div style={{ color: "var(--fg)", fontWeight: 500, fontSize: "var(--fs-ui)", marginBottom: "4px" }}>Копирование сделок</div>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-label)", lineHeight: 1.5 }}>
            Лидер торгует своим депозитом; его сделка повторяется пропорционально аллокации. Комиссия — б.п. от скопированной сделки,
            в базе она объявлена и пока не списывается.
          </div>
        </button>
        <button className="nav-card" onClick={() => setTab("risk")}>
          <ShieldAlert style={{ width: "14px", height: "14px", color: "var(--accent)", marginBottom: "8px" }} />
          <div style={{ color: "var(--fg)", fontWeight: 500, fontSize: "var(--fs-ui)", marginBottom: "4px" }}>Риск корзины</div>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-label)", lineHeight: 1.5 }}>
            30 часовых закрытий, волатильность корзины и подбор хеджа из реальных рынков.
          </div>
        </button>
        <button className="nav-card" onClick={() => setTab("funding")}>
          <Percent style={{ width: "14px", height: "14px", color: "var(--up)", marginBottom: "8px" }} />
          <div style={{ color: "var(--fg)", fontWeight: 500, fontSize: "var(--fs-ui)", marginBottom: "4px" }}>Funding и carry</div>
          <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-label)", lineHeight: 1.5 }}>
            Ставки Lighter рядом с Binance, Bybit и Hyperliquid. Дельта-нейтральная связка с округлением под минимальный лот.
          </div>
        </button>
      </div>
      </div>
    </div>
  );
}
