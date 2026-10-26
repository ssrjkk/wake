import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, X } from "lucide-react";
import { Modal, Skeleton } from "./ui";
import {
  claimPredictMarket,
  getPredictMarkets,
  getPredictPositions,
  PREDICT_PAGE_SIZE,
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
  const sign =
    { ">=": "≥", "<=": "≤", ">": ">", "<": "<" }[m.comparator] ?? m.comparator;
  const value = m.threshold.toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  return `${sign} ${value} · mark-цена Lighter, рынок #${m.lighter_market_id}`;
}

export default function Predict({
  signedIn,
  setToast,
  onConnect,
  focusMarket = null,
}: PredictProps) {
  // Срез под ссылку: «открытые» не содержит резолвленного рынка, и человек,
  // пришедший по ссылке на закрытый рынок, увидел бы «рынков нет» вместо своего.
  const [status, setStatus] = useState<PredictStatus>(
    focusMarket ? "all" : "open",
  );
  const [markets, setMarkets] = useState<PredictMarket[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  // Страница витрины: ответ бэкенда ограничен (limit ≤ 200), и «показаны не все»
  // должно быть видно, а не выводиться из длины списка молча.
  const [moreMarkets, setMoreMarkets] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [positions, setPositions] = useState<PredictPosition[] | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  // Выплата — один сет на рынок: без блокировки второй клик долетал до бэкенда
  // и человек видел «уже забрано» вместо своей суммы.
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [trade, setTrade] = useState<{
    market: PredictMarket;
    outcome: "yes" | "no";
    held: number;
  } | null>(null);
  const [sellMode, setSellMode] = useState(false);
  const [shares, setShares] = useState(10);
  const [quote, setQuote] = useState<{
    key: string;
    cost: number | null;
    error: string | null;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const quoteKey = trade
    ? `${trade.market.id}:${trade.outcome}:${shares}:${sellMode}`
    : "";
  const preview = quote?.key === quoteKey ? quote.cost : null;
  const previewError = quote?.key === quoteKey ? quote.error : null;
  const confirmationKey = `${quoteKey}:${preview}`;
  const tradeConfirmed = preview !== null && confirmedQuote === confirmationKey;

  // Одно место вместо четырёх копий условия в disabled, фоне, тексте и рамке кнопки.
  const tradeBlocked =
    sending ||
    preview == null ||
    shares <= 0 ||
    (sellMode && trade != null && shares > trade.held);

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
    // Первая страница; «показать ещё» добирает следующие (PREDICT_PAGE_SIZE).
    getPredictMarkets(status)
      .then((rows) => {
        if (live) {
          setMarkets(rows);
          setMoreMarkets(rows.length === PREDICT_PAGE_SIZE);
          setMarketsError(null);
        }
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

  async function loadMoreMarkets() {
    setLoadingMore(true);
    try {
      const rows = await getPredictMarkets(status, markets?.length ?? 0);
      setMarkets((prev) => [...(prev ?? []), ...rows]);
      setMoreMarkets(rows.length === PREDICT_PAGE_SIZE);
    } catch (e) {
      setMarketsError(errorText(e, 160));
    } finally {
      setLoadingMore(false);
    }
  }

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
  const focusListed =
    focusMarket !== null &&
    (markets?.some((m) => m.id === focusMarket) ?? false);

  useEffect(() => {
    if (!focusMarket || !focusListed) return;
    document
      .getElementById(`predict-market-${focusMarket}`)
      ?.scrollIntoView({ block: "center" });
  }, [focusMarket, focusListed, markets]);

  function openTrade(market: PredictMarket, outcome: "yes" | "no") {
    if (!signedIn) {
      onConnect();
      setToast(
        "Войди через Telegram или кошелёк — позиция пишется на твой аккаунт Wake",
      );
      return;
    }
    setTrade({
      market,
      outcome,
      held: heldByKey.get(`${market.id}:${outcome}`)?.shares ?? 0,
    });
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
      const data = await tradePredictMarket(
        trade.market.id,
        trade.outcome,
        qty,
      );
      setToast(
        sellMode
          ? `Продано ${Math.abs(qty)} ${trade.outcome.toUpperCase()}: возвращено ${money(data.cost_usd)}`
          : `Куплено ${qty} ${trade.outcome.toUpperCase()}: ${money(data.cost_usd)}`,
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
        <div className="terminal-header panel-head">
          <div className="panel-head-row">
            <h2 className="panel-title">Predict</h2>
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="btn-ghost push-right"
            >
              <RefreshCw className="w-3 h-3" />
              Обновить
            </button>
          </div>
          <p className="panel-lead">
            Бинарные рынки на LMSR-пуле. Ценовые закрываются автоматически по
            mark-цене Lighter, событийные — куратором.
          </p>
        </div>

        <div className="terminal-header" style={{ flexWrap: "wrap" }}>
          <div className="seg" role="group" aria-label="Срез рынков">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => {
                  setStatus(f.id);
                  setMarkets(null);
                  setMarketsError(null);
                }}
                aria-pressed={status === f.id}
                className="font-mono uppercase tracking-[0.06em]"
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="muted push-right">
            {positions
              ? `позиций: ${positions.length}`
              : signedIn
                ? "позиции грузятся…"
                : "позиции — после входа"}
            {claimable.length > 0 && (
              <span className="text-positive">
                {" "}
                · доступно к выплате {claimable.length}
              </span>
            )}
          </span>
        </div>

        {positionsError && (
          <div className="notice notice-error animate-fade-in">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Не удалось загрузить позиции: {positionsError}</span>
          </div>
        )}

        {positions && positions.length > 0 && (
          <section className="terminal-panel">
            <div className="panel-caption">
              <span className="label">Мои позиции</span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Рынок</th>
                    <th>Доля</th>
                    <th>shares</th>
                    <th>Средняя</th>
                    <th>Стоит сейчас</th>
                    <th>P&L</th>
                    <th> </th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => {
                    const pnl =
                      p.market_status === "resolved"
                        ? predictOutcomeWorth(p.market_outcome, p.outcome) *
                            p.shares -
                          p.net_cost_usd
                        : p.mark_value_usd - p.net_cost_usd;
                    return (
                      <tr key={`${p.market_id}:${p.outcome}`}>
                        <td>
                          <div className="truncate">{p.question}</div>
                          <div className="sub-label">
                            {p.outcome.toUpperCase()} ·{" "}
                            {p.market_status === "open"
                              ? predictTimeLeft(p.resolve_at, now)
                              : `исход ${p.market_outcome ?? "не указан"}`}
                            {p.claimed && " · забрано"}
                          </div>
                        </td>
                        <td className="right num">{cents(p.mark_price)}</td>
                        <td className="right num">{p.shares}</td>
                        <td className="right num">{money(p.avg_entry_usd)}</td>
                        <td className="right num">
                          {p.market_status === "resolved"
                            ? money(p.claimable_usd)
                            : money(p.mark_value_usd)}
                        </td>
                        <td
                          className={`right num ${pnl >= 0 ? "text-positive" : "text-negative"}`}
                        >
                          {pnl >= 0 ? "+" : "−"}
                          {money(Math.abs(pnl))}
                        </td>
                        <td className="right">
                          {p.claimable_usd > 0 && !p.claimed && (
                            <button
                              onClick={() => void claim(p)}
                              disabled={claimingId !== null}
                              className="btn-action btn-up"
                              style={{
                                padding: "8px 12px",
                                fontSize: "var(--fs-data)",
                              }}
                            >
                              {claimingId === p.market_id
                                ? "Забираю…"
                                : `Забрать ${money(p.claimable_usd)}`}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {marketsError && (
          <div className="notice notice-error animate-fade-in">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>
              Список рынков временно недоступен: функция требует подключённый
              бэкенд Wake — <span className="num">{marketsError}</span>
            </span>
          </div>
        )}

        {/* Ссылка из бота на рынок, которого в этом срезе нет: «рынков нет» был бы
            обманом — рынок есть, просто закрыт или создан позже. */}
        {focusMarket && markets && !focusListed && (
          <div className="notice notice-warn animate-fade-in">
            <span>
              Рынка <code className="num">{focusMarket.slice(0, 8)}…</code> нет
              в срезе «{FILTERS.find((f) => f.id === status)?.label}»: он мог
              закрыться или появиться позже этого запроса.
            </span>
            {status !== "all" && (
              <button
                onClick={() => {
                  setStatus("all");
                  setMarkets(null);
                  setMarketsError(null);
                }}
                className="btn-ghost shrink-0"
              >
                Показать все
              </button>
            )}
          </div>
        )}

        {!markets && !marketsError && (
          <div className="market-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="market-card">
                <Skeleton height="10px" width="80px" />
                <Skeleton height="14px" />
                <Skeleton height="8px" />
                <Skeleton height="40px" />
              </div>
            ))}
          </div>
        )}

        {markets && markets.length === 0 && !marketsError && (
          <div className="empty-state">
            <p
              style={{
                fontSize: "var(--fs-ui)",
                color: "var(--fg-2)",
                margin: 0,
              }}
            >
              {status === "open"
                ? "Открытых рынков нет"
                : status === "resolved"
                  ? "Резолвленных рынков пока нет"
                  : "Рынков нет"}
            </p>
            <p className="fineprint">
              Создать может только куратор: POST /predict/markets/price или
              /predict/markets/event с заголовком X-Curator-Token.
            </p>
          </div>
        )}

        {markets && markets.length > 0 && (
          <div className="market-grid">
            {markets.map((m) => {
              const yes = heldByKey.get(`${m.id}:yes`);
              const no = heldByKey.get(`${m.id}:no`);
              const resolved = m.status === "resolved";
              return (
                <article
                  key={m.id}
                  id={`predict-market-${m.id}`}
                  className="market-card"
                  data-focused={m.id === focusMarket || undefined}
                >
                  <div className="market-card-head">
                    <span className="label">
                      {m.kind === "price" ? "Цена на Lighter" : "Событие"}
                    </span>
                    {m.id === focusMarket && (
                      <span className="chip chip-accent">из ссылки</span>
                    )}
                    <span className="sub-label push-right">
                      {resolved ? "закрыт" : predictTimeLeft(m.resolve_at, now)}
                    </span>
                  </div>

                  <p className="market-question">{m.question}</p>
                  {conditionOf(m) && (
                    <p className="sub-label num">{conditionOf(m)}</p>
                  )}

                  {resolved ? (
                    <div className="market-outcome">
                      <span>исход</span>
                      <b>{m.outcome ?? "не указан"}</b>
                      <span>· победившая доля — $1, проигравшая — $0</span>
                      {m.resolved_by && (
                        <span className="num">закрыл: {m.resolved_by}</span>
                      )}
                      {m.evidence_url && (
                        <a
                          className="evidence"
                          href={m.evidence_url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          Источник
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  ) : (
                    <div className="market-prob">
                      <span className="prob-bar">
                        <i style={{ width: `${m.price_yes * 100}%` }} />
                      </span>
                      <span className="num prob-value">
                        {(m.price_yes * 100).toFixed(0)}% YES
                      </span>
                    </div>
                  )}

                  <div className="market-trade">
                    <button
                      onClick={() => openTrade(m, "yes")}
                      disabled={resolved}
                      className="btn-action btn-up"
                    >
                      {resolved ? "YES" : `Купить YES ${cents(m.price_yes)}`}
                    </button>
                    <button
                      onClick={() => openTrade(m, "no")}
                      disabled={resolved}
                      className="btn-action btn-down"
                    >
                      {resolved ? "NO" : `Купить NO ${cents(m.price_no)}`}
                    </button>
                  </div>

                  <div className="market-card-foot">
                    <span className="sub-label">
                      объём {fmtUsdCompact(m.volume_usd)} · сделок{" "}
                      {m.trade_count}
                    </span>
                    {(yes || no) && (
                      <span className="sub-label">
                        держишь {yes ? `YES ${yes.shares}` : ""}
                        {yes && no ? " + " : ""}
                        {no ? `NO ${no.shares}` : ""}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {markets && markets.length > 0 && moreMarkets && (
          <button
            onClick={() => void loadMoreMarkets()}
            disabled={loadingMore}
            className="link-action"
            style={{ marginTop: "12px" }}
          >
            {loadingMore ? "Загружаю…" : `Показать ещё ${PREDICT_PAGE_SIZE}`}
          </button>
        )}

        <p className="fineprint" style={{ marginTop: "4px" }}>
          Объём и число сделок — сделки через Wake, а не глубина пула: прямого
          доступа к книге LMSR у сайта нет. Рынок с нулевым объёмом ещё никто не
          торговал, и это не значит, что он пустой.
        </p>

        {trade && (
          <Modal
            label={`${sellMode ? "Продать" : "Купить"} ${trade.outcome.toUpperCase()} — ${trade.market.question}`}
            onClose={() => setTrade(null)}
          >
            <div
              className="overlay-shell"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="overlay-head">
                <h3>
                  {sellMode ? "Продать" : "Купить"}{" "}
                  {trade.outcome.toUpperCase()} — {trade.market.question}
                </h3>
                <button
                  onClick={() => setTrade(null)}
                  aria-label="Закрыть"
                  className="overlay-close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {trade.held > 0 && (
                <div
                  className="seg seg-full"
                  role="group"
                  aria-label="Направление сделки"
                >
                  <button
                    onClick={() => setSellMode(false)}
                    aria-pressed={!sellMode}
                  >
                    Покупка
                  </button>
                  <button
                    onClick={() => setSellMode(true)}
                    aria-pressed={sellMode}
                  >
                    Продажа (держишь {trade.held})
                  </button>
                </div>
              )}

              <div>
                <label htmlFor="predict-shares" className="stat-label">
                  Количество shares
                </label>
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
                  style={{ width: "100%", marginTop: "4px" }}
                />
                {sellMode && (
                  <p className="sub-label" style={{ marginTop: "4px" }}>
                    Продать можно не больше {trade.held} shares.
                  </p>
                )}
              </div>

              <dl className="kv">
                <dt className="sub-label">
                  {sellMode ? "Вернётся на счёт" : "Стоимость сейчас"}
                </dt>
                <dd>
                  {previewError ? (
                    <span className="text-negative">{previewError}</span>
                  ) : preview == null ? (
                    "…"
                  ) : (
                    money(Math.abs(preview))
                  )}
                </dd>
                {sellMode ? (
                  <>
                    <dt className="sub-label">Останется shares</dt>
                    <dd>{Math.max(0, trade.held - shares)}</dd>
                  </>
                ) : (
                  <>
                    <dt className="sub-label">Номинал при победе</dt>
                    <dd>{money(shares)}</dd>
                  </>
                )}
              </dl>

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
                   зелёным, продажа — красным контуром. Подтверждение всегда красная
                   заливка, иначе второй шаг в режиме продажи ничем не отличался бы
                   от первого. */
                className={`btn-action ${
                  tradeConfirmed
                    ? "btn-down"
                    : sellMode
                      ? "btn-down-outline"
                      : "btn-up"
                }`}
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
              <p className="fineprint" style={{ textAlign: "center" }}>
                Номинал — это не прибыль: share победившего исхода после
                резолюции стоит $1, проигравшего — $0, а вход по LMSR-кривой
                обычно дороже {cents(0.5)} и двигается против тебя с каждой
                покупкой. Верхнюю границу продажи и запрет торговать по
                закрытому рынку держит бэкенд, а не эта форма.
              </p>
            </div>
          </Modal>
        )}

        {!signedIn && (
          <div className="notice">
            <span>
              Рынки видны без входа, а позиция и выплаты — нет: трейд и выплата
              записываются на аккаунт, подтверждённый токеном входа, — в запросе
              нет поля «чей это пользователь».
            </span>
            <button className="btn-primary shrink-0" onClick={onConnect}>
              Войти
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
