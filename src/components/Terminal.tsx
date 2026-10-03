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
    <div className="space-y-3">
      {dataError && (
        <div className="flex items-start gap-3 terminal-panel rounded-lg p-4">
          <div className="w-7 h-7 rounded bg-[#141414] border border-[#2a2a2a] flex items-center justify-center shrink-0 text-[#ff6b35] text-sm font-bold">
            !
          </div>
          <div>
            <div className="text-sm text-[#ff6b35] font-medium">Lighter API не отвечает</div>
            <div className="text-xs text-[#888] mt-0.5">
              Стакан, свечи и лента сделок тянутся напрямую с <code className="text-[#ccc]">{network}.zklighter.elliot.ai</code>, без промежуточного
              сервера. Пока ответа нет — графики и стакан пустые; сеть меняется в шапке. Ошибка: {dataError}
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <div className="lg:col-span-6 terminal-panel rounded-lg p-4">
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#666]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск: BTC, ETH, SOL…"
              className="input-mono w-full rounded-lg pl-9 pr-3 py-2 text-sm placeholder:text-[#666]"
            />
            {searchQuery && filteredMarkets.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-2xl max-h-60 overflow-auto z-10">
                {filteredMarkets.slice(0, 8).map((m) => (
                  <button
                    key={m.market_id}
                    onClick={() => {
                      setAsset(m.symbol);
                      setSearchQuery("");
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-[#fafafa] hover:bg-[#141414] transition-colors"
                  >
                    <span className="font-mono">{m.symbol}</span>
                    <span className="text-[#666] ml-2 text-xs">{m.market_type === "perp" ? "PERP" : "SPOT"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setMarketPickerOpen(true)}
                className="flex items-center gap-2 bg-[#141414] hover:bg-[#1f1f1f] rounded px-3 py-1.5 text-xs font-medium text-[#fafafa] transition-colors border border-[#2a2a2a]"
              >
                <span className="font-mono">{currentMarket ? `${currentMarket.symbol}${currentMarket.market_type === "perp" ? "-PERP" : "/USDC"}` : asset}</span>
                <svg className="w-3 h-3 text-[#666]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                {markets.length > 0 && <span className="text-[#666]">· {markets.length}</span>}
              </button>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[#ff6b35]/10 text-[#ff6b35] border border-[#ff6b35]/20">
                Lighter
              </span>
            </div>
            {change != null && (
              <span className={`text-sm font-mono flex items-center gap-1 ${change >= 0 ? "text-positive" : "text-negative"}`}>
                {change >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            )}
          </div>
          {price != null ? (
            <div className="price-display text-6xl mb-3 tracking-tight">${fmt(price, currentMarket?.supported_price_decimals ?? 2)}</div>
          ) : (
            <Skeleton className="h-14 w-64 mb-3 bg-[#141414]" />
          )}
          {stats24h && (
            <div className="grid grid-cols-3 gap-3 mb-3 pb-3 border-b border-[#2a2a2a]">
              <div>
                <div className="stat-label mb-1">24h High</div>
                <div className="stat-value text-sm">${fmt(stats24h.high, currentMarket?.supported_price_decimals ?? 2)}</div>
              </div>
              <div>
                <div className="stat-label mb-1">24h Low</div>
                <div className="stat-value text-sm">${fmt(stats24h.low, currentMarket?.supported_price_decimals ?? 2)}</div>
              </div>
              <div>
                <div className="stat-label mb-1">24h Vol</div>
                <div className="stat-value text-sm">{usd(stats24h.volume, 0)}</div>
              </div>
            </div>
          )}
          {fundingRate != null && (
            <div className="text-xs mb-3">
              <span className="stat-label">Funding </span>
              <span className="stat-value">{(fundingRate * 100).toFixed(4)}%/ч</span>
              <span className="text-[#666] ml-2">→ {((fundingRate * 24 * 365) * 100).toFixed(1)}% годовых</span>
            </div>
          )}
          <div className="h-48">
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="wakeGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0.2} />
                      <stop offset="100%" stopColor={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke={(change ?? 0) >= 0 ? "#10b981" : "#ef4444"} strokeWidth={1.5} fill="url(#wakeGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-full w-full bg-[#141414]" />
            )}
          </div>
          <div className="text-xs text-[#666] mt-2 font-mono">1h · 48 точек · 20с</div>
        </div>

        <div className="lg:col-span-3 terminal-panel rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="stat-label">Лента сделок</span>
            <span className={`w-1.5 h-1.5 rounded-full live-indicator ${trades.length ? "bg-positive" : "bg-[#333]"}`} />
          </div>
          {trades.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full bg-[#141414]" />
              ))}
            </div>
          ) : (
            <div className="space-y-0.5 max-h-56 overflow-hidden">
              {trades.slice(0, 14).map((t, i) => (
                <div
                  key={t.id}
                  className="flex justify-between text-xs font-mono py-0.5"
                  style={i === 0 ? { animation: "tradeFlash 0.6s ease-out" } : undefined}
                >
                  <span className={t.isAsk ? "text-negative" : "text-positive"}>{fmt(t.price, currentMarket?.supported_price_decimals ?? 2)}</span>
                  <span className="text-[#666]">{t.size}</span>
                </div>
              ))}
            </div>
          )}
          <div className="text-xs text-[#666] mt-3 font-mono">4с</div>
        </div>

        <div className="lg:col-span-3 terminal-panel rounded-lg p-4 space-y-3">
          {isSpot ? (
            <div className="flex bg-[#141414] rounded-lg p-1 border border-[#2a2a2a]">
              <button
                onClick={() => setSide("long")}
                className={`btn-action flex-1 py-2.5 rounded-md text-sm transition-all ${side === "long" ? "bg-positive text-[#0a0a0a] shadow-lg shadow-emerald-500/20" : "text-[#888] hover:text-[#ccc]"}`}
              >
                Buy
              </button>
              <button
                onClick={() => setSide("short")}
                className={`btn-action flex-1 py-2.5 rounded-md text-sm transition-all ${side === "short" ? "bg-negative text-[#0a0a0a] shadow-lg shadow-red-500/20" : "text-[#888] hover:text-[#ccc]"}`}
              >
                Sell
              </button>
            </div>
          ) : (
            <div className="flex bg-[#141414] rounded-lg p-1 border border-[#2a2a2a]">
              <button
                onClick={() => setSide("long")}
                className={`btn-action flex-1 py-2.5 rounded-md text-sm transition-all ${side === "long" ? "bg-positive text-[#0a0a0a] shadow-lg shadow-emerald-500/20" : "text-[#888] hover:text-[#ccc]"}`}
              >
                Long
              </button>
              <button
                onClick={() => setSide("short")}
                className={`btn-action flex-1 py-2.5 rounded-md text-sm transition-all ${side === "short" ? "bg-negative text-[#0a0a0a] shadow-lg shadow-red-500/20" : "text-[#888] hover:text-[#ccc]"}`}
              >
                Short
              </button>
            </div>
          )}

          <div>
            <label className="stat-label mb-1 block">Размер позиции</label>
            <div className="flex items-center bg-[#141414] border border-[#2a2a2a] rounded px-3 py-2">
              <span className="text-[#666] mr-1 font-mono text-sm">$</span>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                className="input-mono bg-transparent outline-none w-full"
              />
            </div>
          </div>

          {!isSpot && (
            <div>
              <div className="flex justify-between mb-1">
                <span className="stat-label">Плечо</span>
                <span className="stat-value text-sm">{leverage}x</span>
              </div>
              <input type="range" min="1" max="20" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full accent-[#ff6b35]" />
            </div>
          )}

          <div className="flex justify-between text-xs font-mono text-[#666]">
            {isSpot ? (
              <span>Спот — без плеча</span>
            ) : (
              <>
                <span>Ликв. ≈ {liqPrice != null ? `$${fmt(liqPrice, 0)}` : "—"}</span>
                <span>Маржа ${fmt(size / leverage, 0)}</span>
              </>
            )}
          </div>

          <button
            onClick={placeOrder}
            className={`btn-action w-full py-3 rounded-lg text-sm font-semibold transition-all ${side === "long" ? "bg-positive hover:bg-emerald-400 text-[#0a0a0a] shadow-lg shadow-emerald-500/30 hover:shadow-emerald-400/40" : "bg-negative hover:bg-red-400 text-[#0a0a0a] shadow-lg shadow-red-500/30 hover:shadow-red-400/40"}`}
          >
            {isSpot ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Открыть Long" : "Открыть Short"}
          </button>
          <p className="text-xs text-[#666] font-mono leading-relaxed">
            Ордер уходит на локальный <code className="text-[#888]">backend/signing_service.py</code> ({SIGNING_SERVICE_URL}) с ценой последней
            часовой свечи. Плечо в этот запрос не попадает — оно определяет только оценку ликвидационной цены выше; реальное плечо задаётся размером
            позиции относительно маржи на самом Lighter.
          </p>

          <div className="border-t border-[#2a2a2a] pt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="relative w-4 h-4 shrink-0">
                  {isCopyable && <Ripple />}
                  <Radio className={`relative z-10 w-4 h-4 ${isCopyable ? "text-[#ff6b35]" : "text-[#666]"}`} />
                </div>
                <span className="text-xs text-[#ccc] font-medium">Публиковать мои сделки</span>
              </div>
              <button
                onClick={toggleCopyable}
                aria-pressed={isCopyable}
                className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${isCopyable ? "bg-[#ff6b35]" : "bg-[#333]"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isCopyable ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <p className="text-xs text-[#666] mt-2 leading-relaxed font-mono">
              {isCopyable
                ? `Ты в таблице leaders — подписчики видят тебя во вкладке Discover, комиссия и статика во вкладке Earn.`
                : `Нужен подключённый кошелёк с аккаунтом Lighter: переключатель пишет строку в leaders (индекс аккаунта, handle, комиссия).`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
