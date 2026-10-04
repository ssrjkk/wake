import { useState, useEffect, useMemo } from "react";
import { TrendingUp, TrendingDown, Radio, Search } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { getCandles, getRecentTrades, getFundingRates, placeOrderViaSigningService, type LighterNetwork, type OrderBook, type Candle, type Trade } from "../lib/lighter";
import { SIGNING_SERVICE_URL } from "../lib/config";
import { errorText } from "../lib/backend";
import { fmt, usd } from "./utils";
import { Ripple, Skeleton } from "./ui";

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

export function Terminal({ asset, setAsset, markets, dataError, setToast, isCopyable, toggleCopyable, setMarketPickerOpen, network }: TerminalProps) {
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

  return (
    <div className="terminal-layout">
      {dataError && (
        <div className="terminal-main" style={{ gridColumn: "1 / -1" }}>
          <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start", gap: "8px" }}>
            <div className="text-sm text-[#ff6b35] font-medium">Lighter API не отвечает</div>
            <div className="text-xs text-[#888]">
              Стакан, свечи и лента сделок тянутся напрямую с <code className="text-[#ccc]">{network}.zklighter.elliot.ai</code>. Ошибка: {dataError}
            </div>
          </div>
        </div>
      )}

      <div className="terminal-main">
        <div className="terminal-header">
          <button onClick={() => setMarketPickerOpen(true)} className="asset-selector">
            <span className="asset-symbol">{asset}</span>
            <span className="asset-type">{currentMarket?.market_type ?? "—"}</span>
          </button>
          <div className="price-block">
            {price != null ? (
              <div className="price-current">${fmt(price, currentMarket?.supported_price_decimals ?? 2)}</div>
            ) : (
              <Skeleton className="h-7 w-32" />
            )}
            {change != null && (
              <div className={`price-change ${change >= 0 ? "up" : "down"}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)}%
              </div>
            )}
          </div>
          {stats24h && (
            <div className="stats-row">
              <div className="stat">
                <span className="stat-label">24h High</span>
                <span className="stat-value">${fmt(stats24h.high, currentMarket?.supported_price_decimals ?? 2)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">24h Low</span>
                <span className="stat-value">${fmt(stats24h.low, currentMarket?.supported_price_decimals ?? 2)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">24h Vol</span>
                <span className="stat-value">{usd(stats24h.volume, 0)}</span>
              </div>
            </div>
          )}
          {fundingRate != null && (
            <div className="funding-badge">
              Funding {(fundingRate * 100).toFixed(4)}%/ч
            </div>
          )}
        </div>

        <div className="chart-container">
          {chartData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%" minWidth={200} minHeight={150}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="wakeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0.15} />
                    <stop offset="100%" stopColor={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="v" stroke={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} strokeWidth={1.5} fill="url(#wakeGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>

        <div className="trades-section">
          <div className="section-header">
            <Radio className="w-3 h-3" />
            <span>Recent Trades</span>
          </div>
          <div className="trades-list">
            {trades.length === 0 ? (
              <div className="trades-empty">
                {[...Array(8)].map((_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              trades.slice(0, 14).map((t) => (
                <div key={t.id} className="trade-row">
                  <span className={`trade-side ${t.isAsk ? "sell" : "buy"}`}>{t.isAsk ? "SELL" : "BUY"}</span>
                  <span className="trade-price">{fmt(t.price, currentMarket?.supported_price_decimals ?? 2)}</span>
                  <span className="trade-size">{t.size}</span>
                  <span className="trade-time">{t.timestamp ? new Date(t.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="terminal-sidebar">
        <div className="order-form">
          <div className="order-tabs">
            <button className={`order-tab ${side === "long" ? "active long" : ""}`} onClick={() => setSide("long")}>
              {isSpot ? "Buy" : "Long"}
            </button>
            <button className={`order-tab ${side === "short" ? "active short" : ""}`} onClick={() => setSide("short")}>
              {isSpot ? "Sell" : "Short"}
            </button>
          </div>

          <div className="order-fields">
            <div className="field">
              <label>Size (USD)</label>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                min={10}
                className="order-input"
              />
            </div>

            {!isSpot && (
              <div className="field">
                <label>Leverage</label>
                <div className="leverage-control">
                  <input
                    type="range"
                    min="1"
                    max="20"
                    value={leverage}
                    onChange={(e) => setLeverage(Number(e.target.value))}
                    className="leverage-slider"
                  />
                  <span className="leverage-value">{leverage}x</span>
                </div>
              </div>
            )}

            {liqPrice != null && !isSpot && (
              <div className="liq-warning">
                <span>Liq. Price</span>
                <span>${fmt(liqPrice, 0)}</span>
              </div>
            )}

            <button
              onClick={() => void placeOrder()}
              className={`order-submit ${side}`}
            >
              {isSpot ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Open Long" : "Open Short"}
            </button>

            <div className="order-hint">
              Ордер уходит на <code className="text-[#888]">signing_service.py</code> с ценой последней свечи. Плечо определяет только оценку ликвидационной цены.
            </div>
          </div>
        </div>

        <div className="markets-panel">
          <div className="section-header">
            <Search className="w-3 h-3" />
            <span>Markets</span>
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search..."
            className="markets-search"
          />
          <div className="markets-list">
            {filteredMarkets.slice(0, 50).map((m) => (
              <button
                key={m.market_id}
                onClick={() => setAsset(m.symbol)}
                className={`market-row ${m.symbol === asset ? "active" : ""}`}
              >
                <span className="market-symbol">{m.symbol}</span>
                <span className="market-type">{m.market_type}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
