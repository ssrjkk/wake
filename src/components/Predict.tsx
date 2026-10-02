import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, X } from "lucide-react";
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
import { Skeleton } from "./ui";
import { errorText } from "../lib/backend";

interface PredictProps {
  followerId: string | null;
  setToast: (toast: string | null) => void;
  onConnect: () => void;
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

export function Predict({ followerId, setToast, onConnect }: PredictProps) {
  const [status, setStatus] = useState<PredictStatus>("open");
  const [markets, setMarkets] = useState<PredictMarket[] | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [positions, setPositions] = useState<PredictPosition[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const [trade, setTrade] = useState<{ market: PredictMarket; outcome: "yes" | "no"; held: number } | null>(null);
  const [sellMode, setSellMode] = useState(false);
  const [shares, setShares] = useState(10);
  const [preview, setPreview] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
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
    setMarkets(null);
    setMarketsError(null);
    getPredictMarkets(status)
      .then((rows) => {
        if (live) setMarkets(rows);
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
    if (!followerId) {
      setPositions(null);
      return;
    }
    let live = true;
    getPredictPositions(followerId)
      .then((rows) => {
        if (live) setPositions(rows);
      })
      .catch(() => {
        if (live) setPositions([]);
      });
    return () => {
      live = false;
    };
  }, [followerId, nonce]);

  const heldByKey = useMemo(() => {
    const map = new Map<string, PredictPosition>();
    for (const p of positions ?? []) map.set(`${p.market_id}:${p.outcome}`, p);
    return map;
  }, [positions]);

  const claimable = (positions ?? []).filter((p) => p.claimable_usd > 0);
  const now = new Date(clock);

  function openTrade(market: PredictMarket, outcome: "yes" | "no") {
    if (!followerId) {
      onConnect();
      setToast("Войди через Telegram или кошелёк — позиция пишется на твой аккаунт Wake");
      return;
    }
    setTrade({ market, outcome, held: heldByKey.get(`${market.id}:${outcome}`)?.shares ?? 0 });
    setSellMode(false);
    setShares(10);
    setPreview(null);
    setPreviewError(null);
  }

  useEffect(() => {
    if (!trade) return;
    const marketId = trade.market.id;
    const outcome = trade.outcome;
    let live = true;
    const qty = sellMode ? -Math.abs(shares) : Math.abs(shares);
    if (!qty) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    previewPredictTrade(marketId, outcome, qty)
      .then((d) => {
        if (!live) return;
        setPreview(d.cost_usd);
        setPreviewError(null);
      })
      .catch((e) => {
        if (!live) return;
        setPreview(null);
        setPreviewError(errorText(e));
      });
    return () => {
      live = false;
    };
    // marketId, а не весь trade: цена двигается с каждой чужой сделкой, и объект
    // рынка при обновлении списка новый, а переспрашивать из-за этого нечего.
  }, [trade?.market.id, trade?.outcome, shares, sellMode]);

  async function confirmTrade() {
    if (!trade || !followerId || preview == null) return;
    setSending(true);
    try {
      const qty = sellMode ? -Math.abs(shares) : Math.abs(shares);
      const data = await tradePredictMarket(trade.market.id, followerId, trade.outcome, qty);
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
    if (!followerId) return;
    try {
      const data = await claimPredictMarket(p.market_id, followerId);
      setToast(`Забрано ${money(data.payout_usd)} по «${p.question}»`);
      setNonce((n) => n + 1);
    } catch (e) {
      setToast(`Выигрыш не начислен: ${errorText(e)}`);
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold">Predict</h2>
          <p className="text-slate-500 text-sm mt-0.5 max-w-2xl">
            Бинарные рынки на LMSR-пуле. Ценовые закрываются автоматически по mark-цене Lighter после дедлайна,
            событийные — куратором с указанием источника.
          </p>
        </div>
        <button
          onClick={() => setNonce((n) => n + 1)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 glass-hover rounded-xl px-3 py-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Обновить
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setStatus(f.id)}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
              status === f.id ? "glass text-cyan-400" : "text-slate-400 hover:text-slate-200 border border-slate-800"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="text-xs text-slate-600 ml-auto">
          {positions ? `позиций: ${positions.length}` : followerId ? "позиции грузятся…" : "позиции — после входа"}
          {claimable.length > 0 && <span className="text-emerald-400"> · доступно к выплате {claimable.length}</span>}
        </span>
      </div>

      {positions && positions.length > 0 && (
        <div className="mb-5 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-slate-800 text-xs uppercase tracking-wide text-slate-500">
            Мои позиции
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-slate-500 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Рынок</th>
                  <th className="text-right font-medium px-3 py-2">Доля</th>
                  <th className="text-right font-medium px-3 py-2">shares</th>
                  <th className="text-right font-medium px-3 py-2">Средняя</th>
                  <th className="text-right font-medium px-3 py-2">Стоит сейчас</th>
                  <th className="text-right font-medium px-3 py-2">P&amp;L</th>
                  <th className="text-right font-medium px-4 py-2"> </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  // Для резолвленного рынка берём номинал победившей доли ($1), а не
                  // claimable_usd: после «Забрать» бэкенд обнуляет claimable, и P&L
                  // иначе превратился бы в убыток ровно у того, кто деньги получил.
                  const pnl =
                    p.market_status === "resolved"
                      ? predictOutcomeWorth(p.market_outcome, p.outcome) * p.shares - p.net_cost_usd
                      : p.mark_value_usd - p.net_cost_usd;
                  return (
                    <tr key={`${p.market_id}:${p.outcome}`} className="border-t border-slate-800/70">
                      <td className="px-4 py-2.5 text-slate-200">
                        <div className="max-w-[22rem] truncate">{p.question}</div>
                        <div className="text-xs text-slate-600">
                          {p.outcome.toUpperCase()} ·{" "}
                          {p.market_status === "open" ? predictTimeLeft(p.resolve_at, now) : `исход ${p.market_outcome ?? "не указан"}`}
                          {p.claimed && " · забрано"}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">{cents(p.mark_price)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">{p.shares}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-400">{money(p.avg_entry_usd)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                        {p.market_status === "resolved" ? money(p.claimable_usd) : money(p.mark_value_usd)}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-mono ${pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {pnl >= 0 ? "+" : "−"}
                        {money(Math.abs(pnl))}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {p.claimable_usd > 0 && !p.claimed && (
                          <button
                            onClick={() => claim(p)}
                            className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Забрать {money(p.claimable_usd)}
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
        <div className="mb-4 bg-rose-950/40 border border-rose-900 rounded-2xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-rose-200">Список рынков не загрузился</p>
            <p className="text-rose-400/80 text-xs font-mono mt-0.5">{marketsError}</p>
          </div>
        </div>
      )}

      {!markets && !marketsError && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <Skeleton className="h-3 w-24 mb-3" />
              <Skeleton className="h-4 w-full mb-2" />
              <Skeleton className="h-2 w-full mb-4" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      )}

      {markets && markets.length === 0 && !marketsError && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl py-16 flex flex-col items-center text-center px-6">
          <p className="text-slate-400 text-sm mb-1">
            {status === "open" ? "Открытых рынков нет" : status === "resolved" ? "Резолвленных рынков пока нет" : "Рынков нет"}
          </p>
          <p className="text-slate-600 text-xs">
            Создать может только куратор: POST /predict/markets/price или /predict/markets/event с заголовком
            X-Curator-Token.
          </p>
        </div>
      )}

      {markets && markets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {markets.map((m) => {
            const yes = heldByKey.get(`${m.id}:yes`);
            const no = heldByKey.get(`${m.id}:no`);
            const resolved = m.status === "resolved";
            return (
              <div key={m.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="text-xs text-slate-500 uppercase tracking-wide">
                    {m.kind === "price" ? "Цена на Lighter" : "Событие"}
                  </span>
                  <span className="text-xs text-slate-600">
                    {resolved ? "закрыт" : predictTimeLeft(m.resolve_at, now)}
                  </span>
                </div>
                <div className="text-slate-100 text-sm font-medium mb-1">{m.question}</div>
                {conditionOf(m) && <div className="text-xs text-slate-500 font-mono mb-3">{conditionOf(m)}</div>}

                {resolved ? (
                  <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2.5 mb-3 text-xs">
                    <span className="text-slate-500">исход </span>
                    <span className="text-slate-100 font-semibold uppercase">{m.outcome ?? "не указан"}</span>
                    <span className="text-slate-600"> · </span>
                    <span className="text-slate-500">победившая доля — $1, проигравшая — $0</span>
                    {m.resolved_by && <div className="text-slate-600 mt-1 font-mono">закрыл: {m.resolved_by}</div>}
                    {m.evidence_url && (
                      <a
                        href={m.evidence_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 mt-1"
                      >
                        Источник <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex-1 h-2 bg-rose-950 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500" style={{ width: `${m.price_yes * 100}%` }} />
                    </div>
                    <span className="text-xs font-mono text-slate-400 w-16 text-right">
                      {(m.price_yes * 100).toFixed(0)}% YES
                    </span>
                  </div>
                )}

                <div className="flex gap-2 mt-auto">
                  <button
                    onClick={() => openTrade(m, "yes")}
                    disabled={resolved}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                  >
                    {resolved ? "YES" : `Купить YES ${cents(m.price_yes)}`}
                  </button>
                  <button
                    onClick={() => openTrade(m, "no")}
                    disabled={resolved}
                    className="flex-1 bg-rose-500 hover:bg-rose-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                  >
                    {resolved ? "NO" : `Купить NO ${cents(m.price_no)}`}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2 mt-3 text-xs text-slate-600">
                  <span>
                    объём {fmtUsdCompact(m.volume_usd)} · сделок {m.trade_count}
                  </span>
                  {(yes || no) && (
                    <span className="text-slate-400">
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

      <p className="text-slate-600 text-xs mt-4">
        Объём и число сделок — сделки через Wake, а не глубина пула: прямого доступа к книге LMSR у сайта нет.
        Рынок с нулевым объёмом ещё никто не торговал, и это не значит, что он пустой.
      </p>

      {trade && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setTrade(null)}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 gap-3">
              <h3 className="text-white font-semibold text-sm">
                {sellMode ? "Продать" : "Купить"} {trade.outcome.toUpperCase()} — {trade.market.question}
              </h3>
              <button onClick={() => setTrade(null)} className="text-slate-500 hover:text-slate-300 shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            {trade.held > 0 && (
              <div className="flex gap-1.5 mb-3">
                <button
                  onClick={() => setSellMode(false)}
                  className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${!sellMode ? "glass text-cyan-400" : "text-slate-400 border border-slate-800"}`}
                >
                  Покупка
                </button>
                <button
                  onClick={() => setSellMode(true)}
                  className={`flex-1 text-xs py-1.5 rounded-lg transition-colors ${sellMode ? "glass text-cyan-400" : "text-slate-400 border border-slate-800"}`}
                >
                  Продажа (держишь {trade.held})
                </button>
              </div>
            )}

            <label className="text-xs text-slate-400 mb-1 block">Количество shares</label>
            <input
              type="number"
              min={1}
              max={sellMode ? trade.held : undefined}
              value={shares}
              onChange={(e) => setShares(Math.max(0, Number(e.target.value)))}
              className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 mb-1 text-white font-mono outline-none w-full"
            />
            {sellMode && (
              <p className="text-xs text-slate-600 mb-2">Продать можно не больше {trade.held} shares.</p>
            )}

            <div className="flex justify-between text-xs text-slate-500 mt-3 mb-1">
              <span>{sellMode ? "Вернётся на счёт" : "Стоимость сейчас"}</span>
              <span className="font-mono text-slate-300">
                {previewError ? (
                  <span className="text-rose-400">{previewError}</span>
                ) : preview == null ? (
                  "…"
                ) : (
                  money(Math.abs(preview))
                )}
              </span>
            </div>
            <div className="flex justify-between text-xs text-slate-500 mb-4">
              {sellMode ? (
                <>
                  <span>Останется shares</span>
                  <span className="font-mono text-slate-300">{Math.max(0, trade.held - shares)}</span>
                </>
              ) : (
                <>
                  <span>Номинал при победе</span>
                  <span className="font-mono text-slate-300">{money(shares)}</span>
                </>
              )}
            </div>

            <button
              onClick={confirmTrade}
              disabled={sending || preview == null || shares <= 0 || (sellMode && shares > trade.held)}
              className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-600 text-slate-950 font-semibold rounded-xl py-3 transition-colors"
            >
              {sending
                ? "Отправка…"
                : preview == null
                  ? "Цена недоступна"
                  : sellMode
                    ? `Продать ${shares}`
                    : `Купить ${shares} за ${money(preview)}`}
            </button>
            <p className="text-xs text-slate-600 mt-3 text-center">
              Номинал — это не прибыль: share победившего исхода после резолюции стоит $1, проигравшего — $0,
              а вход по LMSR-кривой обычно дороже {cents(0.5)} и двигается против тебя с каждой покупкой.
              Верхнюю границу продажи и запрет торговать по закрытому рынку держит бэкенд, а не эта форма.
            </p>
          </div>
        </div>
      )}

      {!followerId && (
        <div className="mt-5 bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-slate-600 mt-0.5" />
            <div>
              <p className="text-slate-300 text-sm">Рынки видны без входа, а позиция и выплаты — нет.</p>
              <p className="text-slate-600 text-xs mt-0.5">
                Вход через Telegram или кошелёк: трейды пишутся на твой follower_id, выигрыш начисляется на него же.
              </p>
            </div>
          </div>
          <button
            onClick={onConnect}
            className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Войти
          </button>
        </div>
      )}
    </div>
  );
}
