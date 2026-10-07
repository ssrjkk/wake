import { useState, useEffect } from "react";
import { X, Loader2 } from "lucide-react";
import { getCandles, type OrderBook } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import type { RiskAnalysis, HedgeSuggestion, RiskPosition } from "./types";

interface RiskProps {
  markets: OrderBook[];
  setToast: (toast: string | null) => void;
}

export default function Risk({ markets, setToast }: RiskProps) {
  const [riskPositions, setRiskPositions] = useState<RiskPosition[]>([]);
  const [riskPickerOpen, setRiskPickerOpen] = useState(false);
  const [riskResult, setRiskResult] = useState<RiskAnalysis | null>(null);
  const [hedgeResult, setHedgeResult] = useState<{ suggestion: HedgeSuggestion | null } | null>(null);
  const [riskBusy, setRiskBusy] = useState(false);

  useEffect(() => {
    if (!riskPickerOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRiskPickerOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [riskPickerOpen]);

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

      setRiskResult(await backendJson<RiskAnalysis>("/portfolio/risk", {
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
      setHedgeResult(await backendJson<{ suggestion: HedgeSuggestion | null }>("/portfolio/hedge", {
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
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Portfolio Risk</h2>
          <p style={{ fontSize: "12px", color: "#666", margin: "4px 0 0" }}>
            Единая маржа Lighter: риск считается по всему набору позиций разом, а не по одной ноге. Выбираешь позиции из{" "}
            {markets.length ? `${markets.length} живых рынков ` : "списка живых рынков "}
            Lighter во вкладке «Терминал» — корреляции считаются по их часовым свечам.
          </p>
        </div>

        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px" }}>Позиции для анализа</span>
            <button
              onClick={() => setRiskPickerOpen(true)}
              style={{ background: "#1a1a1a", color: "#fafafa", fontSize: "12px", fontWeight: 500, padding: "8px 12px", borderRadius: "4px", border: "none", cursor: "pointer", minHeight: "36px" }}
            >
              + Добавить
            </button>
          </div>
          {riskPositions.length === 0 ? (
            <p style={{ fontSize: "13px", color: "#666", padding: "16px 0", textAlign: "center", margin: 0 }}>Добавь хотя бы одну позицию с разных рынков, чтобы увидеть эффект диверсификации</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {riskPositions.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1a1a1a", borderRadius: "4px", padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: p.side === "long" ? "#10b981" : "#ef4444" }}>{p.side === "long" ? "LONG" : "SHORT"}</span>
                    <span style={{ color: "#fafafa", fontSize: "13px", fontWeight: 500 }}>{p.symbol}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <input
                      type="number"
                      value={p.notionalUsd}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setRiskPositions((arr) => arr.map((x, idx) => (idx === i ? { ...x, notionalUsd: v } : x)));
                      }}
                      style={{ width: "120px", background: "#0a0a0a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "8px", color: "#fafafa", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", outline: "none" }}
                    />
                    <button onClick={() => removeRiskPosition(i)} aria-label="Удалить позицию" style={{ color: "#666", background: "none", border: "none", cursor: "pointer", padding: "15px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <X style={{ width: "14px", height: "14px" }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {riskPositions.length > 0 && (
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <button
                onClick={() => void analyzePortfolioRisk()}
                disabled={riskBusy}
                style={{ flex: 1, background: riskBusy ? "#333" : "#3b82f6", color: "#fff", fontSize: "13px", fontWeight: 600, padding: "12px 8px", borderRadius: "4px", border: "none", cursor: riskBusy ? "not-allowed" : "pointer", minHeight: "44px" }}
              >
                {riskBusy ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                    <Loader2 style={{ width: "14px", height: "14px", animation: "spin 1s linear infinite" }} />
                    Считаю на реальных свечах…
                  </span>
                ) : "Проанализировать"}
              </button>
              <button
                onClick={() => void findHedge()}
                disabled={riskBusy}
                style={{ flex: 1, background: riskBusy ? "#333" : "#1a1a1a", color: "#fafafa", fontSize: "13px", fontWeight: 600, padding: "12px 8px", borderRadius: "4px", border: "none", cursor: riskBusy ? "not-allowed" : "pointer", minHeight: "44px" }}
              >
                Найти хедж
              </button>
            </div>
          )}
        </div>

      {riskResult && (
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "12px" }}>Результат</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Наивная сумма риска</div>
              <div style={{ color: "#fafafa", fontFamily: "JetBrains Mono, monospace" }}>${riskResult.naive_dollar_volatility.toFixed(0)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Реальный риск портфеля</div>
              <div style={{ color: "#3b82f6", fontFamily: "JetBrains Mono, monospace" }}>${riskResult.portfolio_dollar_volatility.toFixed(0)}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ flex: 1, height: "8px", background: "#1a1a1a", borderRadius: "4px", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "#10b981", width: `${Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}%` }} />
            </div>
            <span style={{ fontSize: "12px", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}% диверсификация</span>
          </div>
        </div>
      )}

      {hedgeResult && (
        <div style={{ background: "#1a1500", border: "1px solid #3d3000", borderRadius: "6px", padding: "16px" }}>
          <div style={{ fontSize: "11px", color: "#fbbf24", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>Предложение хеджа</div>
          {hedgeResult.suggestion ? (
            <div>
              <p style={{ color: "#fafafa", fontSize: "13px", marginBottom: "4px", margin: 0 }}>
                {hedgeResult.suggestion.hedge_notional_usd < 0 ? "Short" : "Long"} <span style={{ fontFamily: "JetBrains Mono, monospace" }}>${Math.abs(hedgeResult.suggestion.hedge_notional_usd).toFixed(0)}</span> {hedgeResult.suggestion.symbol}
              </p>
              <p style={{ color: "#666", fontSize: "12px", margin: 0 }}>
                Корреляция {(hedgeResult.suggestion.correlation_to_target * 100).toFixed(0)}%, остаточный риск ${hedgeResult.suggestion.resulting_portfolio_vol_usd.toFixed(0)}
              </p>
            </div>
          ) : (
            <p style={{ color: "#666", fontSize: "13px", margin: 0 }}>Хорошего хеджа среди доступных рынков не нашлось</p>
          )}
        </div>
      )}

      {riskPickerOpen && (
        <div
          style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px", backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setRiskPickerOpen(false)}
        >
          <div style={{ width: "100%", maxWidth: "380px", background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "20px", maxHeight: "70vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
              <h3 style={{ color: "#fafafa", fontWeight: 600, fontSize: "14px", margin: 0 }}>Добавить позицию</h3>
              <button onClick={() => setRiskPickerOpen(false)} aria-label="Закрыть" style={{ color: "#666", background: "none", border: "none", cursor: "pointer", padding: "12px", display: "flex" }}>
                <X style={{ width: "20px", height: "20px" }} />
              </button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {markets.slice(0, 60).map((m) => (
                <div key={m.market_id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#1a1a1a", borderRadius: "4px", padding: "8px 12px" }}>
                  <span style={{ color: "#fafafa", fontSize: "13px" }}>{m.symbol}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      onClick={() => addRiskPosition(m, "long")}
                      style={{ background: "#10b981", color: "#fff", fontSize: "12px", fontWeight: 600, padding: "8px 14px", borderRadius: "4px", border: "none", cursor: "pointer", minHeight: "44px" }}
                    >
                      Long
                    </button>
                    {m.market_type === "perp" && (
                      <button
                        onClick={() => addRiskPosition(m, "short")}
                        style={{ background: "#ef4444", color: "#fff", fontSize: "12px", fontWeight: 600, padding: "8px 14px", borderRadius: "4px", border: "none", cursor: "pointer", minHeight: "44px" }}
                      >
                        Short
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {markets.length === 0 && <p style={{ color: "#666", fontSize: "13px", textAlign: "center", padding: "24px 0", margin: 0 }}>Рынки ещё загружаются</p>}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
