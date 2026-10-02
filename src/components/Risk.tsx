import { useState } from "react";
import { X } from "lucide-react";
import { getCandles, type OrderBook } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import type { RiskPosition } from "./types";

interface RiskProps {
  markets: OrderBook[];
  setToast: (toast: string | null) => void;
}

export function Risk({ markets, setToast }: RiskProps) {
  const [riskPositions, setRiskPositions] = useState<RiskPosition[]>([]);
  const [riskPickerOpen, setRiskPickerOpen] = useState(false);
  const [riskResult, setRiskResult] = useState<any>(null);
  const [hedgeResult, setHedgeResult] = useState<any>(null);
  const [riskBusy, setRiskBusy] = useState(false);

  function addRiskPosition(m: OrderBook, side: "long" | "short") {
    setRiskPositions((p) => [...p, { marketId: m.market_id, symbol: m.symbol, notionalUsd: 1000, side }]);
    setRiskPickerOpen(false);
  }

  function removeRiskPosition(i: number) {
    setRiskPositions((p) => p.filter((_, idx) => idx !== i));
    setRiskResult(null);
  }

  async function analyzePortfolioRisk() {
    if (riskPositions.length < 1) {
      setToast("Добавь хотя бы одну позицию");
      return;
    }
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      const returnsByMarket: Record<string, number[]> = {};
      for (const pos of riskPositions) {
        const candles = await getCandles(pos.marketId, "1h", 30);
        const closes = candles.map((c) => c.c);
        const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
        returnsByMarket[String(pos.marketId)] = returns;
      }

      setRiskResult(await backendJson("/portfolio/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: riskPositions.map((p) => ({
            market_id: p.marketId,
            symbol: p.symbol,
            signed_notional_usd: p.side === "long" ? p.notionalUsd : -p.notionalUsd,
          })),
          returns_by_market: returnsByMarket,
        }),
      }));
    } catch (e) {
      setToast(`Анализ риска недоступен: ${errorText(e)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  async function findHedge() {
    if (riskPositions.length === 0) return;
    const target = riskPositions[0];
    setRiskBusy(true);
    try {
      const returnsByMarket: Record<string, number[]> = {};
      const candidates: [number, string][] = [];
      for (const m of markets.slice(0, 15)) {
        const candles = await getCandles(m.market_id, "1h", 30);
        const closes = candles.map((c) => c.c);
        returnsByMarket[String(m.market_id)] = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
        if (m.market_id !== target.marketId) candidates.push([m.market_id, m.symbol]);
      }
      setHedgeResult(await backendJson("/portfolio/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { market_id: target.marketId, symbol: target.symbol, signed_notional_usd: target.side === "long" ? target.notionalUsd : -target.notionalUsd },
          candidates,
          returns_by_market: returnsByMarket,
        }),
      }));
    } catch (e) {
      setToast(`Поиск хеджа недоступен: ${errorText(e)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-white font-semibold">Portfolio Risk</h2>
        <p className="text-slate-500 text-sm">
          Единая маржа Lighter: риск считается по всему набору позиций разом, а не по одной ноге. Выбираешь позиции из{" "}
          {markets.length ? `${markets.length} живых рынков ` : "списка живых рынков "}
          Lighter во вкладке «Терминал» — корреляции считаются по их часовым свечам.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-slate-500 uppercase tracking-wide">Позиции для анализа</span>
          <button
            onClick={() => setRiskPickerOpen(true)}
            className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
          >
            + Добавить
          </button>
        </div>
        {riskPositions.length === 0 ? (
          <p className="text-slate-600 text-sm py-4 text-center">Добавь хотя бы одну позицию с разных рынков, чтобы увидеть эффект диверсификации</p>
        ) : (
          <div className="space-y-2">
            {riskPositions.map((p, i) => (
              <div key={i} className="flex items-center justify-between bg-slate-800 rounded-xl px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-mono ${p.side === "long" ? "text-emerald-400" : "text-red-400"}`}>{p.side === "long" ? "LONG" : "SHORT"}</span>
                  <span className="text-slate-200 text-sm font-medium">{p.symbol}</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    value={p.notionalUsd}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRiskPositions((arr) => arr.map((x, idx) => (idx === i ? { ...x, notionalUsd: v } : x)));
                    }}
                    className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white font-mono text-xs outline-none"
                  />
                  <button onClick={() => removeRiskPosition(i)} className="text-slate-500 hover:text-red-400">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {riskPositions.length > 0 && (
          <div className="flex gap-2 mt-3">
            <button
              onClick={analyzePortfolioRisk}
              disabled={riskBusy}
              className="flex-1 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
            >
              {riskBusy ? "Считаю на реальных свечах…" : "Проанализировать"}
            </button>
            <button
              onClick={findHedge}
              disabled={riskBusy}
              className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-sm font-semibold py-2 rounded-xl transition-colors"
            >
              Найти хедж
            </button>
          </div>
        )}
      </div>

      {riskResult && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Результат</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <div className="text-slate-500 text-xs mb-1">Наивная сумма риска</div>
              <div className="text-white font-mono">${riskResult.naive_dollar_volatility.toFixed(0)}</div>
            </div>
            <div>
              <div className="text-slate-500 text-xs mb-1">Реальный риск портфеля</div>
              <div className="text-cyan-400 font-mono">${riskResult.portfolio_dollar_volatility.toFixed(0)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500" style={{ width: `${Math.max(0, riskResult.diversification_score * 100).toFixed(0)}%` }} />
            </div>
            <span className="text-xs font-mono text-slate-400">{(riskResult.diversification_score * 100).toFixed(0)}% диверсификация</span>
          </div>
        </div>
      )}

      {hedgeResult && (
        <div className="bg-slate-900 border border-amber-700 rounded-2xl p-4">
          <div className="text-xs text-amber-400 uppercase tracking-wide mb-2">Предложение хеджа</div>
          {hedgeResult.suggestion ? (
            <div>
              <p className="text-slate-200 text-sm mb-1">
                {hedgeResult.suggestion.hedge_notional_usd < 0 ? "Short" : "Long"} <span className="font-mono">${Math.abs(hedgeResult.suggestion.hedge_notional_usd).toFixed(0)}</span> {hedgeResult.suggestion.symbol}
              </p>
              <p className="text-slate-500 text-xs">
                Корреляция {(hedgeResult.suggestion.correlation_to_target * 100).toFixed(0)}%, остаточный риск ${hedgeResult.suggestion.resulting_portfolio_vol_usd.toFixed(0)}
              </p>
            </div>
          ) : (
            <p className="text-slate-500 text-sm">Хорошего хеджа среди доступных рынков не нашлось</p>
          )}
        </div>
      )}

      {riskPickerOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setRiskPickerOpen(false)}
        >
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Добавить позицию</h3>
              <button onClick={() => setRiskPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {markets.slice(0, 60).map((m) => (
                <div key={m.market_id} className="flex items-center justify-between bg-slate-800 rounded-xl px-3 py-2">
                  <span className="text-slate-200 text-sm">{m.symbol}</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => addRiskPosition(m, "long")}
                      className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
                    >
                      Long
                    </button>
                    {m.market_type === "perp" && (
                      <button
                        onClick={() => addRiskPosition(m, "short")}
                        className="bg-red-500 hover:bg-red-400 text-slate-950 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
                      >
                        Short
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {markets.length === 0 && <p className="text-slate-600 text-sm text-center py-6">Рынки ещё загружаются</p>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
