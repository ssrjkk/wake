import { useState, useEffect } from "react";
import { Zap, AlertTriangle } from "lucide-react";
import { getCandles, type Candle, type OrderBook, type Resolution } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { fmt, usd } from "./utils";
import type { Subscription } from "./types";

interface AgentProps {
  signedIn: boolean;
  subscription: Subscription | null;
  subscriptionError: string | null;
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

// Статус исполнения — чип темы, а не три оттенка на строку, которые панель
// смешивала сама (bg, color и border тремя инлайнами на чип). Краски сохранены
// один в один как были: info — сухой прогон, up — заявка принята площадкой,
// warn — сдвинулось с намеченного, down — отказ, базовый chip — сделка не нужна.
// Неизвестный статус обязан отличаться от failed и не ронять панель: это
// единственное, чем человек проверяет, что агент сделал с его деньгами.
const EXECUTION_CHIP: Record<string, string> = {
  dry_run: "chip-info",
  sent: "chip-up",
  blocked_by_risk_limit: "chip-warn",
  // «Решили не торговать» — не сбой, поэтому нейтральный чип.
  skipped: "",
  failed: "chip-down",
  // Не «не удалось», а «неизвестно»: запрос мог дойти до сервиса подписи, и
  // повтор шага — это второй ордер. Краска та же, что у отказа, смысл другой.
  unknown: "chip-warn",
};

export default function Agent({ signedIn, subscription, subscriptionError, currentMarket, setToast, startTrial }: AgentProps) {
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
    const stop = setIntervalWhenVisible(load, 30000);
    return () => {
      cancelled = true;
      stop();
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
        <div className="terminal-header terminal-header--stack">
          <h2 className="section-title">Агент</h2>
          <p className="panel-lead">
            Момент-эвристика по закрытиям свечей Lighter, поверх неё — LLM-рассуждение с откатом на эвристику, если ответы модели нет. Свечи читаются
            здесь же, через публичный <code>GET /candles</code>.
          </p>
        </div>

      {subscriptionError ? (
        <div className="notice notice-warn">
          Не удалось прочитать подписку: <span className="num">{subscriptionError}</span>
        </div>
      ) : !subscription?.has_ai_agent ? (
        <div className="empty-state">
          <span className="empty-mark">
            <Zap size={24} aria-hidden="true" />
          </span>
          <p className="panel-lead">
            {subscription?.tier === "free" ? "Пробный период закончился" : "Агент доступен на trial или Pro"}
          </p>
          <p className="muted">
            Статус подписки читается с <code>GET /subscription</code> — того, кому он принадлежит, решает токен входа; без
            Telegram или кошелька её не на что заводить.
          </p>
          {/* Кнопка «начать trial» у человека, у которого trial уже был, —
              мёртвый контрол: ensure_trial пишет через ON CONFLICT DO NOTHING,
              повторный клик не двигает trial_started_at и ничего не продлевает.
              Сказать это текстом честнее, чем предлагать действие, которое не
              происходит. */}
          {subscription?.tier === "free" ? (
            <p className="muted">
              Продлить трайл нельзя — он даётся один раз на аккаунт. Доступ дальше
              включает <code>Pro</code>.
            </p>
          ) : (
            <button className="btn-primary" onClick={startTrial}>Начать 14-дневный trial</button>
          )}
          <p className="fineprint">
            Trial заводится без оплаты, один раз на аккаунт. «pro» включает <code>POST /subscription/&lt;user_id&gt;/upgrade</code>{" "}
            на бэкенде под токеном куратора — платёжного пути в репозитории нет, и кнопкой в интерфейсе это не делается. Строки подписки лежат в{" "}
            <code>subscriptions</code> (<code>agent_db.py</code>) и переживают рестарт сервиса.
          </p>
        </div>
      ) : (
        <div className="stack">
          {subscription.days_left_in_trial != null && (
            <div className="muted text-warn">Trial: {subscription.days_left_in_trial.toFixed(1)} дней осталось</div>
          )}

          <div className="terminal-panel panel-pad">
            <div className="row-between">
              <div className="row">
                <span className="stat-label">
                  {currentMarket?.symbol ?? "рынок не выбран"}
                </span>
                {spot != null && (
                  <span className="num secondary">{usd(spot, currentMarket?.supported_price_decimals ?? 2)}</span>
                )}
                <div className="row-between">
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
              <div className="agent-controls">
                <label htmlFor="agent-base-size" className="label-row muted">
                  Базовый размер $
                  <input
                    id="agent-base-size"
                    type="number"
                    min={0}
                    step={50}
                    value={baseSizeUsd}
                    onChange={(e) => {
                      // valueAsNumber, а не Number(...): у «1e» это NaN, и
                      // Math.max(0, NaN) остаётся NaN — поле пустело, а запрос
                      // уходил с base_size_usd: null.
                      const raw = e.target.valueAsNumber;
                      setBaseSizeUsd(Number.isFinite(raw) ? Math.max(0, raw) : 0);
                    }}
                    className="input-mono input-num"
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
              <p className="notice notice-warn">
                <AlertTriangle size={14} aria-hidden="true" /> Lighter не отдал свечи: {candlesError}
              </p>
            ) : candles == null ? (
              <p className="muted">Читаю {POINTS_SENT} свечей по {resolution}…</p>
            ) : (
              <p className="muted">
                {lastDecision?.data
                  ? `${lastDecision.data.candles_used} закрытий ${lastDecision.data.resolution} с ${lastDecision.data.network} — ряд забрал бэкенд, последнее ${fmt(lastDecision.data.last_price, currentMarket?.supported_price_decimals ?? 2)}.`
                  : `${prices.length} закрытий по ${resolution}, последние ${Math.min(10, prices.length)} — окно, по которому считается момент; ряд для решения берёт бэкенд.`}
              </p>
            )}

            {lastDecision && (
              <div className="sep-top stack">
                <div className="row">
                  <span
                    className={`metric-word ${lastDecision.action === "long" ? "text-positive" : lastDecision.action === "short" ? "text-negative" : "secondary"}`}
                  >
                    {lastDecision.action.toUpperCase()}
                  </span>
                  <span className="muted num">
                    {(lastDecision.confidence * 100).toFixed(0)}% уверенность (самоотчёт)
                  </span>
                  {lastDecision.size_usd > 0 && <span className="muted num">{usd(lastDecision.size_usd, 0)}</span>}
                  {lastDecision.execution && (
                    <span className={`chip ${EXECUTION_CHIP[lastDecision.execution.status] ?? ""}`}>
                      {lastDecision.execution.status}
                    </span>
                  )}
                </div>
                <p className="muted">{lastDecision.reasoning}</p>
                {lastDecision.execution?.reason && <p className="muted text-warn">{lastDecision.execution.reason}</p>}
                {lastDecision.execution?.error && <p className="muted text-negative">{String(lastDecision.execution.error).slice(0, 160)}</p>}
                {lastDecision.execution?.client_order_index != null && (
                  <p className="muted num">
                    ордер #{lastDecision.execution.client_order_index} — по нему видно в Lighter, исполнился он или нет
                  </p>
                )}
                {lastDecision.execution?.tx_hash && (
                  <p className="muted num">tx {String(lastDecision.execution.tx_hash).slice(0, 18)}…</p>
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
            <div className="terminal-panel panel-pad">
              <div className="row-between">
                <span className="stat-label">Память агента</span>
                <span className="muted num">
                  {memory.open_trades.length} открыто · {memory.closed_trades.length} закрыто ·{" "}
                  {memory.win_rate == null ? "нет закрытых сделок" : `${(memory.win_rate * 100).toFixed(0)}% в плюс`} · объём за день{" "}
                  {usd(memory.volume_today_usd, 0)}
                </span>
              </div>
              <pre className="mono-note">{memory.summary}</pre>
              {memory.open_trades.length > 0 && (
                <div className="table-scroll">
                <table className="data-table data-table--fit">
                  <thead>
                    <tr>
                      <th scope="col" className="left">Рынок</th>
                      <th scope="col" className="left">Сторона</th>
                      <th scope="col" className="left">Вход</th>
                      <th scope="col" className="left">Объём</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.open_trades.slice(-8).reverse().map((t) => (
                      <tr key={t.id}>
                        <td className="num secondary">#{t.market_id}</td>
                        <td className={`num ${t.side === "long" ? "text-positive" : "text-negative"}`}>{t.side}</td>
                        <td className="num secondary">{fmt(t.entry_price, 2)}</td>
                        <td className="num secondary">{fmt(t.size, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}

          <p className="panel-lead">
            Решение считается на сервере (<code>backend/agent_runner.py</code>), перед этим проходит{" "}
            <code>risk_limits.check_order()</code>. При <code>WAKE_DRY_RUN=true</code>{" "}
            (по умолчанию) ордер на Lighter не отправляется — статус <code>dry_run</code>, но сделка записывается в память
            агента, чтобы ветка с закрытием и win_rate тоже были живыми. Память и дневной объём читаются из таблицы{" "}
            <code>agent_trades</code>: рестарт сервиса их не обнуляет. Ордер больше лимита на транзакцию{" "}
            <code>check_order()</code> не урезает, а отклоняет (статус{" "}
            <code>blocked_by_risk_limit</code>); под оставшийся дневный объём и под остаток лимита позиции размер
            урезается. Если сервис подписи оборвал соединение, шаг получает <code>unknown</code>: ордер мог
            исполниться, повтор шага — это второй ордер с новым индексом, поэтому в память и в дневной объём такой шаг не попадает.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
