import { useState, useEffect, useMemo } from "react";
import { TrendingUp, TrendingDown, Radio } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { getCandles, getRecentTrades, placeOrderViaSigningService, type LighterNetwork, type OrderBook, type Candle, type Trade } from "../lib/lighter";
import { SIGNING_SERVICE_URL } from "../lib/config";
import { errorText } from "../lib/backend";
import { fmt } from "./utils";
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

  const currentMarket = markets.find((m) => m.symbol === asset);
  const isSpot = currentMarket?.market_type === "spot";

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

  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const price = lastCandle?.c ?? null;
  const change = lastCandle && firstCandle ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : null;
  const chartData = candles.map((c, i) => ({ i, v: c.c }));

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
    <div className="space-y-4">
      {dataError && (
        <div className="flex items-start gap-3 bg-slate-900 border border-amber-800 rounded-2xl p-4">
          <div className="w-7 h-7 rounded-lg bg-slate-800 border border-amber-700 flex items-center justify-center shrink-0 text-amber-400 text-sm font-bold">
            !
          </div>
          <div>
            <div className="text-sm text-amber-300 font-medium">Lighter API не отвечает</div>
            <div className="text-xs text-slate-500 mt-0.5">
              Стакан, свечи и лента сделок тянутся напрямую с <code className="text-slate-400">{network}.zklighter.elliot.ai</code>, без промежуточного
              сервера. Пока ответа нет — графики и стакан пустые; сеть меняется в шапке. Ошибка: {dataError}
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={() => setMarketPickerOpen(true)}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 rounded-full pl-3 pr-2 py-1 text-xs font-medium text-slate-100 transition-colors"
            >
              {currentMarket ? `${currentMarket.symbol}${currentMarket.market_type === "perp" ? "-PERP" : "/USDC"}` : asset}
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              {markets.length > 0 && <span className="text-slate-600">· {markets.length} рынков</span>}
            </button>
            {change != null && (
              <span className={`text-xs font-mono flex items-center gap-0.5 ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {change >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                {change >= 0 ? "+" : ""}
                {change.toFixed(2)}%
              </span>
            )}
          </div>
          {price != null ? (
            <div className="text-3xl font-mono font-semibold text-white mb-2">${fmt(price, currentMarket?.supported_price_decimals ?? 2)}</div>
          ) : (
            <Skeleton className="h-9 w-40 mb-2" />
          )}
          <div className="h-48">
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="wakeGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} strokeWidth={2} fill="url(#wakeGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-full w-full" />
            )}
          </div>
          <div className="text-xs text-slate-600 mt-1">GET /api/v1/candles · 1h · 48 точек, опрос каждые 20 с</div>
        </div>

        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500 uppercase tracking-wide">Лента сделок</span>
            <span className={`w-1.5 h-1.5 rounded-full ${trades.length ? "bg-emerald-400" : "bg-slate-700"}`} />
          </div>
          {trades.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          ) : (
            <div className="space-y-1 max-h-56 overflow-hidden">
              {trades.slice(0, 14).map((t, i) => (
                <div
                  key={t.id}
                  className="flex justify-between text-xs font-mono"
                  style={i === 0 ? { animation: "wakeFadeIn 0.4s ease-out" } : undefined}
                >
                  <span className={t.isAsk ? "text-red-400" : "text-emerald-400"}>{fmt(t.price, currentMarket?.supported_price_decimals ?? 2)}</span>
                  <span className="text-slate-500">{t.size}</span>
                </div>
              ))}
            </div>
          )}
          <div className="text-xs text-slate-600 mt-2">GET /api/v1/recentTrades — обновляется каждые 4с</div>
        </div>

        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          {isSpot ? (
            <div className="flex bg-slate-800 rounded-xl p-1">
              <button
                onClick={() => setSide("long")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "long" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}
              >
                Buy
              </button>
              <button
                onClick={() => setSide("short")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "short" ? "bg-red-500 text-slate-950" : "text-slate-400"}`}
              >
                Sell
              </button>
            </div>
          ) : (
            <div className="flex bg-slate-800 rounded-xl p-1">
              <button
                onClick={() => setSide("long")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "long" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}
              >
                Long
              </button>
              <button
                onClick={() => setSide("short")}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "short" ? "bg-red-500 text-slate-950" : "text-slate-400"}`}
              >
                Short
              </button>
            </div>
          )}

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Размер позиции</label>
            <div className="flex items-center bg-slate-800 border border-slate-700 rounded-xl px-3 py-2">
              <span className="text-slate-500 mr-1">$</span>
              <input
                type="number"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                className="bg-transparent text-white font-mono outline-none w-full"
              />
            </div>
          </div>

          {!isSpot && (
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Плечо</span>
                <span className="font-mono text-slate-200">{leverage}x</span>
              </div>
              <input type="range" min="1" max="20" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full accent-cyan-500" />
            </div>
          )}

          <div className="flex justify-between text-xs text-slate-500 font-mono">
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
            className={`w-full py-2.5 rounded-xl font-semibold transition-colors ${side === "long" ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950" : "bg-red-500 hover:bg-red-400 text-slate-950"}`}
          >
            {isSpot ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Открыть Long" : "Открыть Short"}
          </button>
          <p className="text-xs text-slate-600">
            Ордер уходит на локальный <code className="text-slate-400">backend/signing_service.py</code> ({SIGNING_SERVICE_URL}) с ценой последней
            часовой свечи. Плечо в этот запрос не попадает — оно определяет только оценку ликвидационной цены выше; реальное плечо задаётся размером
            позиции относительно маржи на самом Lighter.
          </p>

          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="relative w-4 h-4 shrink-0">
                  {isCopyable && <Ripple />}
                  <Radio className={`relative z-10 w-4 h-4 ${isCopyable ? "text-cyan-400" : "text-slate-500"}`} />
                </div>
                <span className="text-xs text-slate-300 font-medium">Публиковать мои сделки</span>
              </div>
              <button
                onClick={toggleCopyable}
                aria-pressed={isCopyable}
                className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${isCopyable ? "bg-cyan-500" : "bg-slate-700"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isCopyable ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
            <p className="text-xs text-slate-600 mt-2 leading-relaxed">
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
