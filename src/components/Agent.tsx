import { useState, useEffect } from "react";
import { Zap, AlertTriangle } from "lucide-react";
import { getCandles, type Candle, type OrderBook, type Resolution } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import { fmt, usd } from "./utils";
import type { Subscription } from "./types";

interface AgentProps {
  signedIn: boolean;
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
  execution: {
    status: string;
    reason?: string;
    error?: string;
    tx_hash?: string;
    // Приходит только при статусе unknown: по нему ордер находится в Lighter.
    client_order_index?: number;
  } | null;
  volume_today_usd: number;
  // Что бэкенд реально положил в основу решения: ряд цен и шаг рынка он берёт из
  // Lighter сам, поэтому сверять надо с этим, а не с тем, что насчитала панель.
  data?: {
    symbol: string;
    resolution: string;
    candles_used: number;
    last_price: number;
    network: string;
  };
};

const RESOLUTIONS: Resolution[] = ["5m", "15m", "1h", "4h", "1d"];

// Тот же горизонт, что считает эвристика: решение берётся по всему ряду,
// который запрашивается здесь же, — но сам ряд читает бэкенд из Lighter, а не из
// тела запроса (см. backend/api/agent.py), поэтому эти точки нужны графику и
// сверке, а не решению.
const POINTS_SENT = 40;

const EXECUTION_STYLE: Record<string, { bg: string; color: string; border?: string }> = {
  dry_run: { bg: "var(--info-faint)", color: "var(--info)", border: "var(--info-line)" },
  sent: { bg: "var(--up-faint)", color: "var(--up)", border: "var(--up-line)" },
  blocked_by_risk_limit: { bg: "var(--warn-faint)", color: "var(--warn)", border: "var(--warn-line)" },
  skipped: { bg: "var(--bg-2)", color: "var(--fg-2)" },
  failed: { bg: "var(--down-faint)", color: "var(--down-hi)", border: "var(--down-line)" },
  // Не «не удалось», а «неизвестно»: запрос мог дойти до сервиса подписи, и
  // повтор шага — это второй ордер. Цвет тот же, что у отказа, смысл другой.
  unknown: { bg: "var(--warn-faint)", color: "var(--warn)", border: "var(--warn-line)" },
};

