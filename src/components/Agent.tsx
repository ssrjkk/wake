import { useState, useEffect } from "react";
import { Zap, AlertTriangle } from "lucide-react";
import { getCandles, type Candle, type OrderBook, type Resolution } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import { fmt, usd } from "./utils";
import type { Subscription } from "./types";

interface AgentProps {
  followerId: string | null;
  subscription: Subscription | null;
  currentMarket: OrderBook | undefined;
  setToast: (toast: string | null) => void;
  startTrial: () => void;
}

type MemoryView = {
  summary: string;
  open_trades: { id: string; market_id: number; side: string; entry_price: number; size: number }[];
  closed_trades: { id: string; market_id: number; side: string; entry_price: number; size: number; exit_price: number }[];
  win_rate: number | null;
  volume_today_usd: number;
};

type Decision = {
  action: string;
  confidence: number;
  size_usd: number;
  reasoning: string;
  execution: { status: string; reason?: string; error?: string; tx_hash?: string } | null;
  volume_today_usd: number;
};

const RESOLUTIONS: Resolution[] = ["5m", "15m", "1h", "4h", "1d"];

// Тот же горизонт, что считает эвристика: решение берётся по последним 10 закрытиями,
// но в бэкенд уходит больше точек, чтобы память LLM-ветки видела контекст.
const POINTS_SENT = 40;

const EXECUTION_STYLE: Record<string, { bg: string; color: string; border?: string }> = {
  dry_run: { bg: "#0a1a2a", color: "#3b82f6", border: "#1a3050" },
  sent: { bg: "#0a2a1a", color: "#10b981", border: "#1a3d2a" },
  blocked_by_risk_limit: { bg: "#2a2000", color: "#fbbf24", border: "#3d3000" },
  skipped: { bg: "#1a1a1a", color: "#a0a0a0" },
  failed: { bg: "#2a0a0a", color: "#ef4444", border: "#3d1a1a" },
};

