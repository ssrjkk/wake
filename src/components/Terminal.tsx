import { useState, useEffect, useMemo } from "react";
import { Radio, Search } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { getCandles, getRecentTrades, getFundingRates, placeOrderViaSigningService, type LighterNetwork, type OrderBook, type Candle, type Trade } from "../lib/lighter";
import { SIGNING_SERVICE_URL } from "../lib/config";
import { errorText } from "../lib/backend";
import { fmt, usd } from "./utils";

interface TerminalProps {
  asset: string;
  setAsset: (asset: string) => void;
  markets: OrderBook[];
  dataError: string | null;
  setToast: (toast: string | null) => void;
  isCopyable: boolean;
  toggleCopyable: () => void;
  setMarketPickerOpen: (open: boolean) => void;
  network: LighterNetwork;
  accountEquityUsd?: number;
}

const MONO = "'JetBrains Mono', monospace";

function Shimmer({ height = "16px", width = "100%" }: { height?: string; width?: string }) {
  return <div style={{ height, width, background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export default function Terminal({ asset, setAsset, markets, dataError, setToast, setMarketPickerOpen, network, accountEquityUsd }: TerminalProps) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);
  const [searchQuery, setSearchQuery] = useState("");
  const [fundingRate, setFundingRate] = useState<number | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(false);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [showOrderConfirm, setShowOrderConfirm] = useState(false);
  const [lastCandlesUpdate, setLastCandlesUpdate] = useState<Date | null>(null);
  const [lastTradesUpdate, setLastTradesUpdate] = useState<Date | null>(null);

  const currentMarket = markets.find((m) => m.symbol === asset);
  const isSpot = currentMarket?.market_type === "spot";

  const filteredMarkets = useMemo(() => {
    if (!searchQuery.trim()) return markets;
    const q = searchQuery.toUpperCase();
    return markets.filter((m) => m.symbol.toUpperCase().includes(q));
  }, [markets, searchQuery]);

  useEffect(() => {
    if (!currentMarket) return;
    setCandlesLoading(true);
    setCandlesError(null);
    getCandles(currentMarket.market_id, "1h", 48)
      .then((data) => {
        setCandles(data);
        setLastCandlesUpdate(new Date());
      })
      .catch((e) => setCandlesError(errorText(e)))
      .finally(() => setCandlesLoading(false));
    const id = setInterval(() => {
      getCandles(currentMarket.market_id, "1h", 48)
        .then((data) => {
          setCandles(data);
          setLastCandlesUpdate(new Date());
        })
        .catch((e) => setCandlesError(errorText(e)));
    }, 20000);
    return () => clearInterval(id);
  }, [currentMarket?.market_id]);

  useEffect(() => {
    if (!currentMarket) return;
    setTradesLoading(true);
    setTradesError(null);
    getRecentTrades(currentMarket.market_id, 16)
      .then((data) => {
        setTrades(data);
        setLastTradesUpdate(new Date());
      })
      .catch((e) => setTradesError(errorText(e)))
      .finally(() => setTradesLoading(false));
    const id = setInterval(() => {
      getRecentTrades(currentMarket.market_id, 16)
        .then((data) => {
          setTrades(data);
          setLastTradesUpdate(new Date());
        })
        .catch((e) => setTradesError(errorText(e)));
    }, 4000);
    return () => clearInterval(id);
  }, [currentMarket?.market_id]);

  useEffect(() => {
    if (!currentMarket) {
      setFundingRate(null);
      return;
    }
    getFundingRates()
      .then((rows) => {
        const row = rows.find((r) => r.market_id === currentMarket.market_id && r.exchange === "lighter");
        setFundingRate(row?.rate ?? null);
      })
      .catch(() => setFundingRate(null));
  }, [currentMarket?.market_id]);

  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const price = lastCandle?.c ?? null;
  const change = lastCandle && firstCandle ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : null;
  const chartData = candles.map((c, i) => ({ i, v: c.c }));

  const stats24h = useMemo(() => {
    if (candles.length < 2) return null;
    const last24 = candles.slice(-24);
    const high = Math.max(...last24.map((c) => c.h));
    const low = Math.min(...last24.map((c) => c.l));
    const volume = last24.reduce((s, c) => s + c.V, 0);
    return { high, low, volume };
  }, [candles]);

  const liqPrice = useMemo(() => {
    if (price == null) return null;
    const dist = price * (1 / Math.max(leverage, 1)) * 0.9;
    return side === "long" ? price - dist : price + dist;
  }, [price, leverage, side]);

  function requestOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    if (accountEquityUsd !== undefined && size > accountEquityUsd) {
      setToast(`Размер ордера ($${size}) превышает баланс счёта ($${accountEquityUsd.toFixed(2)})`);
      return;
    }
    if (size <= 0) {
      setToast("Размер ордера должен быть больше нуля");
      return;
    }
    setShowOrderConfirm(true);
  }

  async function placeOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    setShowOrderConfirm(false);
    setToast(`Отправляю на signing service (${SIGNING_SERVICE_URL})…`);
    try {
      const result = await placeOrderViaSigningService(currentMarket, side, size, price);
      setToast(`Ордер отправлен: ${result.tx_hash}`);
    } catch (e) {
      setToast(
        `Ордер не отправлен: ${errorText(e)}. Подпишите и запустите backend/signing_service.py, затем повторите.`
      );
    }
  }

  const decimals = currentMarket?.supported_price_decimals ?? 2;
  const up = (change ?? 0) >= 0;

  return (
    <div className="terminal-layout">
      <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: "1px", background: "#1a1a1a", overflow: "hidden" }}>
        {/* Asset header */}
        <div className="terminal-asset-header">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button onClick={() => setMarketPickerOpen(true)} style={{ display: "flex", alignItems: "center", gap: "8px", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa" }}>{asset}</span>
              <span style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", padding: "2px 6px", background: "#1a1a1a", borderRadius: "3px" }}>
                {currentMarket?.market_type ?? "PERP"}
              </span>
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {price != null ? (
              <span style={{ fontFamily: MONO, fontSize: "24px", fontWeight: 600, color: "#fafafa", letterSpacing: "-0.02em" }}>
                ${fmt(price, decimals)}
              </span>
            ) : (
              <Shimmer height="28px" width="140px" />
            )}
            {change != null && (
              <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: up ? "#10b981" : "#ef4444" }}>
                {up ? "+" : ""}{change.toFixed(2)}%
              </span>
            )}
          </div>

          {stats24h && (
            <div style={{ display: "flex", gap: "24px", marginLeft: "auto" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h High</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>${fmt(stats24h.high, decimals)}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h Low</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>${fmt(stats24h.low, decimals)}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h Vol</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>{usd(stats24h.volume, 0)}</span>
              </div>
            </div>
          )}

          {fundingRate != null && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Funding</span>
              <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>{(fundingRate * 100).toFixed(4)}%/h</span>
            </div>
          )}
        </div>

        {/* Chart */}
        <div style={{ background: "#111", padding: "16px", minHeight: "300px", position: "relative" }}>
          {lastCandlesUpdate && !candlesError && !dataError && (
            <div style={{ position: "absolute", top: "8px", right: "8px", fontSize: "11px", color: "#525252", fontFamily: MONO, zIndex: 10 }}>
              {lastCandlesUpdate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </div>
          )}
          {dataError ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "13px", color: "#666" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ marginBottom: "8px" }}>Lighter API не отвечает</div>
                <div style={{ fontSize: "11px", color: "#525252" }}>
                  {network}.zklighter.elliot.ai — {dataError}
                </div>
              </div>
            </div>
          ) : candlesError ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "13px", color: "#666" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ marginBottom: "8px" }}>Не удалось загрузить график</div>
                <div style={{ fontSize: "11px", color: "#525252" }}>{candlesError}</div>
              </div>
            </div>
          ) : chartData.length > 1 ? (
            <>
              {candlesLoading && candles.length === 0 && (
                <div style={{ position: "absolute", top: "8px", right: "8px", fontSize: "11px", color: "#666", display: "flex", alignItems: "center", gap: "4px" }}>
                  <div style={{ width: "8px", height: "8px", border: "2px solid #3b82f6", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
                  загрузка…
                </div>
              )}
              <ResponsiveContainer width="100%" height="100%" minWidth={200} minHeight={150}>
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={up ? "#10b981" : "#ef4444"} stopOpacity={0.12} />
                      <stop offset="100%" stopColor={up ? "#10b981" : "#ef4444"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke={up ? "#10b981" : "#ef4444"} strokeWidth={1.5} fill="url(#chartGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </>
          ) : (
            <Shimmer height="100%" />
          )}
        </div>

        {/* Recent trades */}
        <div style={{ background: "#111", maxHeight: "240px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #1a1a1a" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent Trades</span>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {lastTradesUpdate && !tradesError && (
                <span style={{ fontSize: "11px", color: "#525252", fontFamily: MONO }}>
                  {lastTradesUpdate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              )}
              {tradesLoading && trades.length === 0 && (
                <span style={{ fontSize: "11px", color: "#666" }}>загрузка…</span>
              )}
              <Radio style={{ width: "12px", height: "12px", color: trades.length ? "#10b981" : "#525252", animation: "livePulse 2s ease-in-out infinite" }} />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {tradesError ? (
              <div style={{ padding: "12px", fontSize: "12px", color: "#666", textAlign: "center" }}>
                <div style={{ marginBottom: "4px" }}>Ошибка загрузки сделок</div>
                <div style={{ fontSize: "11px", color: "#525252" }}>{tradesError}</div>
              </div>
            ) : trades.length === 0 ? (
              <div style={{ padding: "12px" }}>
                {Array.from({ length: 8 }, (_, i) => (
                  <Shimmer key={i} height="20px" />
                ))}
              </div>
            ) : (
              trades.slice(0, 20).map((t) => (
                <div key={t.id} style={{ display: "grid", gridTemplateColumns: "80px 1fr 80px", gap: "8px", padding: "4px 12px", fontFamily: MONO, fontSize: "12px" }}>
                  <span style={{ fontWeight: 500, color: t.isAsk ? "#ef4444" : "#10b981" }}>
                    {fmt(t.price, decimals)}
                  </span>
                  <span style={{ color: "#666", textAlign: "right" }}>{t.size}</span>
                  <span style={{ color: "#525252", textAlign: "right" }}>
                    {t.timestamp ? new Date(t.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: "1px", background: "#1a1a1a", overflow: "hidden" }}>
        {/* Order form */}
        <div style={{ background: "#111", padding: "16px" }}>
          <div style={{ display: "flex", gap: "4px", marginBottom: "16px", padding: "3px", background: "#0a0a0a", borderRadius: "6px" }}>
            <button
              style={{
                flex: 1, padding: "12px 8px", fontSize: "13px", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer", transition: "all 0.15s", minHeight: "44px",
                background: side === "long" ? "#10b981" : "transparent",
                color: side === "long" ? "#0a0a0a" : "#666",
              }}
              onClick={() => setSide("long")}
            >
              {isSpot ? "Buy" : "Long"}
            </button>
            <button
              style={{
                flex: 1, padding: "12px 8px", fontSize: "13px", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer", transition: "all 0.15s", minHeight: "44px",
                background: side === "short" ? "#ef4444" : "transparent",
                color: side === "short" ? "#0a0a0a" : "#666",
              }}
              onClick={() => setSide("short")}
            >
              {isSpot ? "Sell" : "Short"}
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Size (USD)</label>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                min={10}
                style={{ fontFamily: MONO, fontSize: "14px", color: "#fafafa", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "10px 12px", outline: "none" }}
              />
            </div>

            {!isSpot && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <label style={{ fontSize: "11px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Leverage</label>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={leverage}
                    onChange={(e) => setLeverage(Number(e.target.value))}
                    style={{ flex: 1, accentColor: "#3b82f6" }}
                  />
                  <span style={{ fontFamily: MONO, fontSize: "14px", fontWeight: 600, color: "#3b82f6", minWidth: "40px", textAlign: "right" }}>{leverage}x</span>
                </div>
              </div>
            )}

            {!isSpot && liqPrice != null && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#0a0a0a", borderRadius: "4px", fontSize: "12px" }}>
                <span style={{ color: "#666" }}>Liq. Price</span>
                <span style={{ fontFamily: MONO, fontWeight: 500, color: "#a0a0a0" }}>${fmt(liqPrice, 0)}</span>
              </div>
            )}

            {!isSpot && (
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#0a0a0a", borderRadius: "4px", fontSize: "12px" }}>
                <span style={{ color: "#666" }}>Margin</span>
                <span style={{ fontFamily: MONO, fontWeight: 500, color: "#a0a0a0" }}>${fmt(size / leverage, 0)}</span>
              </div>
            )}

            <button
              onClick={requestOrder}
              disabled={!currentMarket || price == null}
              style={{
                padding: "12px", fontSize: "14px", fontWeight: 600, border: "none", borderRadius: "6px", cursor: currentMarket && price != null ? "pointer" : "not-allowed",
                background: side === "long" ? "#10b981" : "#ef4444",
                color: "#0a0a0a",
                opacity: !currentMarket || price == null ? 0.5 : 1,
                transition: "all 0.15s",
                position: "relative",
                overflow: "hidden",
              }}
              onMouseEnter={(e) => {
                if (currentMarket && price != null) {
                  e.currentTarget.style.filter = "brightness(1.1)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.filter = "brightness(1)";
              }}
            >
              {!currentMarket ? "Рынок не загружен" : price == null ? "Цена недоступна" : isSpot ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Open Long" : "Open Short"}
            </button>

            <div style={{ fontSize: "11px", color: "#525252", lineHeight: 1.5, padding: "8px", background: "#0a0a0a", borderRadius: "4px" }}>
              Ордер уходит на signing_service.py с ценой последней свечи. Плечо определяет только оценку ликвидационной цены.
            </div>
          </div>
        </div>

        {/* Markets panel */}
        <div style={{ background: "#111", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "12px", borderBottom: "1px solid #1a1a1a" }}>
            <div style={{ position: "relative" }}>
              <Search style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", width: "14px", height: "14px", color: "#525252" }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search markets..."
                style={{ width: "100%", fontFamily: MONO, fontSize: "12px", color: "#fafafa", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "8px 12px 8px 32px", outline: "none", boxSizing: "border-box" }}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {filteredMarkets.slice(0, 50).map((m) => (
              <button
                key={m.market_id}
                onClick={() => setAsset(m.symbol)}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", fontSize: "12px", cursor: "pointer",
                  border: "none", background: m.symbol === asset ? "#1a1a1a" : "transparent", color: "#fafafa", textAlign: "left", width: "100%",
                  borderLeft: m.symbol === asset ? "2px solid #3b82f6" : "2px solid transparent",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => { if (m.symbol !== asset) e.currentTarget.style.background = "#1a1a1a"; }}
                onMouseLeave={(e) => { if (m.symbol !== asset) e.currentTarget.style.background = "transparent"; }}
              >
                <span style={{ fontFamily: MONO, fontWeight: 600 }}>{m.symbol}</span>
                <span style={{ fontSize: "11px", color: "#525252", textTransform: "uppercase" }}>{m.market_type}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {showOrderConfirm && currentMarket && price != null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: "24px" }}>
          <div style={{ background: "#111", border: "1px solid #2a2a2a", borderRadius: "8px", padding: "24px", maxWidth: "420px", width: "100%" }}>
            <h3 style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: 600, color: "#fafafa" }}>Подтверждение ордера</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#666" }}>Рынок</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: "#fafafa" }}>{currentMarket.symbol}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#666" }}>Сторона</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: side === "long" ? "#10b981" : "#ef4444" }}>
                  {side === "long" ? "Long" : "Short"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#666" }}>Размер</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: "#fafafa" }}>${size}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#666" }}>Цена</span>
                <span style={{ fontFamily: MONO, fontWeight: 600, color: "#fafafa" }}>${fmt(price, decimals)}</span>
              </div>
              {!isSpot && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: "#666" }}>Плечо</span>
                  <span style={{ fontFamily: MONO, fontWeight: 600, color: "#fafafa" }}>{leverage}x</span>
                </div>
              )}
              <div style={{ borderTop: "1px solid #2a2a2a", paddingTop: "12px", display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#666", fontWeight: 600 }}>Итого</span>
                <span style={{ fontFamily: MONO, fontWeight: 700, color: "#fafafa", fontSize: "15px" }}>
                  ${fmt(size, 0)}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowOrderConfirm(false)}
                style={{ flex: 1, padding: "10px", fontSize: "13px", fontWeight: 600, border: "1px solid #2a2a2a", borderRadius: "6px", cursor: "pointer", background: "transparent", color: "#a0a0a0", transition: "all 0.15s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#1a1a1a"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                Отмена
              </button>
              <button
                onClick={() => void placeOrder()}
                style={{ flex: 1, padding: "14px 10px", fontSize: "13px", fontWeight: 600, border: "none", borderRadius: "6px", cursor: "pointer", background: side === "long" ? "#10b981" : "#ef4444", color: "#0a0a0a", transition: "all 0.15s", minHeight: "44px" }}
                onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.filter = "brightness(1)"; }}
              >
                Подтвердить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
