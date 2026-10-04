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

const EXECUTION_STYLE: Record<string, string> = {
  dry_run: "bg-sky-950 text-sky-400 border border-sky-900",
  sent: "bg-emerald-950 text-emerald-400 border border-emerald-900",
  blocked_by_risk_limit: "bg-amber-950 text-amber-400 border border-amber-900",
  skipped: "bg-surface-200 text-text-secondary",
  failed: "bg-red-950 text-red-400 border border-red-900",
};

export function Agent({ followerId, subscription, currentMarket, setToast, startTrial }: AgentProps) {
  const [resolution, setResolution] = useState<Resolution>("1h");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [baseSizeUsd, setBaseSizeUsd] = useState(100);
  const [busy, setBusy] = useState(false);
  const [lastDecision, setLastDecision] = useState<Decision | null>(null);
  const [memory, setMemory] = useState<MemoryView | null>(null);

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
      .then(setMemory)
      .catch(() => setMemory(null));
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
    <div>
      <div className="mb-4">
        <h2 className="text-text-primary font-semibold">Агент</h2>
        <p className="text-text-tertiary text-sm">
          Момент-эвристика по закрытиям свечей Lighter, поверх неё — LLM-рассуждение с откатом на эвристику, если ответы модели нет. Свечи читаются
          здесь же, через публичный <code className="text-text-secondary">GET /candles</code>.
        </p>
      </div>

      {!subscription?.has_ai_agent ? (
        <div className="bg-surface-100 border border-border rounded-2xl py-16 flex flex-col items-center text-center">
          <Zap className="w-8 h-8 text-text-muted mb-3" />
          <p className="text-text-secondary text-sm mb-1">
            {subscription?.tier === "free" ? "Пробный период закончился" : "Агент доступен на trial или Pro"}
          </p>
          <p className="text-text-muted text-xs mb-3 max-w-sm">
            Статус подписки читается с <code className="text-text-secondary">GET /subscription/&lt;follower_id&gt;</code>; без входа через Telegram или
            кошелёк её не на что заводить.
          </p>
          <button onClick={startTrial} className="bg-cyan-500 hover:bg-cyan-400 text-surface-50 text-sm font-semibold px-4 py-2 rounded-full transition-colors">
            Начать 14-дневный trial
          </button>
          <p className="text-text-muted text-[11px] mt-3 max-w-sm leading-relaxed">
            Trial заводится без оплаты. «pro» включает <code className="text-text-secondary">POST /subscription/&lt;follower_id&gt;/upgrade</code> прямо на
            бэкенде — платёжного пути в репозитории нет, и кнопкой в интерфейсе это не делается. Строки подписки живут в памяти процесса
            (<code className="text-text-secondary">api/agent.py</code>): после рестарта бэкенда подписка снова «none».
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {subscription.days_left_in_trial != null && (
            <div className="text-xs text-amber-400">Trial: {subscription.days_left_in_trial.toFixed(1)} дней осталось</div>
          )}

          <div className="bg-surface-100 border border-border rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-tertiary uppercase tracking-wide">
                  {currentMarket?.symbol ?? "рынок не выбран"}
                  {spot != null && <span className="font-mono normal-case text-text-secondary ml-2">{usd(spot, currentMarket?.supported_price_decimals ?? 2)}</span>}
                </span>
                <div className="flex gap-1">
                  {RESOLUTIONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setResolution(r)}
                      className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                        resolution === r ? "bg-cyan-500 text-surface-50" : "bg-surface-200 text-text-secondary hover:text-text-primary"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-tertiary">
                  Базовый размер $
                  <input
                    type="number"
                    min={0}
                    step={50}
                    value={baseSizeUsd}
                    onChange={(e) => setBaseSizeUsd(Math.max(0, Number(e.target.value)))}
                    className="ml-1.5 bg-surface-200 border border-border-hover rounded-lg px-2 py-1 w-20 text-text-primary text-sm font-mono outline-none"
                  />
                </label>
                <button
                  onClick={() => void runAgentStep()}
                  disabled={busy || candles == null || prices.length < 2}
                  className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:hover:bg-cyan-500 text-surface-50 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors"
                >
                  {busy ? "Считаю…" : "Спросить агента"}
                </button>
              </div>
            </div>

            {candlesError ? (
              <p className="text-xs text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5" /> Lighter не отдал свечи: {candlesError}
              </p>
            ) : candles == null ? (
              <p className="text-text-muted text-sm">Читаю {POINTS_SENT} свечей по {resolution}…</p>
            ) : (
              <p className="text-text-muted text-xs">
                {prices.length} закрытий по {resolution}, последние {Math.min(10, prices.length)} — окно, по которому считается момент.
              </p>
            )}

            {lastDecision && (
              <div className="mt-3 border-t border-border pt-3">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span
                    className={`text-lg font-mono font-bold ${
                      lastDecision.action === "long" ? "text-emerald-400" : lastDecision.action === "short" ? "text-red-400" : "text-text-secondary"
                    }`}
                  >
                    {lastDecision.action.toUpperCase()}
                  </span>
                  <span
                    className="text-xs text-text-tertiary font-mono"
                    title="Число из ответа того, кто принял решение: LLM или резервного правила. Это самоотчёт, а не посчитанная вероятность успеха."
                  >
                    {(lastDecision.confidence * 100).toFixed(0)}% уверенность (самоотчёт)
                  </span>
                  {lastDecision.size_usd > 0 && <span className="text-xs text-text-tertiary font-mono">{usd(lastDecision.size_usd, 0)}</span>}
                  {lastDecision.execution && (
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${EXECUTION_STYLE[lastDecision.execution.status] ?? "bg-surface-200 text-text-secondary"}`}>
                      {lastDecision.execution.status}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-tertiary">{lastDecision.reasoning}</p>
                {lastDecision.execution?.reason && <p className="text-xs text-amber-400 mt-1">{lastDecision.execution.reason}</p>}
                {lastDecision.execution?.error && <p className="text-xs text-red-400 mt-1">{String(lastDecision.execution.error).slice(0, 160)}</p>}
                {lastDecision.execution?.tx_hash && (
                  <p className="text-xs text-text-tertiary font-mono mt-1">tx {String(lastDecision.execution.tx_hash).slice(0, 18)}…</p>
                )}
              </div>
            )}
          </div>

          {memory && (
            <div className="bg-surface-100 border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-text-tertiary uppercase tracking-wide">Память агента</span>
                <span className="text-xs text-text-tertiary font-mono">
                  {memory.open_trades.length} открыто · {memory.closed_trades.length} закрыто ·{" "}
                  {memory.win_rate == null ? "нет закрытых сделок" : `${(memory.win_rate * 100).toFixed(0)}% в плюс`} · объём за день{" "}
                  {usd(memory.volume_today_usd, 0)}
                </span>
              </div>
              <pre className="text-xs text-text-secondary whitespace-pre-wrap font-mono mb-3">{memory.summary}</pre>
              {memory.open_trades.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-text-muted border-b border-border">
                      <th className="py-1.5 font-normal">Рынок</th>
                      <th className="py-1.5 font-normal">Сторона</th>
                      <th className="py-1.5 font-normal">Вход</th>
                      <th className="py-1.5 font-normal">Объём</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.open_trades.slice(-8).reverse().map((t) => (
                      <tr key={t.id} className="border-b border-border last:border-0">
                        <td className="py-1.5 font-mono text-text-secondary">#{t.market_id}</td>
                        <td className={`py-1.5 font-mono ${t.side === "long" ? "text-emerald-400" : "text-red-400"}`}>{t.side}</td>
                        <td className="py-1.5 font-mono text-text-secondary">{fmt(t.entry_price, 2)}</td>
                        <td className="py-1.5 font-mono text-text-secondary">{fmt(t.size, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <p className="text-xs text-text-muted">
            Решение считается на сервере (<code className="text-text-secondary">backend/agent_runner.py</code>), перед этим проходит{" "}
            <code className="text-text-secondary">risk_limits.check_order()</code>. При <code className="text-text-secondary">WAKE_DRY_RUN=true</code>{" "}
            (по умолчанию) ордер на Lighter не отправляется — статус <code className="text-text-secondary">dry_run</code>, но сделка записывается в память
            агента, чтобы ветка с закрытием и win_rate тоже были живыми. Память и счётчик дневного объёма живут в процессе и обнуляются при рестарте
            сервиса.
          </p>
        </div>
      )}
    </div>
  );
}