export default function Agent({ followerId, subscription, currentMarket, setToast, startTrial }: AgentProps) {
  const [resolution, setResolution] = useState<Resolution>("1h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [baseSizeUsd, setBaseSizeUsd] = useState(100);
  const [busy, setBusy] = useState(false);
  const [lastDecision, setLastDecision] = useState<Decision | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentMarket) return;
    let cancelled = false;
    async function load() {
      try {
        const c = await getCandles(currentMarket!.market_id, resolution, POINTS_SENT);
        if (!cancelled) {
          setCandles(c);
          setCandlesError(null);
        }
      } catch (e) {
        if (!cancelled) setCandlesError(errorText(e));
      }
    }
    void load();
    const id = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currentMarket?.market_id, resolution]);

  useEffect(() => {
    if (!followerId) {
      setMemory(null);
      return;
    }
    backendJson<MemoryView>(`/agent/memory/${followerId}`)
      .then((m) => {
        setMemory(m);
        setMemoryError(null);
      })
      .catch((e) => {
        setMemory(null);
        setMemoryError(errorText(e));
      });
  }, [followerId, lastDecision]);

  const prices = (candles ?? []).map((c) => c.c);
  const spot = prices.length ? prices[prices.length - 1] : null;

  async function runAgentStep() {
    if (!followerId) {
      setToast("Сначала войди через Telegram или кошелёк");
      return;
    }
    if (!currentMarket || prices.length < 2) {
      setToast("Нет свечей Lighter по этому рынку — агенту не на чём считать момент");
      return;
    }
    setBusy(true);
    try {
      const data = await backendJson<Decision>("/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: followerId,
          market_id: currentMarket.market_id,
          recent_prices: prices.slice(-POINTS_SENT),
          size_decimals: currentMarket.supported_size_decimals,
          price_decimals: currentMarket.supported_price_decimals,
          base_size_usd: baseSizeUsd,
        }),
      });
      setLastDecision(data);
      const exec = data.execution ? ` → ${data.execution.status}` : "";
      setToast(`Агент: ${data.action} (${(data.confidence * 100).toFixed(0)}% увер.)${exec}`);
    } catch (e) {
      setToast(`Агент недоступен: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Агент</h2>
          <p style={{ fontSize: "12px", color: "#666", margin: "4px 0 0" }}>
            Момент-эвристика по закрытиям свечей Lighter, поверх неё — LLM-рассуждение с откатом на эвристику, если ответы модели нет. Свечи читаются
            здесь же, через публичный <code style={{ color: "#a0a0a0" }}>GET /candles</code>.
          </p>
        </div>

      {!subscription?.has_ai_agent ? (
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Zap style={{ width: "24px", height: "24px", color: "#666" }} />
          </div>
          <p style={{ fontSize: "14px", color: "#a0a0a0", marginBottom: "4px" }}>
            {subscription?.tier === "free" ? "Пробный период закончился" : "Агент доступен на trial или Pro"}
          </p>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "12px", maxWidth: "320px" }}>
            Статус подписки читается с <code style={{ color: "#a0a0a0" }}>GET /subscription/&lt;follower_id&gt;</code>; без входа через Telegram или
            кошелёк её не на что заводить.
          </p>
          <button onClick={startTrial} style={{ background: "#3b82f6", color: "#fff", fontSize: "13px", fontWeight: 600, padding: "10px 16px", borderRadius: "4px", border: "none", cursor: "pointer", minHeight: "44px" }}>
            Начать 14-дневный trial
          </button>
          <p style={{ fontSize: "11px", color: "#666", marginTop: "12px", maxWidth: "320px", lineHeight: 1.5 }}>
            Trial заводится без оплаты. «pro» включает <code style={{ color: "#a0a0a0" }}>POST /subscription/&lt;follower_id&gt;/upgrade</code> прямо на
            бэкенде — платёжного пути в репозитории нет, и кнопкой в интерфейсе это не делается. Строки подписки живут в памяти процесса
            (<code style={{ color: "#a0a0a0" }}>api/agent.py</code>): после рестарта бэкенда подписка снова «none».
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {subscription.days_left_in_trial != null && (
            <div style={{ fontSize: "12px", color: "#fbbf24" }}>Trial: {subscription.days_left_in_trial.toFixed(1)} дней осталось</div>
          )}

          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {currentMarket?.symbol ?? "рынок не выбран"}
                  {spot != null && <span style={{ fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0", marginLeft: "8px", textTransform: "none" }}>{usd(spot, currentMarket?.supported_price_decimals ?? 2)}</span>}
                </span>
                <div style={{ display: "flex", gap: "4px" }}>
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setResolution(r)}
                      style={{ padding: "4px 8px", borderRadius: "3px", fontSize: "12px", fontFamily: "JetBrains Mono, monospace", background: resolution === r ? "#3b82f6" : "#1a1a1a", color: resolution === r ? "#fff" : "#a0a0a0", border: "none", cursor: "pointer", minHeight: "32px" }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <label style={{ fontSize: "12px", color: "#666", display: "flex", alignItems: "center" }}>
                  Базовый размер $
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={baseSizeUsd}
                    onChange={(e) => setBaseSizeUsd(Math.max(0, Number(e.target.value)))}
                    style={{ marginLeft: "6px", background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "8px", width: "100px", color: "#fafafa", fontSize: "13px", fontFamily: "JetBrains Mono, monospace", outline: "none" }}
                  />
                </label>
                <button
                  onClick={() => void runAgentStep()}
                  disabled={busy || candles == null || prices.length < 2}
                  style={{ background: busy || candles == null || prices.length < 2 ? "#333" : "#3b82f6", color: "#fff", fontSize: "12px", fontWeight: 600, padding: "8px 12px", borderRadius: "4px", border: "none", cursor: busy || candles == null || prices.length < 2 ? "not-allowed" : "pointer", minHeight: "44px" }}
                >
                  {busy ? "Считаю…" : "Спросить агента"}
                </button>
              </div>
            </div>

            {candlesError ? (
              <p style={{ fontSize: "12px", color: "#fbbf24", display: "flex", alignItems: "center", gap: "6px", margin: 0 }}>
                <AlertTriangle style={{ width: "14px", height: "14px" }} /> Lighter не отдал свечи: {candlesError}
              </p>
            ) : candles == null ? (
              <p style={{ fontSize: "13px", color: "#666", margin: 0 }}>Читаю {POINTS_SENT} свечей по {resolution}…</p>
            ) : (
              <p style={{ fontSize: "12px", color: "#666", margin: 0 }}>
                {prices.length} закрытий по {resolution}, последние {Math.min(10, prices.length)} — окно, по которому считается момент.
              </p>
            )}

            {lastDecision && (
              <div style={{ marginTop: "12px", borderTop: "1px solid #1e1e1e", paddingTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                  <span
                    style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", fontWeight: 700, color: lastDecision.action === "long" ? "#10b981" : lastDecision.action === "short" ? "#ef4444" : "#a0a0a0" }}
                  >
                    {lastDecision.action.toUpperCase()}
                  </span>
                  <span style={{ fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>
                    {(lastDecision.confidence * 100).toFixed(0)}% уверенность (самоотчёт)
                  </span>
                  {lastDecision.size_usd > 0 && <span style={{ fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>{usd(lastDecision.size_usd, 0)}</span>}
                  {lastDecision.execution && (
                    <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "3px", background: EXECUTION_STYLE[lastDecision.execution.status]?.bg ?? "#1a1a1a", color: EXECUTION_STYLE[lastDecision.execution.status]?.color ?? "#a0a0a0", border: EXECUTION_STYLE[lastDecision.execution.status]?.border ? `1px solid ${EXECUTION_STYLE[lastDecision.execution.status].border}` : "none" }}>
                      {lastDecision.execution.status}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: "12px", color: "#666", margin: 0 }}>{lastDecision.reasoning}</p>
                {lastDecision.execution?.reason && <p style={{ fontSize: "12px", color: "#fbbf24", marginTop: "4px", margin: 0 }}>{lastDecision.execution.reason}</p>}
                {lastDecision.execution?.error && <p style={{ fontSize: "12px", color: "#ef4444", marginTop: "4px", margin: 0 }}>{String(lastDecision.execution.error).slice(0, 160)}</p>}
                {lastDecision.execution?.tx_hash && (
                  <p style={{ fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace", marginTop: "4px", margin: 0 }}>tx {String(lastDecision.execution.tx_hash).slice(0, 18)}…</p>
                )}
              </div>
            )}
          </div>

          {memoryError && (
            <div style={{ padding: "10px 16px", background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "6px", fontSize: "12px", color: "#ef4444" }}>
              Не удалось загрузить память агента: {memoryError}
            </div>
          )}
          {memory && (
            <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px" }}>Память агента</span>
                <span style={{ fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>
                  {memory.open_trades.length} открыто · {memory.closed_trades.length} закрыто ·{" "}
                  {memory.win_rate == null ? "нет закрытых сделок" : `${(memory.win_rate * 100).toFixed(0)}% в плюс`} · объём за день{" "}
                  {usd(memory.volume_today_usd, 0)}
                </span>
              </div>
              <pre style={{ fontSize: "12px", color: "#a0a0a0", whiteSpace: "pre-wrap", fontFamily: "JetBrains Mono, monospace", marginBottom: "12px" }}>{memory.summary}</pre>
              {memory.open_trades.length > 0 && (
                <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                <table style={{ width: "100%", fontSize: "12px", minWidth: "400px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Рынок</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Сторона</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Вход</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Объём</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.open_trades.slice(-8).reverse().map((t) => (
                      <tr key={t.id} style={{ borderBottom: "1px solid #1e1e1e" }}>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>#{t.market_id}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: t.side === "long" ? "#10b981" : "#ef4444" }}>{t.side}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(t.entry_price, 2)}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(t.size, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}

          <p style={{ fontSize: "12px", color: "#666" }}>
            Решение считается на сервере (<code style={{ color: "#a0a0a0" }}>backend/agent_runner.py</code>), перед этим проходит{" "}
            <code style={{ color: "#a0a0a0" }}>risk_limits.check_order()</code>. При <code style={{ color: "#a0a0a0" }}>WAKE_DRY_RUN=true</code>{" "}
            (по умолчанию) ордер на Lighter не отправляется — статус <code style={{ color: "#a0a0a0" }}>dry_run</code>, но сделка записывается в память
            агента, чтобы ветка с закрытием и win_rate тоже были живыми. Память и счётчик дневного объёма живут в процессе и обнуляются при рестарте
            сервиса.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
