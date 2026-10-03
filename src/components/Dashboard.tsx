import { useEffect, useState } from "react";
import { ArrowRight, BarChart3, Percent, RefreshCw, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { getMarketOverview, type MarketOverview, type MarketOverviewRow } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { getPredictMarkets, predictTimeLeft, type PredictMarket } from "../lib/predict";
import { fmtPrice, fmtPct, fmtUsdCompact } from "./utils";
import { Skeleton } from "./ui";
import type { Tab } from "./types";

// Бэкенд кэширует обзор на 60 секунд (backend/cache.py), поэтому крутить чаще —
// это не «свежее», а пустые запросы.
const REFRESH_MS = 60_000;
const SHOWN_BY_DEFAULT = 10;

interface DashboardProps {
  setTab: (tab: Tab) => void;
  setAsset: (asset: string) => void;
}

export function Dashboard({ setTab, setAsset }: DashboardProps) {
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  // null — это «ещё не загрузилось», [] — «загрузилось и рынков правда нет».
  // Одно состояние на оба случая печатало бы «Открытых рынков нет» до первого
  // ответа бэкенда, а /markets/overview стоит дорого (18 свечных запросов) и не
  // успевает до отрисовки.
  const [predict, setPredict] = useState<PredictMarket[] | null>(null);
  // Ошибка Predict — отдельным состоянием: «рынков нет» и «бэкенд не ответил» —
  // это разные вещи, и показывать первое вместо второго значит прятать поломку.
  const [predictError, setPredictError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Кнопка «обновить» меняет именно зависимость эффекта. Сбросить состояние в
  // null — это не перезагрузка: следующий запрос всё равно произошёл бы только
  // через 60 секунд, и кнопка выглядела бы рабочей, не будучи ею.
  const [nonce, setNonce] = useState(0);

  // Два независимых эффекта, а не один с двумя await подряд: обзор считается
  // секунды, и последовательное ожидание держало бы Predict пустым всё это время.
  useEffect(() => {
    let alive = true;
    getMarketOverview()
      .then((data) => {
        if (!alive) return;
        setOverview(data);
        setMarketsError(null);
      })
      .catch((e) => {
        if (alive) setMarketsError(errorText(e));
      });
    const id = setInterval(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    getPredictMarkets("open")
      .then((rows) => {
        if (!alive) return;
        setPredict(rows);
        setPredictError(null);
      })
      .catch((e) => {
        if (alive) setPredictError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  function openMarket(row: MarketOverviewRow) {
    // symbol — ровно то, что лежит в книге Lighter: Terminal ищет рынок по этому
    // же полю, и расхождение (base вместо symbol) открывало бы пустой терминал.
    setAsset(row.symbol);
    setTab("terminal");
  }

  const rows = overview?.rows ?? [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_BY_DEFAULT);
  const missing = [...(overview?.no_market ?? []), ...(overview?.no_data ?? [])];

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-semibold text-lg">Рынки Lighter</h2>
          <p className="text-[#666] text-sm mt-1 max-w-3xl">
            Перпы, отсортированные по фактическому $-обороту за 24 часа: оборот — сумма 24 часовых свечей по каждому
            рынку, а не поле из книги (его в /orderBooks нет). Те же строки и тот же метод, что печатает{" "}
            <span className="text-[#888] font-mono text-xs">/markets</span> в Telegram-боте; считать их дважды в
            браузере смысла нет — цифры разошлись бы с ботом.
          </p>
        </div>
        <button
          onClick={() => setNonce((n) => n + 1)}
          className="shrink-0 flex items-center gap-1.5 text-xs text-[#888] hover:text-[#ccc] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded-full px-3 py-1.5 transition-colors"
          title="Обновить сейчас"
        >
          <RefreshCw className="w-3.5 h-3.5" /> обновить
        </button>
      </div>

      {marketsError && (
        <div className="terminal-panel rounded-lg p-3 flex items-start gap-2 text-xs text-[#ff6b35]">
          <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Обзор рынка не пришёл — {marketsError} Свечевые запросы к Lighter делает бэкенд Wake, так что к самому Lighter
            здесь претензий нет; те же строки бот отдаёт по /markets.
          </span>
        </div>
      )}

      {!overview && !marketsError ? (
        <div className="terminal-panel rounded-lg p-4 space-y-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : !overview ? (
        // Только ошибка: таблицу с нулём рядов рисовать незачем — вопрос уже разобран
        // в баннере выше, а «рядов 0» под ним читался бы как ответ про рынок.
        null
      ) : rows.length === 0 ? (
        <div className="terminal-panel rounded-lg py-14 text-center">
          <p className="text-[#888] text-sm">Ни один рынок не собрался из живых данных</p>
          <p className="text-[#666] text-xs mt-1">
            Это не пустой список по умолчанию: бэкенд вернул ответ без рядов — детали в no_market / no_data ниже.
          </p>
        </div>
      ) : (
        <div className="terminal-panel rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[#666] border-b border-[#2a2a2a]">
                <th className="px-4 py-2.5 font-normal">#</th>
                <th className="px-2 py-2.5 font-normal">Актив</th>
                <th className="px-2 py-2.5 font-normal text-right">Цена</th>
                <th className="px-2 py-2.5 font-normal text-right">24ч</th>
                <th className="px-2 py-2.5 font-normal text-right">Оборот 24ч</th>
                <th className="px-2 py-2.5 font-normal text-right" title="Ставка за часовую эпоху funding">
                  Funding, %/ч
                </th>
                <th className="px-2 py-2.5 font-normal text-right">Годовая</th>
                <th className="px-2 py-2.5 font-normal">Платят</th>
                <th className="px-2 py-2.5 font-normal text-right" title="Открытый интерес в единицах актива, не в долларах">
                  OI, баз.
                </th>
                <th className="px-2 py-2.5 font-normal text-right">Мин. лот</th>
                <th className="px-2 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr
                  key={r.market_id}
                  onClick={() => openMarket(r)}
                  className="border-b border-[#2a2a2a]/60 last:border-0 hover:bg-[#ff6b35]/5 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2 text-slate-600 font-mono text-xs">{i + 1}</td>
                  <td className="px-2 py-2 text-slate-100 font-medium">{r.symbol}</td>
                  <td className="px-2 py-2 text-right font-mono text-white">{fmtPrice(r.price)}</td>
                  <td className={`px-2 py-2 text-right font-mono ${r.change_24h >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {fmtPct(r.change_24h)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">{fmtUsdCompact(r.quote_volume_24h)}</td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">
                    {r.funding_hourly == null ? "—" : (r.funding_hourly * 100).toFixed(4)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">
                    {r.funding_annualized == null ? "—" : `${(r.funding_annualized * 100).toFixed(1)}%`}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {/* Кто платит — это и есть сторона, забирающая ставку. */}
                    {r.funding_payer == null ? (
                      <span className="text-slate-700">нет ставки</span>
                    ) : r.funding_payer === "long" ? (
                      <span className="text-emerald-400">лонги</span>
                    ) : (
                      <span className="text-red-400">шорты</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {r.open_interest_base > 0 ? r.open_interest_base.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-500">
                    {r.min_base_amount > 0 ? r.min_base_amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <ArrowRight className="w-3.5 h-3.5 text-slate-600 inline" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="px-4 py-2 border-t border-slate-800 flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span>
              сеть {overview?.network} · рядов {rows.length} · оборот и цена из живого API Lighter
            </span>
            {rows.length > SHOWN_BY_DEFAULT && (
              <button onClick={() => setShowAll((v) => !v)} className="text-cyan-400 hover:text-cyan-300 transition-colors">
                {showAll ? "свернуть" : `показать все ${rows.length}`}
              </button>
            )}
            {missing.length > 0 && <span className="text-slate-500">без данных: {missing.join(", ")}</span>}
          </div>
        </div>
      )}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-cyan-400" /> Predict — открытые рынки
          </h3>
          <button onClick={() => setTab("predict")} className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 transition-colors">
            торговать <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
        {predictError ? (
          <div className="bg-slate-900 border border-amber-800 rounded-2xl p-3 text-xs text-amber-300">
            Открытые рынки Predict не загрузились — {predictError}
          </div>
        ) : predict === null ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[0, 1].map((i) => (
              <div key={i} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-1.5 w-full" />
              </div>
            ))}
          </div>
        ) : predict.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 text-sm text-slate-500">
            Открытых рынков нет. Резолвленные с исходами — во вкладке Predict; создать рынок может только куратор
            (POST /predict/markets/price или /predict/markets/event с X-Curator-Token).
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {predict.slice(0, 4).map((m) => (
              <button
                key={m.id}
                onClick={() => setTab("predict")}
                className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 text-left transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-500 uppercase tracking-wide">
                    {m.kind === "price" ? "цена на Lighter" : "событие"}
                  </span>
                  <span className="text-xs text-slate-600">{predictTimeLeft(m.resolve_at)}</span>
                </div>
                <div className="text-slate-100 text-sm mb-3">{m.question}</div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1.5 bg-red-950 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${m.price_yes * 100}%` }} />
                  </div>
                  <span className="text-xs font-mono text-slate-400">{(m.price_yes * 100).toFixed(0)}% YES</span>
                  <span className="text-xs font-mono text-slate-500">
                    {fmtUsdCompact(m.volume_usd)} · {m.trade_count} сдел.
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button onClick={() => setTab("discover")} className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 text-left transition-colors">
          <Users className="w-4 h-4 text-cyan-400 mb-2" />
          <div className="text-white font-medium text-sm mb-1">Копирование сделок</div>
          <div className="text-slate-500 text-xs leading-relaxed">
            Лидер торгует своим депозитом на Lighter; его сделка повторяется в твоей позиции пропорционально аллокации.
            Комиссия — б.п. от профита, 0–500, задаёт сам лидер.
          </div>
        </button>
        <button onClick={() => setTab("risk")} className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 text-left transition-colors">
          <ShieldAlert className="w-4 h-4 text-violet-400 mb-2" />
          <div className="text-white font-medium text-sm mb-1">Риск корзины</div>
          <div className="text-slate-500 text-xs leading-relaxed">
            Собери позиции из реальных рынков: 30 часовых закрытий, волатильность корзины против наивной суммы складывающихся
            позиций и подбор хеджа из тех же рынков.
          </div>
        </button>
        <button onClick={() => setTab("funding")} className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 text-left transition-colors">
          <Percent className="w-4 h-4 text-emerald-400 mb-2" />
          <div className="text-white font-medium text-sm mb-1">Funding и carry</div>
          <div className="text-slate-500 text-xs leading-relaxed">
            Ставки Lighter рядом с Binance, Bybit и Hyperliquid по тому же market_id, и разложение дельта-нейтральной
            связки на две ноги с округлением под минимальный лот.
          </div>
        </button>
      </div>
    </div>
  );
}
