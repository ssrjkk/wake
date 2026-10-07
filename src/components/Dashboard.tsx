import { useEffect, useState } from "react";
import { ArrowRight, BarChart3, Percent, RefreshCw, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { getMarketOverview, type MarketOverview, type MarketOverviewRow } from "../lib/lighter";
import { getMarkets as getArcusMarkets, getMidPrices, isArcusPerp, type ArcusMarket } from "../lib/arcus";
import { errorText } from "../lib/backend";
import { getPredictMarkets, predictTimeLeft, type PredictMarket } from "../lib/predict";
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
}

export default function Dashboard({ setTab, setAsset }: DashboardProps) {
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
    const id = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
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
    const id = setInterval(() => {
      getMidPrices()
        .then((data) => {
          if (!alive) return;
          setArcusPrices(data.mids);
        })
        .catch(() => {});
    }, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  function openMarket(row: MarketOverviewRow) {
    // symbol — ровно то, что лежит в книге Lighter: Terminal ищет рынок по этому
    // же полю, и расхождение (base вместо symbol) открывало бы пустой терминал.
    setAsset(row.symbol);
    setTab("terminal");
  }

  const rows = overview?.rows ?? [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_BY_DEFAULT);
  const missing = [...(overview?.no_market ?? []), ...(overview?.no_data ?? [])];

  return (
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Рынки Lighter</h2>
            <span style={{ fontSize: "10px", color: "#ff6b35", padding: "2px 6px", background: "rgba(255, 107, 53, 0.1)", borderRadius: "3px", border: "1px solid rgba(255, 107, 53, 0.2)" }}>zkLighter</span>
            <button
              onClick={() => setNonce((n) => n + 1)}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#888", background: "rgba(26, 26, 26, 0.5)", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", cursor: "pointer", transition: "all 0.15s" }}
              title="Обновить сейчас"
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#3a3a3a";
                e.currentTarget.style.color = "#aaa";
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.8)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#2a2a2a";
                e.currentTarget.style.color = "#888";
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.5)";
              }}
            >
              <RefreshCw style={{ width: "12px", height: "12px" }} /> обновить
            </button>
            {lastUpdated && (
              <span style={{ fontSize: "10px", color: "#525252", fontFamily: "'JetBrains Mono', monospace" }}>
                {lastUpdated.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
          <p style={{ fontSize: "12px", color: "#666", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Перпы на zkLighter, отсортированные по фактическому $-обороту за 24 часа: оборот — сумма 24 часовых свечей по каждому
            рынку, а не поле из книги (его в /orderBooks нет). Те же строки и тот же метод, что печатает{" "}
            <code style={{ color: "#888", fontSize: "11px" }}>/markets</code> в Telegram-боте.
          </p>
        </div>

      {marketsError && (
        <div className="terminal-header" style={{ color: "#ff6b35", fontSize: "12px", alignItems: "flex-start" }}>
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
            <p style={{ color: "#888", fontSize: "13px", margin: 0 }}>Ни один рынок не собрался из живых данных</p>
            <p style={{ color: "#666", fontSize: "11px", margin: "4px 0 0 0" }}>
              Бэкенд вернул ответ без рядов — детали в no_market / no_data ниже.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ background: "linear-gradient(135deg, #111 0%, #0f0f0f 100%)", border: "1px solid #1e1e1e", borderRadius: "6px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)" }}>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", minWidth: "700px" }} aria-label="Таблица данных">
            <thead>
              <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e", background: "rgba(26, 26, 26, 0.3)" }}>
                <th scope="col" style={{ padding: "10px 16px", fontWeight: 500 }}>#</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500 }}>Актив</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Цена</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>24ч</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Оборот 24ч</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }} title="Ставка за часовую эпоху funding">
                  Funding, %/ч
                </th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Годовая</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500 }}>Платят</th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }} title="Открытый интерес в единицах актива">
                  OI, баз.
                </th>
                <th scope="col" style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Мин. лот</th>
                <th scope="col" style={{ padding: "10px 8px" }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr
                  key={r.market_id}
                  onClick={() => openMarket(r)}
                  style={{ borderBottom: "1px solid #1a1a1a", cursor: "pointer", transition: "all 0.15s" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(26, 26, 26, 0.6)";
                    e.currentTarget.style.borderColor = "#2a2a2a";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "#1a1a1a";
                  }}
                >
                  <td style={{ padding: "10px 16px", color: "#666", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>{i + 1}</td>
                  <td style={{ padding: "10px 8px", color: "#fafafa", fontWeight: 600 }}>{r.symbol}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#fafafa" }}>{fmtPrice(r.price)}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: r.change_24h >= 0 ? "#10b981" : "#ef4444", fontWeight: 500 }}>
                    {fmtPct(r.change_24h)}
                  </td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{fmtUsdCompact(r.quote_volume_24h)}</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>
                    {r.funding_hourly == null ? "—" : (r.funding_hourly * 100).toFixed(4)}
                  </td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#fafafa", fontWeight: 500 }}>
                    {r.funding_annualized == null ? "—" : `${(r.funding_annualized * 100).toFixed(1)}%`}
                  </td>
                  <td style={{ padding: "10px 8px", fontSize: "11px" }}>
                    {r.funding_payer == null ? (
                      <span style={{ color: "#666" }}>нет ставки</span>
                    ) : r.funding_payer === "long" ? (
                      <span style={{ color: "#10b981", fontWeight: 500 }}>лонги</span>
                    ) : (
                      <span style={{ color: "#ef4444", fontWeight: 500 }}>шорты</span>
                    )}
                  </td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#888" }}>
                    {r.open_interest_base > 0 ? r.open_interest_base.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                  </td>
                  <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#888" }}>
                    {r.min_base_amount > 0 ? r.min_base_amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                  </td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }}>
                    <ArrowRight style={{ width: "12px", height: "12px", color: "#666", transition: "transform 0.15s" }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div style={{ padding: "10px 16px", borderTop: "1px solid #1e1e1e", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "12px", fontSize: "11px", color: "#666", background: "rgba(10, 10, 10, 0.3)" }}>
            <span>
              сеть {overview?.network} · рядов {rows.length}
            </span>
            {rows.length > SHOWN_BY_DEFAULT && (
              <button onClick={() => setShowAll((v) => !v)} style={{ color: "#3b82f6", background: "transparent", border: "none", cursor: "pointer", fontSize: "11px", fontWeight: 500, transition: "color 0.15s" }}
                onMouseEnter={(e) => e.currentTarget.style.color = "#60a5fa"}
                onMouseLeave={(e) => e.currentTarget.style.color = "#3b82f6"}
              >
                {showAll ? "свернуть" : `показать все ${rows.length}`}
              </button>
            )}
            {missing.length > 0 && <span style={{ color: "#888" }}>без данных: {missing.join(", ")}</span>}
          </div>
        </div>
      )}

      <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Рынки Arcus</h2>
          <span style={{ fontSize: "10px", color: "#10b981", padding: "2px 6px", background: "rgba(16, 185, 129, 0.1)", borderRadius: "3px", border: "1px solid rgba(16, 185, 129, 0.2)" }}>Robinhood Chain</span>
          {arcusError && (
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#ff6b35" }}>
              <TriangleAlert style={{ width: "12px", height: "12px" }} />
              <span>Arcus не отвечает</span>
            </div>
          )}
        </div>
        <p style={{ fontSize: "12px", color: "#666", margin: "8px 0 0 0", maxWidth: "800px" }}>
          Спот-токены акций, ETF и валют 24/7 без комиссий. Mid-цены с{" "}
          <code style={{ color: "#888", fontSize: "11px" }}>api.arcus.xyz/v1/mids</code> каждые 30 секунд.
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
            <p style={{ color: "#888", fontSize: "13px", margin: 0 }}>Arcus не вернул рынков</p>
            <p style={{ color: "#666", fontSize: "11px", margin: "4px 0 0 0" }}>
              API доступен, но список markets пуст.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ background: "linear-gradient(135deg, #111 0%, #0f0f0f 100%)", border: "1px solid #1e1e1e", borderRadius: "6px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)" }}>
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", minWidth: "700px" }} aria-label="Таблица данных">
            <thead>
              <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e", background: "rgba(26, 26, 26, 0.3)" }}>
                <th style={{ padding: "10px 16px", fontWeight: 500 }}>#</th>
                <th style={{ padding: "10px 8px", fontWeight: 500 }}>Актив</th>
                <th style={{ padding: "10px 8px", fontWeight: 500 }}>Тип</th>
                <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Mid-цена</th>
                <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Tick size</th>
                <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Step size</th>
                <th style={{ padding: "10px 8px", fontWeight: 500 }}>Статус</th>
              </tr>
            </thead>
            <tbody>
              {arcusMarkets.slice(0, 15).map((m, i) => {
                const price = arcusPrices[m.marketDisplayName];
                return (
                  <tr
                    key={m.marketId}
                    style={{ borderBottom: "1px solid #1a1a1a", cursor: "pointer", transition: "all 0.15s" }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(26, 26, 26, 0.6)";
                      e.currentTarget.style.borderColor = "#2a2a2a";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.borderColor = "#1a1a1a";
                    }}
                    onClick={() => {
                      setAsset(m.baseAsset);
                      setTab("terminal");
                    }}
                  >
                    <td style={{ padding: "10px 16px", color: "#666", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}>{i + 1}</td>
                    <td style={{ padding: "10px 8px" }}>
                      <div style={{ color: "#fafafa", fontWeight: 600 }}>{m.marketDisplayName}</div>
                      <div style={{ color: "#666", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace" }}>{m.baseAsset}/{m.quoteAsset}</div>
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <span style={{ fontSize: "10px", padding: "2px 6px", background: "rgba(26, 26, 26, 0.5)", color: "#888", borderRadius: "3px", border: "1px solid #2a2a2a", fontWeight: 500 }}>
                        {isArcusPerp(m) ? "PERP" : "SPOT"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#fafafa", fontWeight: 500 }}>
                      {price ? `$${Number(price).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
                    </td>
                    <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#888", fontSize: "11px" }}>{m.tickSize}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#888", fontSize: "11px" }}>{m.stepSize}</td>
                    <td style={{ padding: "10px 8px", fontSize: "11px" }}>
                      <span style={{ color: m.status === "ACTIVE" ? "#10b981" : "#666", fontWeight: m.status === "ACTIVE" ? 500 : 400 }}>
                        {m.status === "ACTIVE" ? "активен" : m.status.toLowerCase()}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {arcusMarkets.length > 15 && (
            <div style={{ padding: "8px 16px", borderTop: "1px solid #1e1e1e", fontSize: "11px", color: "#666" }}>
              показано 15 из {arcusMarkets.length} рынков
            </div>
          )}
        </div>
      )}

      <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%" }}>
          <BarChart3 style={{ width: "14px", height: "14px", color: "#3b82f6" }} />
          <h3 style={{ fontSize: "13px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Predict — открытые рынки</h3>
          <button onClick={() => setTab("predict")} style={{ marginLeft: "auto", fontSize: "11px", color: "#3b82f6", background: "transparent", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "4px" }}>
            торговать <ArrowRight style={{ width: "12px", height: "12px" }} />
          </button>
        </div>
      </div>
        {predictError ? (
          <div style={{ background: "#1a1a1a", border: "1px solid #5c3a1a", borderRadius: "6px", padding: "12px 16px", fontSize: "12px", color: "#fbbf24" }}>
            Открытые рынки Predict временно недоступны. Функция требует подключённый бэкенд Wake.
          </div>
        ) : predict === null ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
            {[0, 1].map((i) => (
              <div key={i} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
                <div style={{ height: "12px", width: "96px", background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
                <div style={{ marginTop: "12px", height: "16px", background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
                <div style={{ marginTop: "8px", height: "6px", background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
              </div>
            ))}
          </div>
        ) : predict.length === 0 ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", fontSize: "12px", color: "#666" }}>
            Открытых рынков нет. Резолвленные с исходами — во вкладке Predict; создать рынок может только куратор
            (POST /predict/markets/price или /predict/markets/event с X-Curator-Token).
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
            {predict.slice(0, 4).map((m) => (
              <button
                key={m.id}
                onClick={() => setTab("predict")}
                style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", textAlign: "left", cursor: "pointer", transition: "border-color 0.15s" }}
                onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
                onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e1e1e"}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                  <span style={{ fontSize: "10px", color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {m.kind === "price" ? "цена на Lighter" : "событие"}
                  </span>
                  <span style={{ fontSize: "10px", color: "#525252" }}>{predictTimeLeft(m.resolve_at)}</span>
                </div>
                <div style={{ color: "#fafafa", fontSize: "13px", marginBottom: "12px" }}>{m.question}</div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ flex: 1, height: "6px", background: "#1a1a1a", borderRadius: "3px", overflow: "hidden" }}>
                    <div style={{ height: "100%", background: "#10b981", width: `${m.price_yes * 100}%` }} />
                  </div>
                  <span style={{ fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", color: "#a0a0a0" }}>{(m.price_yes * 100).toFixed(0)}% YES</span>
                  <span style={{ fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", color: "#666" }}>
                    {fmtUsdCompact(m.volume_usd)} · {m.trade_count} сдел.
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "8px" }}>
        <button onClick={() => setTab("discover")} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "12px", textAlign: "left", cursor: "pointer", transition: "border-color 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e1e1e"}
        >
          <Users style={{ width: "14px", height: "14px", color: "#3b82f6", marginBottom: "8px" }} />
          <div style={{ color: "#fafafa", fontWeight: 500, fontSize: "13px", marginBottom: "4px" }}>Копирование сделок</div>
          <div style={{ color: "#666", fontSize: "11px", lineHeight: 1.5 }}>
            Лидер торгует своим депозитом; его сделка повторяется пропорционально аллокации. Комиссия — б.п. от профита.
          </div>
        </button>
        <button onClick={() => setTab("risk")} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "12px", textAlign: "left", cursor: "pointer", transition: "border-color 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e1e1e"}
        >
          <ShieldAlert style={{ width: "14px", height: "14px", color: "#8b5cf6", marginBottom: "8px" }} />
          <div style={{ color: "#fafafa", fontWeight: 500, fontSize: "13px", marginBottom: "4px" }}>Риск корзины</div>
          <div style={{ color: "#666", fontSize: "11px", lineHeight: 1.5 }}>
            30 часовых закрытий, волатильность корзины и подбор хеджа из реальных рынков.
          </div>
        </button>
        <button onClick={() => setTab("funding")} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "12px", textAlign: "left", cursor: "pointer", transition: "border-color 0.15s" }}
          onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
          onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e1e1e"}
        >
          <Percent style={{ width: "14px", height: "14px", color: "#10b981", marginBottom: "8px" }} />
          <div style={{ color: "#fafafa", fontWeight: 500, fontSize: "13px", marginBottom: "4px" }}>Funding и carry</div>
          <div style={{ color: "#666", fontSize: "11px", lineHeight: 1.5 }}>
            Ставки Lighter рядом с Binance, Bybit и Hyperliquid. Дельта-нейтральная связка с округлением под минимальный лот.
          </div>
        </button>
      </div>
      </div>
    </div>
  );
}
