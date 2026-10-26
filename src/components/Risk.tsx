import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { getCandles, openInterestUsd, type OrderBook } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import { Modal } from "./ui";
import type { RiskAnalysis, HedgeSuggestion, RiskPosition } from "./types";

/** Простые доходности по закрытиям. Нулевое закрытие — отсутствующие данные:
 *  деление на него даёт Infinity, а Infinity в ряду превращает волатильность
 *  портфеля в Infinity, которое бэкенд уже не может отдать как JSON. */
function closesToReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const current = closes[i];
    if (!(prev > 0) || !Number.isFinite(current)) continue;
    out.push((current - prev) / prev);
  }
  return out;
}

interface RiskProps {
  markets: OrderBook[];
  setToast: (toast: string | null) => void;
}

export default function Risk({ markets, setToast }: RiskProps) {
  const [riskPositions, setRiskPositions] = useState<RiskPosition[]>([]);
  const [riskPickerOpen, setRiskPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [riskResult, setRiskResult] = useState<RiskAnalysis | null>(null);
  const [hedgeResult, setHedgeResult] = useState<{ target: RiskPosition; suggestion: HedgeSuggestion | null } | null>(null);
  const [hedgeTarget, setHedgeTarget] = useState(0);
  const [riskBusy, setRiskBusy] = useState(false);

  // Поиск по списку: 225 живых рынков и «первые 60 в порядке книги» — это не
  // выбор, а лотерея. Cap оставлен, но считается уже по совпадениям.
  const pickerMatches = (() => {
    const q = pickerQuery.trim().toUpperCase();
    const base = q ? markets.filter((m) => m.symbol.toUpperCase().includes(q)) : markets;
    return base.slice(0, 60);
  })();

  function addRiskPosition(m: OrderBook, side: "long" | "short") {
    setRiskPositions((p) => [...p, { marketId: m.market_id, symbol: m.symbol, notionalUsd: 1000, side }]);
    setRiskPickerOpen(false);
    setPickerQuery("");
  }

  function removeRiskPosition(i: number) {
    setRiskPositions((p) => p.filter((_, idx) => idx !== i));
    setRiskResult(null);
    setHedgeResult(null);
  }

  async function analyzePortfolioRisk() {
    if (riskPositions.length < 1) {
      setToast("Добавь хотя бы одну позицию");
      return;
    }
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      // Свечи независимых рынков читаются параллельно: последовательный цикл на
      // корзине из пяти позиций это пять сетевых RTT подряд, и панель «думает»
      // столько, сколько осталось живых свечей у самого медленного рынка.
      const series = await Promise.all(
        riskPositions.map(async (pos) => {
          const candles = await getCandles(pos.marketId, "1h", 30);
          return [pos.marketId, closesToReturns(candles.map((c) => c.c))] as const;
        })
      );
      const returnsByMarket: Record<string, number[]> = Object.fromEntries(
        series.map(([id, returns]) => [String(id), returns])
      );

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
    // Цель хеджа выбирается явно и подписана в карточке результата: молча хеджировать
    // riskPositions[0] значило бы, что при пяти позициях человек получал предложение
    // для первой из них, никак об этом не узнав.
    const target = riskPositions[Math.min(hedgeTarget, riskPositions.length - 1)];
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      // Вселенная кандидатов — 15 рынков с наибольшим открытым интересом в
      // долларах, а не «первые 15 по индексу книги»: best hedge зависел от того,
      // какие строки Lighter вернул раньше, и в списке без ликвидного контрагента
      // предложение было бы недостижимым. Interest считается из строки книги один
      // раз, а не по два раза на каждое сравнение.
      const pool = markets
        .filter((m) => m.status === "active")
        .map((m) => ({ market: m, interest: openInterestUsd(m) }))
        .filter((row) => row.interest > 0)
        .sort((a, b) => b.interest - a.interest)
        .slice(0, 15)
        .map((row) => row.market);
      const series = await Promise.all(
        pool.map(async (m) => {
          const candles = await getCandles(m.market_id, "1h", 30);
          return [m, closesToReturns(candles.map((c) => c.c))] as const;
        })
      );
      const returnsByMarket: Record<string, number[]> = {};
      const candidates: [number, string][] = [];
      for (const [m, returns] of series) {
        returnsByMarket[String(m.market_id)] = returns;
        if (m.market_id !== target.marketId) candidates.push([m.market_id, m.symbol]);
      }
      const data = await backendJson<{ suggestion: HedgeSuggestion | null }>("/portfolio/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { market_id: target.marketId, symbol: target.symbol, signed_notional_usd: target.side === "long" ? target.notionalUsd : -target.notionalUsd },
          candidates,
          returns_by_market: returnsByMarket,
        }),
      });
      // Цель запоминается вместе с предложением: если человек после расчёта
      // переключит селектор, карточка не должна начинать врать, к кому она.
      setHedgeResult({ target, suggestion: data.suggestion });
    } catch (e) {
      setToast(`Поиск хеджа недоступен: ${errorText(e)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Риск корзины</h2>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "4px 0 0" }}>
            Единая маржа Lighter: риск считается по всему набору позиций разом, а не по одной ноге. Выбираешь позиции из{" "}
            {markets.length ? `${markets.length} живых рынков ` : "списка живых рынков "}
            Lighter во вкладке «Терминал» — корреляции считаются по их часовым свечам.
          </p>
        </div>

        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Позиции для анализа</span>
            <button
              onClick={() => setRiskPickerOpen(true)}
              style={{ background: "var(--bg-2)", color: "var(--fg)", fontSize: "12px", fontWeight: 500, padding: "8px 12px", borderRadius: "4px", border: "none", cursor: "pointer", minHeight: "var(--touch)" }}
            >
              + Добавить
            </button>
          </div>
          {riskPositions.length === 0 ? (
            <p style={{ fontSize: "13px", color: "var(--text-muted)", padding: "16px 0", textAlign: "center", margin: 0 }}>Добавь хотя бы одну позицию с разных рынков, чтобы увидеть эффект диверсификации</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {riskPositions.map((p, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--bg-2)", borderRadius: "4px", padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "11px", fontFamily: "JetBrains Mono, monospace", color: p.side === "long" ? "var(--up)" : "var(--down)" }}>{p.side === "long" ? "LONG" : "SHORT"}</span>
                    <span style={{ color: "var(--fg)", fontSize: "13px", fontWeight: 500 }}>{p.symbol}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <input
                      type="number"
                      aria-label={`Нотионал позиции ${p.symbol}, USD`}
                      min={0}
                      step={100}
                      value={p.notionalUsd}
                      onChange={(e) => {
                        const raw = e.target.valueAsNumber;
                        const v = Number.isFinite(raw) ? raw : 0;
                        setRiskPositions((arr) => arr.map((x, idx) => (idx === i ? { ...x, notionalUsd: v } : x)));
                      }}
                      className="input-mono"
                      style={{ width: "120px" }}
                    />
                    <button onClick={() => removeRiskPosition(i)} aria-label="Удалить позицию" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "15px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <X style={{ width: "14px", height: "14px" }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {riskPositions.length > 0 && (
            <div style={{ display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => void analyzePortfolioRisk()}
                disabled={riskBusy}
                className="btn-primary"
                style={{ flex: 1, minWidth: "160px" }}
              >
                {riskBusy ? (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                    <Loader2 style={{ width: "14px", height: "14px", animation: "spin 1s linear infinite" }} />
                    Считаю на реальных свечах…
                  </span>
                ) : "Проанализировать"}
              </button>
              {riskPositions.length > 1 && (
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--text-muted)" }}>
                  хедж для
                  <select
                    aria-label="Позиция, для которой ищется хедж"
                    value={Math.min(hedgeTarget, riskPositions.length - 1)}
                    onChange={(e) => setHedgeTarget(Number(e.target.value))}
                    style={{ background: "var(--on-accent)", color: "var(--fg)", border: "1px solid var(--line-strong)", borderRadius: "4px", padding: "8px", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", minHeight: "var(--touch)" }}
                  >
                    {riskPositions.map((p, i) => (
                      <option key={`${p.marketId}:${i}`} value={i}>
                        {p.symbol} · {p.side}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                onClick={() => void findHedge()}
                disabled={riskBusy || riskPositions.length < 1}
                style={{ flex: 1, minWidth: "140px", background: riskBusy ? "var(--line-strong)" : "var(--bg-2)", color: "var(--fg)", fontSize: "13px", fontWeight: 600, padding: "12px 8px", borderRadius: "4px", border: "1px solid var(--line-strong)", cursor: riskBusy ? "not-allowed" : "pointer", minHeight: "44px" }}
              >
                Найти хедж
              </button>
            </div>
          )}
        </div>

      {riskResult && (
        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "12px" }}>Результат</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>Наивная сумма риска</div>
              <div style={{ color: "var(--fg)", fontFamily: "JetBrains Mono, monospace" }}>${riskResult.naive_dollar_volatility.toFixed(0)}</div>
            </div>
            <div>
              <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "4px" }}>Реальный риск портфеля</div>
              <div style={{ color: "var(--info)", fontFamily: "JetBrains Mono, monospace" }}>${riskResult.portfolio_dollar_volatility.toFixed(0)}</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ flex: 1, height: "8px", background: "var(--bg-2)", borderRadius: "4px", overflow: "hidden" }}>
              <div style={{ height: "100%", background: "var(--up)", width: `${Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}%` }} />
            </div>
            <span style={{ fontSize: "12px", fontFamily: "JetBrains Mono, monospace", color: "var(--fg-2)" }}>{Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}% диверсификация</span>
          </div>
        </div>
      )}

      {hedgeResult && (
        <div style={{ background: "var(--warn-faint)", border: "1px solid var(--warn-line)", borderRadius: "6px", padding: "16px" }}>
          <div style={{ fontSize: "11px", color: "var(--warn)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>
            Хедж к {hedgeResult.target.symbol} ({hedgeResult.target.side})
          </div>
          {hedgeResult.suggestion ? (
            <div>
              <p style={{ color: "var(--fg)", fontSize: "13px", margin: "0 0 4px" }}>
                {hedgeResult.suggestion.hedge_notional_usd < 0 ? "Short" : "Long"}{" "}
                <span style={{ fontFamily: "JetBrains Mono, monospace" }}>
                  ${Math.abs(hedgeResult.suggestion.hedge_notional_usd).toFixed(0)}
                </span>{" "}
                {hedgeResult.suggestion.symbol}
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: "12px", margin: 0 }}>
                Корреляция {(hedgeResult.suggestion.correlation_to_target * 100).toFixed(0)}% · риск позиции{" "}
                <span style={{ fontFamily: "JetBrains Mono, monospace" }}>${hedgeResult.suggestion.unhedged_vol_usd.toFixed(0)}</span> → с хеджем{" "}
                <span style={{ fontFamily: "JetBrains Mono, monospace", color: "var(--up)" }}>
                  ${hedgeResult.suggestion.resulting_portfolio_vol_usd.toFixed(0)}
                </span>{" "}
                на час
              </p>
            </div>
          ) : (
            <p style={{ color: "var(--text-muted)", fontSize: "13px", margin: 0 }}>
              Среди 15 рынков с наибольшим открытым интересом нет такого, рядом с которым риск этой позиции снижается.
            </p>
          )}
        </div>
      )}

      {riskPickerOpen && (
        <Modal label="Добавить позицию" onClose={() => setRiskPickerOpen(false)}>
          <div className="overlay-shell" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <h3>Добавить позицию</h3>
              <button
                onClick={() => setRiskPickerOpen(false)}
                className="overlay-close"
                aria-label="Закрыть"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              data-autofocus=""
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Поиск по символу…"
              aria-label="Поиск рынка для добавления"
              className="input-mono w-full"
            />
            <div className="picker-list">
              {pickerMatches.length === 0 && (
                <p className="muted picker-empty">
                  {markets.length === 0 ? "Рынки ещё загружаются" : `По «${pickerQuery}» совпадений нет`}
                </p>
              )}
              {pickerMatches.map((m) => (
                <div key={m.market_id} className="picker-row">
                  <span style={{ color: "var(--fg)", fontSize: "var(--fs-ui)" }}>{m.symbol}</span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button onClick={() => addRiskPosition(m, "long")} className="btn-primary btn-up">
                      Long
                    </button>
                    {m.market_type === "perp" && (
                      <button onClick={() => addRiskPosition(m, "short")} className="btn-primary btn-down">
                        Short
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
      </div>
    </div>
  );
}