export default function Agent({ signedIn, subscription, currentMarket, setToast, startTrial }: AgentProps) {
  const [resolution, setResolution] = useState<Resolution>("1h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [baseSizeUsd, setBaseSizeUsd] = useState(100);
  const [busy, setBusy] = useState(false);
  const [lastDecision, setLastDecision] = useState<Decision | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [memoryError, setMemoryError] = useState<string | null>(null);

  const marketId = currentMarket?.market_id;

  useEffect(() => {
    if (marketId == null) return;
    let cancelled = false;
    async function load() {
      try {
        const c = await getCandles(marketId!, resolution, POINTS_SENT);
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
  }, [marketId, resolution]);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    backendJson<MemoryView>("/agent/memory")
      .then((m) => {
        if (!live) return;
        setMemory(m);
        setMemoryError(null);
      })
      .catch((e) => {
        if (!live) return;
        setMemory(null);
        setMemoryError(errorText(e));
      });
    return () => { live = false; };
  }, [signedIn, lastDecision]);

  const prices = (candles ?? []).map((c) => c.c);
  const spot = prices.length ? prices[prices.length - 1] : null;

  async function runAgentStep() {
    if (!signedIn) {
      setToast("Сначала войди через Telegram или кошелёк");
      return;
    }
    if (!currentMarket || prices.length < 2) {
      setToast("Нет свечей Lighter по этому рынку — агенту не на чём считать момент");
      return;
    }
    // Бэкенд отклоняет base_size_usd <= 0 валидацией (AgentStepRequest). Отказ
    // верный, но в поле с нулём человек получил бы 422 без объяснения.
    if (!(baseSizeUsd > 0)) {
      setToast("Базовый размер должен быть больше нуля — агент считает от него размер копии");
      return;
    }
    setBusy(true);
    try {
      // Ряд цен и шаг рынка бэкенд берёт сам: решение, цена исполнения и
      // дневные лимиты считаются по одним и тем же свечам Lighter, а не по тем,
      // что прислал браузер. От панели уходит только выбор рынка и горизонта.
      const data = await backendJson<Decision>("/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market_id: currentMarket.market_id,
          resolution,
          candles: POINTS_SENT,
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
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Агент</h2>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "4px 0 0" }}>
            Момент-эвристика по закрытиям свечей Lighter, поверх неё — LLM-рассуждение с откатом на эвристику, если ответы модели нет. Свечи читаются
            здесь же, через публичный <code style={{ color: "var(--fg-2)" }}>GET /candles</code>.
          </p>
        </div>

      {!subscription?.has_ai_agent ? (
        <div className="empty-state">
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "var(--bg-2)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Zap style={{ width: "24px", height: "24px", color: "var(--text-muted)" }} />
          </div>
          <p style={{ fontSize: "14px", color: "var(--fg-2)", marginBottom: "4px" }}>
            {subscription?.tier === "free" ? "Пробный период закончился" : "Агент доступен на trial или Pro"}
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", maxWidth: "320px" }}>
            Статус подписки читается с <code style={{ color: "var(--fg-2)" }}>GET /subscription</code> — того, кому он принадлежит, решает токен входа; без
            Telegram или кошелька её не на что заводить.
          </p>
          <button className="btn-primary" onClick={startTrial}>Начать 14-дневный trial</button>
          <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "12px", maxWidth: "320px", lineHeight: 1.5 }}>
            Trial заводится без оплаты, один раз на аккаунт. «pro» включает <code style={{ color: "var(--fg-2)" }}>POST /subscription/&lt;user_id&gt;/upgrade</code>{" "}
            на бэкенде под токеном куратора — платёжного пути в репозитории нет, и кнопкой в интерфейсе это не делается. Строки подписки лежат в{" "}
            <code style={{ color: "var(--fg-2)" }}>subscriptions</code> (<code style={{ color: "var(--fg-2)" }}>agent_db.py</code>) и переживают рестарт сервиса.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {subscription.days_left_in_trial != null && (
            <div style={{ fontSize: "12px", color: "var(--warn)" }}>Trial: {subscription.days_left_in_trial.toFixed(1)} дней осталось</div>
          )}

          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  {currentMarket?.symbol ?? "рынок не выбран"}
                  {spot != null && <span style={{ fontFamily: "JetBrains Mono, monospace", color: "var(--fg-2)", marginLeft: "8px", textTransform: "none" }}>{usd(spot, currentMarket?.supported_price_decimals ?? 2)}</span>}
                </span>
                <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setResolution(r)}
                      aria-pressed={resolution === r}
                      className={resolution === r ? "chip chip-accent" : "chip"}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <label style={{ fontSize: "12px", color: "var(--text-muted)", display: "flex", alignItems: "center" }}>
                  Базовый размер $
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={baseSizeUsd}
                    onChange={(e) => setBaseSizeUsd(Math.max(0, Number(e.target.value)))}
                    className="input-mono"
                    style={{ marginLeft: "6px", width: "100px" }}
                  />
                </label>
                <button
                  onClick={() => void runAgentStep()}
                  disabled={busy || candles == null || prices.length < 2}
                  className="btn-primary"
                >
                  {busy ? "Считаю…" : "Спросить агента"}
                </button>
              </div>
            </div>

            {candlesError ? (
              <p style={{ fontSize: "12px", color: "var(--warn)", display: "flex", alignItems: "center", gap: "6px", margin: 0 }}>
                <AlertTriangle style={{ width: "14px", height: "14px" }} /> Lighter не отдал свечи: {candlesError}
              </p>
            ) : candles == null ? (
              <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>Читаю {POINTS_SENT} свечей по {resolution}…</p>
            ) : (
              <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>
                {lastDecision?.data
                  ? `${lastDecision.data.candles_used} закрытий ${lastDecision.data.resolution} с ${lastDecision.data.network} — ряд забрал бэкенд, последнее ${fmt(lastDecision.data.last_price, currentMarket?.supported_price_decimals ?? 2)}.`
                  : `${prices.length} закрытий по ${resolution}, последние ${Math.min(10, prices.length)} — окно, по которому считается момент; ряд для решения берёт бэкенд.`}
              </p>
            )}

            {lastDecision && (
              <div style={{ marginTop: "12px", borderTop: "1px solid var(--line)", paddingTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                  <span
                    style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", fontWeight: 700, color: lastDecision.action === "long" ? "var(--up)" : lastDecision.action === "short" ? "var(--down)" : "var(--fg-2)" }}
                  >
                    {lastDecision.action.toUpperCase()}
                  </span>
                  <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                    {(lastDecision.confidence * 100).toFixed(0)}% уверенность (самоотчёт)
                  </span>
                  {lastDecision.size_usd > 0 && <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>{usd(lastDecision.size_usd, 0)}</span>}
                  {lastDecision.execution && (
                    <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "3px", background: EXECUTION_STYLE[lastDecision.execution.status]?.bg ?? "var(--bg-2)", color: EXECUTION_STYLE[lastDecision.execution.status]?.color ?? "var(--fg-2)", border: EXECUTION_STYLE[lastDecision.execution.status]?.border ? `1px solid ${EXECUTION_STYLE[lastDecision.execution.status].border}` : "none" }}>
                      {lastDecision.execution.status}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: 0 }}>{lastDecision.reasoning}</p>
                {lastDecision.execution?.reason && <p style={{ fontSize: "12px", color: "var(--warn)", margin: "4px 0 0" }}>{lastDecision.execution.reason}</p>}
                {lastDecision.execution?.error && <p style={{ fontSize: "12px", color: "var(--down)", margin: "4px 0 0" }}>{String(lastDecision.execution.error).slice(0, 160)}</p>}
                {lastDecision.execution?.client_order_index != null && (
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace", margin: "4px 0 0" }}>
                    ордер #{lastDecision.execution.client_order_index} — по нему видно в Lighter, исполнился он или нет
                  </p>
                )}
                {lastDecision.execution?.tx_hash && (
                  <p style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace", margin: "4px 0 0" }}>tx {String(lastDecision.execution.tx_hash).slice(0, 18)}…</p>
                )}
              </div>
            )}
          </div>

          {memoryError && (
            <div className="notice notice-error">
              Не удалось загрузить память агента: {memoryError}
            </div>
          )}
          {memory && (
            <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <span style={{ fontSize: "11px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Память агента</span>
                <span style={{ fontSize: "12px", color: "var(--text-muted)", fontFamily: "JetBrains Mono, monospace" }}>
                  {memory.open_trades.length} открыто · {memory.closed_trades.length} закрыто ·{" "}
                  {memory.win_rate == null ? "нет закрытых сделок" : `${(memory.win_rate * 100).toFixed(0)}% в плюс`} · объём за день{" "}
                  {usd(memory.volume_today_usd, 0)}
                </span>
              </div>
              <pre style={{ fontSize: "12px", color: "var(--fg-2)", whiteSpace: "pre-wrap", fontFamily: "JetBrains Mono, monospace", marginBottom: "12px" }}>{memory.summary}</pre>
              {memory.open_trades.length > 0 && (
                <div className="table-scroll">
                <table style={{ width: "100%", fontSize: "12px", minWidth: "400px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: "11px", color: "var(--text-muted)", borderBottom: "1px solid var(--line)" }}>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Рынок</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Сторона</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Вход</th>
                      <th style={{ padding: "6px 0", fontWeight: 400 }}>Объём</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.open_trades.slice(-8).reverse().map((t) => (
                      <tr key={t.id} style={{ borderBottom: "1px solid var(--line)" }}>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "var(--fg-2)" }}>#{t.market_id}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: t.side === "long" ? "var(--up)" : "var(--down)" }}>{t.side}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "var(--fg-2)" }}>{fmt(t.entry_price, 2)}</td>
                        <td style={{ padding: "6px 0", fontFamily: "JetBrains Mono, monospace", color: "var(--fg-2)" }}>{fmt(t.size, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}

          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Решение считается на сервере (<code style={{ color: "var(--fg-2)" }}>backend/agent_runner.py</code>), перед этим проходит{" "}
            <code style={{ color: "var(--fg-2)" }}>risk_limits.check_order()</code>. При <code style={{ color: "var(--fg-2)" }}>WAKE_DRY_RUN=true</code>{" "}
            (по умолчанию) ордер на Lighter не отправляется — статус <code style={{ color: "var(--fg-2)" }}>dry_run</code>, но сделка записывается в память
            агента, чтобы ветка с закрытием и win_rate тоже были живыми. Память и дневной объём читаются из таблицы{" "}
            <code style={{ color: "var(--fg-2)" }}>agent_trades</code>: рестарт сервиса их не обнуляет. Ордер больше лимита на транзакцию{" "}
            <code style={{ color: "var(--fg-2)" }}>check_order()</code> не урезает, а отклоняет (статус{" "}
            <code style={{ color: "var(--fg-2)" }}>blocked_by_risk_limit</code>); под оставшийся дневный объём и под остаток лимита позиции размер
            урезается. Если сервис подписи оборвал соединение, шаг получает <code style={{ color: "var(--fg-2)" }}>unknown</code>: ордер мог
            исполниться, повтор шага — это второй ордер с новым индексом, поэтому в память и в дневной объём такой шаг не попадает.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
