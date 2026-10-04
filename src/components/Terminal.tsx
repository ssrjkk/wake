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
}

const MONO = "'JetBrains Mono', monospace";

function Shimmer({ height = "16px", width = "100%" }: { height?: string; width?: string }) {
  return <div style={{ height, width, background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

export function Terminal({ asset, setAsset, markets, dataError, setToast, setMarketPickerOpen, network }: TerminalProps) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);
  const [searchQuery, setSearchQuery] = useState("");
  const [fundingRate, setFundingRate] = useState<number | null>(null);

  const currentMarket = markets.find((m) => m.symbol === asset);
  const isSpot = currentMarket?.market_type === "spot";

  const filteredMarkets = useMemo(() => {
    if (!searchQuery.trim()) return markets;
    const q = searchQuery.toUpperCase();
    return markets.filter((m) => m.symbol.toUpperCase().includes(q));
  }, [markets, searchQuery]);

  useEffect(() => {
    if (!currentMarket) return;
    function load() {
      getCandles(currentMarket!.market_id, "1h", 48)
        .then(setCandles)
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [currentMarket?.market_id]);

  useEffect(() => {
    if (!currentMarket) return;
    function load() {
      getRecentTrades(currentMarket!.market_id, 16)
        .then(setTrades)
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 4000);
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

  async function placeOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
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
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "1px", height: "calc(100vh - 60px)", background: "#1a1a1a" }}>
      <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", gap: "1px", background: "#1a1a1a", overflow: "hidden" }}>
        {/* Asset header */}
        <div style={{ display: "flex", alignItems: "center", gap: "24px", padding: "12px 16px", background: "#111" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button onClick={() => setMarketPickerOpen(true)} style={{ display: "flex", alignItems: "center", gap: "8px", background: "transparent", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa" }}>{asset}</span>
              <span style={{ fontSize: "10px", fontWeight: 500, color: "#666", textTransform: "uppercase", padding: "2px 6px", background: "#1a1a1a", borderRadius: "3px" }}>
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
                <span style={{ fontSize: "10px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h High</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>${fmt(stats24h.high, decimals)}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "10px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h Low</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>${fmt(stats24h.low, decimals)}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "10px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>24h Vol</span>
                <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>{usd(stats24h.volume, 0)}</span>
              </div>
            </div>
          )}

          {fundingRate != null && (
            <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              <span style={{ fontSize: "10px", fontWeight: 500, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Funding</span>
              <span style={{ fontFamily: MONO, fontSize: "13px", fontWeight: 500, color: "#a0a0a0" }}>{(fundingRate * 100).toFixed(4)}%/h</span>
            </div>
          )}
        </div>

        {/* Chart */}
        <div style={{ background: "#111", padding: "16px", minHeight: "300px" }}>
          {dataError ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", fontSize: "13px", color: "#666" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ marginBottom: "8px" }}>Lighter API не отвечает</div>
                <div style={{ fontSize: "11px", color: "#525252" }}>
                  {network}.zklighter.elliot.ai — {dataError}
                </div>
              </div>
            </div>
          ) : chartData.length > 1 ? (
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
          ) : (
            <Shimmer height="100%" />
          )}
        </div>

        {/* Recent trades */}
        <div style={{ background: "#111", maxHeight: "240px", display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: "1px solid #1a1a1a" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent Trades</span>
            <Radio style={{ width: "12px", height: "12px", color: trades.length ? "#10b981" : "#525252", animation: "livePulse 2s ease-in-out infinite" }} />
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
            {trades.length === 0 ? (
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
                flex: 1, padding: "8px", fontSize: "13px", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer", transition: "all 0.15s",
                background: side === "long" ? "#10b981" : "transparent",
                color: side === "long" ? "#0a0a0a" : "#666",
              }}
              onClick={() => setSide("long")}
            >
              {isSpot ? "Buy" : "Long"}
            </button>
            <button
              style={{
                flex: 1, padding: "8px", fontSize: "13px", fontWeight: 600, border: "none", borderRadius: "4px", cursor: "pointer", transition: "all 0.15s",
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
              onClick={() => void placeOrder()}
              disabled={!currentMarket || price == null}
              style={{
                padding: "12px", fontSize: "14px", fontWeight: 600, border: "none", borderRadius: "6px", cursor: currentMarket && price != null ? "pointer" : "not-allowed",
                background: side === "long" ? "#10b981" : "#ef4444",
                color: "#0a0a0a",
                opacity: !currentMarket || price == null ? 0.5 : 1,
                transition: "all 0.15s",
              }}
            >
              {isSpot ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Open Long" : "Open Short"}
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
                <span style={{ fontSize: "10px", color: "#525252", textTransform: "uppercase" }}>{m.market_type}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
