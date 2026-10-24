import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, X } from "lucide-react";
import { Modal } from "./ui";
import {
  claimPredictMarket,
  getPredictMarkets,
  getPredictPositions,
  predictOutcomeWorth,
  predictTimeLeft,
  previewPredictTrade,
  tradePredictMarket,
  type PredictMarket,
  type PredictPosition,
  type PredictStatus,
} from "../lib/predict";
import { fmtUsdCompact, usd } from "./utils";
import { errorText } from "../lib/backend";

interface PredictProps {
  signedIn: boolean;
  setToast: (toast: string | null) => void;
  onConnect: () => void;
  // Рынок, на который пришла ссылка из Telegram-бота. Показываем его выбранным,
  // а не тем, который первым лежал в списке.
  focusMarket?: string | null;
}

const FILTERS: { id: PredictStatus; label: string }[] = [
  { id: "open", label: "Открытые" },
  { id: "resolved", label: "Резолвленные" },
  { id: "all", label: "Все" },
];

// Цена доли в центах: доля победившего исхода после резолюции стоит $1, поэтому
// 47¢ и есть вероятность, которую в неё закладывает пул.
function cents(price: number): string {
  return `${(price * 100).toFixed(0)}¢`;
}

// Свои деньги — до копейки: fmtUsdCompact показал бы "$1.2K" вместо "$1,234.50",
// а в строке стоимости сделки расхождение в $45 заметно сразу.
function money(value: number): string {
  return usd(value, 2);
}

// Условие рынка берётся из полей порога, а не из текста вопроса: вопрос пишет
// куратор, а threshold и comparator лежат в таблице. lighter_market_id показан
// числом — символ в ответ /predict/markets не приходит, и придумывать его по id
// означает напечатать число, которого бэкенд не давал.
function conditionOf(m: PredictMarket): string | null {
  if (m.kind !== "price" || m.threshold == null || !m.comparator) return null;
  const sign = { ">=": "≥", "<=": "≤", ">": ">", "<": "<" }[m.comparator] ?? m.comparator;
  const value = m.threshold.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${sign} ${value} · mark-цена Lighter, рынок #${m.lighter_market_id}`;
}

export default function Predict({ signedIn, setToast, onConnect, focusMarket = null }: PredictProps) {
  // Срез под ссылку: «открытые» не содержит резолвленного рынка, и человек,
  // пришедший по ссылке на закрытый рынок, увидел бы «рынков нет» вместо своего.
  const [status, setStatus] = useState<PredictStatus>(focusMarket ? "all" : "open");
  const [markets, setMarkets] = useState<PredictMarket[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [positions, setPositions] = useState<PredictPosition[] | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  // Выплата — один сет на рынок: без блокировки второй клик долетал до бэкенда
  // и человек видел «уже забрано» вместо своей суммы.
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [trade, setTrade] = useState<{ market: PredictMarket; outcome: "yes" | "no"; held: number } | null>(null);
  const [sellMode, setSellMode] = useState(false);
  const [shares, setShares] = useState(10);
  const [quote, setQuote] = useState<{ key: string; cost: number | null; error: string | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const quoteKey = trade ? `${trade.market.id}:${trade.outcome}:${shares}:${sellMode}` : "";
  const preview = quote?.key === quoteKey ? quote.cost : null;
  const previewError = quote?.key === quoteKey ? quote.error : null;
  const confirmationKey = `${quoteKey}:${preview}`;
  const tradeConfirmed = preview !== null && confirmedQuote === confirmationKey;

  // Одно место вместо четырёх копий условия в disabled, фоне, тексте и рамке кнопки.
  const tradeBlocked = sending || preview == null || shares <= 0 || (sellMode && trade != null && shares > trade.held);

  useEffect(() => {
    if (!trade) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTrade(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [trade]);

  // Срок рынка пересчитывается по часам, поэтому раз в минуту обновляем только
  // локальные подписи: данные рынка при этом не дёргаются — они меняются со
  // сделками, а не со временем.
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    getPredictMarkets(status)
      .then((rows) => {
        if (live) { setMarkets(rows); setMarketsError(null); }
      })
      .catch((e) => {
        // Пустой список и «бэкенд не ответил» — разные состояния: во втором случае
        // рынки могут быть, и сказать об этом надо текстом ошибки, а не нулём.
        if (live) setMarketsError(errorText(e, 160));
      });
    return () => {
      live = false;
    };
  }, [status, nonce]);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    getPredictPositions()
      .then((rows) => {
        if (live) {
          setPositions(rows);
          setPositionsError(null);
        }
      })
      .catch((e) => {
        if (live) {
          setPositions([]);
          setPositionsError(errorText(e));
        }
      });
    return () => {
      live = false;
    };
  }, [signedIn, nonce]);

  const heldByKey = useMemo(() => {
    const map = new Map<string, PredictPosition>();
    for (const p of positions ?? []) map.set(`${p.market_id}:${p.outcome}`, p);
    return map;
  }, [positions]);

  const claimable = (positions ?? []).filter((p) => p.claimable_usd > 0);
  const now = new Date(clock);

  // Ссылка из бота ведёт на конкретный рынок: его видно сразу, а не после
  // проматывания списка. Прокручиваем по факту пришедшего списка — до ответа
  // бэкенда карточки в дереве нет.
  const focusListed = focusMarket !== null && (markets?.some((m) => m.id === focusMarket) ?? false);

  useEffect(() => {
    if (!focusMarket || !focusListed) return;
    document.getElementById(`predict-market-${focusMarket}`)?.scrollIntoView({ block: "center" });
  }, [focusMarket, focusListed, markets]);

  function openTrade(market: PredictMarket, outcome: "yes" | "no") {
    if (!signedIn) {
      onConnect();
      setToast("Войди через Telegram или кошелёк — позиция пишется на твой аккаунт Wake");
      return;
    }
    setTrade({ market, outcome, held: heldByKey.get(`${market.id}:${outcome}`)?.shares ?? 0 });
    setSellMode(false);
    setShares(10);
    setQuote(null);
    setConfirmedQuote(null);
  }

  useEffect(() => {
    if (!trade) return;
    const marketId = trade.market.id;
    const outcome = trade.outcome;
    let live = true;
    const qty = sellMode ? -Math.abs(shares) : Math.abs(shares);
    if (!qty) return;
    previewPredictTrade(marketId, outcome, qty)
      .then((d) => {
        if (live) setQuote({ key: quoteKey, cost: d.cost_usd, error: null });
      })
      .catch((e) => {
        if (live) setQuote({ key: quoteKey, cost: null, error: errorText(e) });
      });
    return () => {
      live = false;
    };
  }, [trade, shares, sellMode, quoteKey]);

  async function confirmTrade() {
    if (!trade || !signedIn || preview == null) return;
    setSending(true);
    try {
      const qty = sellMode ? -Math.abs(shares) : Math.abs(shares);
      const data = await tradePredictMarket(trade.market.id, trade.outcome, qty);
      setToast(
        sellMode
          ? `Продано ${Math.abs(qty)} ${trade.outcome.toUpperCase()}: возвращено ${money(data.cost_usd)}`
          : `Куплено ${qty} ${trade.outcome.toUpperCase()}: ${money(data.cost_usd)}`
      );
      setTrade(null);
      setNonce((n) => n + 1);
    } catch (e) {
      setToast(`Сделка не записана: ${errorText(e)}`);
    } finally {
      setSending(false);
    }
  }

  async function claim(p: PredictPosition) {
    if (!signedIn || claimingId !== null) return;
    setClaimingId(p.market_id);
    try {
      const data = await claimPredictMarket(p.market_id);
      setToast(`Забрано ${money(data.payout_usd)} по «${p.question}»`);
      setNonce((n) => n + 1);
    } catch (e) {
      setToast(`Выигрыш не начислен: ${errorText(e)}`);
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Predict</h2>
            <button
              onClick={() => setNonce((n) => n + 1)}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#888", background: "rgba(26, 26, 26, 0.5)", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "8px 10px", cursor: "pointer", transition: "all 0.15s", minHeight: "var(--touch)" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#3a3a3a";
                e.currentTarget.style.color = "#aaa";
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.8)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#2a2a2a";
                e.currentTarget.style.color = "#888";
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.5)";
              }}
            >
              <RefreshCw style={{ width: "12px", height: "12px" }} /> Обновить
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Бинарные рынки на LMSR-пуле. Ценовые закрываются автоматически по mark-цене Lighter, событийные — куратором.
          </p>
        </div>

      <div className="terminal-header" style={{ gap: "8px", flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => { setStatus(f.id); setMarkets(null); setMarketsError(null); }}
            style={{
              padding: "8px 12px",
              borderRadius: "4px",
              fontSize: "11px",
              fontWeight: status === f.id ? 600 : 500,
              background: status === f.id ? "rgba(59, 130, 246, 0.1)" : "rgba(26, 26, 26, 0.3)",
              color: status === f.id ? "#3b82f6" : "#ccc",
              border: status === f.id ? "1px solid rgba(59, 130, 246, 0.3)" : "1px solid #2a2a2a",
              cursor: "pointer",
              transition: "all 0.15s",
              minHeight: "var(--touch)"
            }}
            onMouseEnter={(e) => {
              if (status !== f.id) {
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.6)";
                e.currentTarget.style.borderColor = "#3a3a3a";
              }
            }}
            onMouseLeave={(e) => {
              if (status !== f.id) {
                e.currentTarget.style.background = "rgba(26, 26, 26, 0.3)";
                e.currentTarget.style.borderColor = "#2a2a2a";
              }
            }}
          >
            {f.label}
          </button>
        ))}
        <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>
          {positions ? `позиций: ${positions.length}` : signedIn ? "позиции грузятся…" : "позиции — после входа"}
          {claimable.length > 0 && <span style={{ color: "#10b981", fontWeight: 500 }}> · доступно к выплате {claimable.length}</span>}
        </span>
      </div>

      {positionsError && (
        <div style={{ padding: "10px 16px", background: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "6px", fontSize: "12px", color: "#ef4444", marginBottom: "12px" }}>
          Не удалось загрузить позиции: {positionsError}
        </div>
      )}

      {positions && positions.length > 0 && (
        <div style={{ background: "linear-gradient(135deg, #111 0%, #0f0f0f 100%)", border: "1px solid #1e1e1e", borderRadius: "6px", overflow: "hidden", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.2)" }}>
          <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e1e1e", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", background: "rgba(26, 26, 26, 0.3)", fontWeight: 600 }}>
            Мои позиции
          </div>
          <div className="table-scroll">
            <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", background: "rgba(26, 26, 26, 0.2)" }}>
                  <th style={{ padding: "10px 16px", fontWeight: 500 }}>Рынок</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Доля</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>shares</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Средняя</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>Стоит сейчас</th>
                  <th style={{ padding: "10px 12px", fontWeight: 500, textAlign: "right" }}>P&L</th>
                  <th style={{ padding: "10px 16px", fontWeight: 500, textAlign: "right" }}> </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const pnl =
                    p.market_status === "resolved"
                      ? predictOutcomeWorth(p.market_outcome, p.outcome) * p.shares - p.net_cost_usd
                      : p.mark_value_usd - p.net_cost_usd;
                  return (
                    <tr key={`${p.market_id}:${p.outcome}`} style={{ borderTop: "1px solid #1a1a1a", transition: "background 0.15s" }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "rgba(26, 26, 26, 0.4)"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                    >
                      <td style={{ padding: "12px 16px", color: "#fafafa" }}>
                        <div style={{ maxWidth: "350px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.question}</div>
                        <div style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "2px" }}>
                          {p.outcome.toUpperCase()} ·{" "}
                          {p.market_status === "open" ? predictTimeLeft(p.resolve_at, now) : `исход ${p.market_outcome ?? "не указан"}`}
                          {p.claimed && " · забрано"}
                        </div>
                      </td>
                      <td style={{ padding: "12px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{cents(p.mark_price)}</td>
                      <td style={{ padding: "12px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{p.shares}</td>
                      <td style={{ padding: "12px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{money(p.avg_entry_usd)}</td>
                      <td style={{ padding: "12px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#ccc", fontWeight: 500 }}>
                        {p.market_status === "resolved" ? money(p.claimable_usd) : money(p.mark_value_usd)}
                      </td>
                      <td style={{ padding: "12px 12px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: pnl >= 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>
                        {pnl >= 0 ? "+" : "−"}
                        {money(Math.abs(pnl))}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        {p.claimable_usd > 0 && !p.claimed && (
                          <button
                            onClick={() => void claim(p)}
                            disabled={claimingId !== null}
                            style={{ background: "linear-gradient(135deg, #10b981 0%, #34d399 100%)", color: "#0a0a0a", fontSize: "11px", fontWeight: 600, padding: "8px 12px", border: "none", borderRadius: "4px", cursor: claimingId === null ? "pointer" : "default", transition: "all 0.15s", boxShadow: "0 1px 2px rgba(16, 185, 129, 0.2)", minHeight: "var(--touch)", opacity: claimingId === p.market_id ? 0.6 : 1 }}
                            onMouseEnter={(e) => {
                              if (claimingId !== null) return;
                              e.currentTarget.style.filter = "brightness(1.1)";
                              e.currentTarget.style.boxShadow = "0 2px 4px rgba(16, 185, 129, 0.3)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.filter = "brightness(1)";
                              e.currentTarget.style.boxShadow = "0 1px 2px rgba(16, 185, 129, 0.2)";
                            }}
                          >
                            {claimingId === p.market_id ? "Забираю…" : `Забрать ${money(p.claimable_usd)}`}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {marketsError && (
        <div style={{ background: "#1a0a0a", border: "1px solid #5c1a1a", borderRadius: "6px", padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: "10px" }}>
          <AlertTriangle style={{ width: "14px", height: "14px", color: "#ef4444", marginTop: "2px", flexShrink: 0 }} />
          <div>
            <p style={{ fontSize: "12px", color: "#fca5a5", margin: 0 }}>Список рынков временно недоступен</p>
            <p style={{ fontSize: "11px", color: "#999", marginTop: "4px" }}>Функция требует подключённый бэкенд Wake.</p>
          </div>
        </div>
      )}

      {/* Ссылка из бота на рынок, которого в этом срезе нет: «рынков нет» был бы
          обманом — рынок есть, просто закрыт или создан позже. */}
      {focusMarket && markets && !focusListed && (
        <div className="notice notice-warn animate-fade-in">
          <span>
            Рынка <code className="num">{focusMarket.slice(0, 8)}…</code> нет в срезе
            «{FILTERS.find((f) => f.id === status)?.label}»: он мог закрыться или появиться позже
            этого запроса.
          </span>
          {status !== "all" && (
            <button
              onClick={() => { setStatus("all"); setMarkets(null); setMarketsError(null); }}
              className="btn-ghost shrink-0"
            >
              Показать все
            </button>
          )}
        </div>
      )}

      {!markets && !marketsError && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
              <div style={{ height: "10px", background: "#1a1a1a", borderRadius: "3px", width: "80px", marginBottom: "12px" }} />
              <div style={{ height: "12px", background: "#1a1a1a", borderRadius: "3px", width: "100%", marginBottom: "8px" }} />
              <div style={{ height: "6px", background: "#1a1a1a", borderRadius: "3px", width: "100%", marginBottom: "16px" }} />
              <div style={{ height: "32px", background: "#1a1a1a", borderRadius: "3px", width: "100%" }} />
            </div>
          ))}
        </div>
      )}

      {markets && markets.length === 0 && !marketsError && (
        <div className="empty-state">
          <p style={{ fontSize: "12px", color: "#ccc", margin: "0 0 4px 0" }}>
            {status === "open" ? "Открытых рынков нет" : status === "resolved" ? "Резолвленных рынков пока нет" : "Рынков нет"}
          </p>
          <p style={{ fontSize: "10px", color: "var(--text-muted)", margin: 0 }}>
            Создать может только куратор: POST /predict/markets/price или /predict/markets/event с заголовком X-Curator-Token.
          </p>
        </div>
      )}

      {markets && markets.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "8px" }}>
          {markets.map((m) => {
            const yes = heldByKey.get(`${m.id}:yes`);
            const no = heldByKey.get(`${m.id}:no`);
            const resolved = m.status === "resolved";
            return (
              <div
                key={m.id}
                id={`predict-market-${m.id}`}
                style={{
                  background: m.id === focusMarket ? "#150f0b" : "#111",
                  border: `1px solid ${m.id === focusMarket ? "#ff6b35" : "#1e1e1e"}`,
                  borderRadius: "6px",
                  padding: "16px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", gap: "8px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                    <span style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {m.kind === "price" ? "Цена на Lighter" : "Событие"}
                    </span>
                    {m.id === focusMarket && (
                      <span style={{ fontSize: "10px", color: "#ff6b35", whiteSpace: "nowrap" }}>из ссылки</span>
                    )}
                  </span>
                  <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>
                    {resolved ? "закрыт" : predictTimeLeft(m.resolve_at, now)}
                  </span>
                </div>
                <div style={{ fontSize: "12px", color: "#fafafa", fontWeight: 500, marginBottom: "4px" }}>{m.question}</div>
                {conditionOf(m) && <div style={{ fontSize: "10px", color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace", marginBottom: "12px" }}>{conditionOf(m)}</div>}

                {resolved ? (
                  <div style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "10px 12px", fontSize: "11px", marginBottom: "12px" }}>
                    <span style={{ color: "var(--text-muted)" }}>исход </span>
                    <span style={{ color: "#fafafa", fontWeight: 600, textTransform: "uppercase" }}>{m.outcome ?? "не указан"}</span>
                    <span style={{ color: "var(--text-muted)" }}> · </span>
                    <span style={{ color: "var(--text-muted)" }}>победившая доля — $1, проигравшая — $0</span>
                    {m.resolved_by && <div style={{ color: "var(--text-muted)", marginTop: "4px", fontFamily: "'JetBrains Mono', monospace" }}>закрыл: {m.resolved_by}</div>}
                    {m.evidence_url && (
                      <a
                        href={m.evidence_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: "#3b82f6", display: "inline-flex", alignItems: "center", gap: "4px", marginTop: "4px", fontSize: "10px" }}
                      >
                        Источник <ExternalLink style={{ width: "10px", height: "10px" }} />
                      </a>
                    )}
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                    <div style={{ flex: 1, height: "4px", background: "#1a1a1a", borderRadius: "2px", overflow: "hidden" }}>
                      <div style={{ height: "100%", background: "#10b981", width: `${m.price_yes * 100}%` }} />
                    </div>
                    <span style={{ fontSize: "10px", fontFamily: "'JetBrains Mono', monospace", color: "#ccc", width: "56px", textAlign: "right" }}>
                      {(m.price_yes * 100).toFixed(0)}% YES
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", gap: "6px", marginTop: "auto" }}>
                  <button
                    onClick={() => openTrade(m, "yes")}
                    disabled={resolved}
                    style={{ flex: 1, background: resolved ? "#1a1a1a" : "#10b981", color: resolved ? "#666" : "#0a0a0a", fontSize: "11px", fontWeight: 600, padding: "10px 0", border: "none", borderRadius: "4px", cursor: resolved ? "default" : "pointer", minHeight: "44px" }}
                  >
                    {resolved ? "YES" : `Купить YES ${cents(m.price_yes)}`}
                  </button>
                  <button
                    onClick={() => openTrade(m, "no")}
                    disabled={resolved}
                    style={{ flex: 1, background: resolved ? "#1a1a1a" : "#ef4444", color: resolved ? "#666" : "#0a0a0a", fontSize: "11px", fontWeight: 600, padding: "10px 0", border: "none", borderRadius: "4px", cursor: resolved ? "default" : "pointer", minHeight: "44px" }}
                  >
                    {resolved ? "NO" : `Купить NO ${cents(m.price_no)}`}
                  </button>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginTop: "10px", fontSize: "10px", color: "var(--text-muted)" }}>
                  <span>
                    объём {fmtUsdCompact(m.volume_usd)} · сделок {m.trade_count}
                  </span>
                  {(yes || no) && (
                    <span style={{ color: "#ccc" }}>
                      держишь {yes ? `YES ${yes.shares}` : ""}
                      {yes && no ? " + " : ""}
                      {no ? `NO ${no.shares}` : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "12px" }}>
        Объём и число сделок — сделки через Wake, а не глубина пула: прямого доступа к книге LMSR у сайта нет.
        Рынок с нулевым объёмом ещё никто не торговал, и это не значит, что он пустой.
      </p>

      {trade && (
        <Modal label={`${sellMode ? "Продать" : "Купить"} ${trade.outcome.toUpperCase()} — ${trade.market.question}`} onClose={() => setTrade(null)}>
          <div
            className="modal-card"
            style={{ width: "100%", maxWidth: "380px", background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "20px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", gap: "12px" }}>
              <h3 style={{ fontSize: "13px", color: "#fafafa", fontWeight: 600, margin: 0 }}>
                {sellMode ? "Продать" : "Купить"} {trade.outcome.toUpperCase()} — {trade.market.question}
              </h3>
              <button onClick={() => setTrade(null)} aria-label="Закрыть" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "14px", flexShrink: 0 }}>
                <X style={{ width: "16px", height: "16px" }} />
              </button>
            </div>

            {trade.held > 0 && (
              <div style={{ display: "flex", gap: "4px", marginBottom: "12px" }}>
                <button
                  onClick={() => setSellMode(false)}
                  style={{ flex: 1, fontSize: "11px", padding: "8px 0", borderRadius: "4px", background: !sellMode ? "#0a1a14" : "transparent", color: !sellMode ? "#10b981" : "#ccc", border: !sellMode ? "1px solid #10b981" : "1px solid #2a2a2a", cursor: "pointer", minHeight: "var(--touch)" }}
                >
                  Покупка
                </button>
                <button
                  onClick={() => setSellMode(true)}
                  style={{ flex: 1, fontSize: "11px", padding: "8px 0", borderRadius: "4px", background: sellMode ? "#1a0a0d" : "transparent", color: sellMode ? "#ef4444" : "#ccc", border: sellMode ? "1px solid #ef4444" : "1px solid #2a2a2a", cursor: "pointer", minHeight: "var(--touch)" }}
                >
                  Продажа (держишь {trade.held})
                </button>
              </div>
            )}

            <label htmlFor="predict-shares" style={{ fontSize: "11px", color: "#888", marginBottom: "4px", display: "block" }}>Количество shares</label>
            <input
              id="predict-shares"
              type="number"
              min={1}
              max={sellMode ? trade.held : undefined}
              value={shares}
              onChange={(e) => {
                // valueAsNumber, а не Math.max(0, Number(...)): Math.max(0, NaN)
                // это NaN, и NaN уходил и в подпись «Номинал при победе», и в
                // условие блокировки (NaN <= 0 — false), то есть кнопка
                // разблокировалась и стреляла запросом на бэкенд.
                const raw = e.target.valueAsNumber;
                setShares(Number.isFinite(raw) ? Math.max(0, raw) : 0);
              }}
              style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "8px 12px", marginBottom: "4px", color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", outline: "none", width: "100%", boxSizing: "border-box" }}
            />
            {sellMode && (
              <p style={{ fontSize: "10px", color: "var(--text-muted)", marginBottom: "8px" }}>Продать можно не больше {trade.held} shares.</p>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)", marginTop: "12px", marginBottom: "4px" }}>
              <span>{sellMode ? "Вернётся на счёт" : "Стоимость сейчас"}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>
                {previewError ? (
                  <span style={{ color: "#ef4444" }}>{previewError}</span>
                ) : preview == null ? (
                  "…"
                ) : (
                  money(Math.abs(preview))
                )}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
              {sellMode ? (
                <>
                  <span>Останется shares</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{Math.max(0, trade.held - shares)}</span>
                </>
              ) : (
                <>
                  <span>Номинал при победе</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#ccc" }}>{money(shares)}</span>
                </>
              )}
            </div>

            <button
              onClick={() => {
                if (!tradeConfirmed) {
                  setConfirmedQuote(confirmationKey);
                  return;
                }
                void confirmTrade();
              }}
              disabled={tradeBlocked}
              /* Цвет задаёт направление, как в тикете Терминала: покупка залита
                 зелёным, продажа — красным контуром. Подтверждение всегда красный
                 заливки, иначе второй шаг в режиме продажи ничем не отличался бы
                 от первого. */
              style={{
                width: "100%",
                background: tradeBlocked ? "#1a1a1a" : tradeConfirmed ? "#ef4444" : sellMode ? "transparent" : "#10b981",
                color: tradeBlocked ? "#666" : tradeConfirmed || !sellMode ? "#0a0a0a" : "#ef4444",
                border: sellMode && !tradeBlocked && !tradeConfirmed ? "1px solid #ef4444" : "none",
                fontWeight: 600,
                borderRadius: "4px",
                padding: "12px 0",
                cursor: "pointer",
                fontSize: "12px",
                minHeight: "44px",
              }}
            >
              {sending
                ? "Отправка…"
                : preview == null
                  ? "Цена недоступна"
                  : tradeConfirmed
                    ? "Подтвердить"
                    : sellMode
                      ? `Продать ${shares}`
                      : `Купить ${shares} за ${money(preview)}`}
            </button>
            <p style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "12px", textAlign: "center", lineHeight: 1.5 }}>
              Номинал — это не прибыль: share победившего исхода после резолюции стоит $1, проигравшего — $0,
              а вход по LMSR-кривой обычно дороже {cents(0.5)} и двигается против тебя с каждой покупкой.
              Верхнюю границу продажи и запрет торговать по закрытому рынку держит бэкенд, а не эта форма.
            </p>
          </div>
        </Modal>
      )}

      {!signedIn && (
        <div style={{ marginTop: "16px", background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
            <CheckCircle2 style={{ width: "14px", height: "14px", color: "var(--text-muted)", marginTop: "2px" }} />
            <div>
              <p style={{ fontSize: "12px", color: "#ccc", margin: 0 }}>Рынки видны без входа, а позиция и выплаты — нет.</p>
              <p style={{ fontSize: "10px", color: "var(--text-muted)", marginTop: "4px" }}>
                Вход через Telegram или кошелёк: трейд и выплата записываются на аккаунт, подтверждённый токеном входа, — в запросе нет поля «чей это пользователь».
              </p>
            </div>
          </div>
          <button className="btn-primary" onClick={onConnect}>Войти</button>
        </div>
      )}
      </div>
    </div>
  );
}
