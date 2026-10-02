import { useState, useEffect } from "react";
import { Users, DollarSign, Copy as CopyIcon, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { listLeaders } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { buildLeader } from "../lib/leaders";
import { fmt, avatarColor, shortHandle, usd } from "./utils";
import type { Leader } from "./types";

interface DiscoverProps {
  setCopyModal: (leader: Leader | null) => void;
}

export function Discover({ setCopyModal }: DiscoverProps) {
  const [leaders, setLeaders] = useState<Leader[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const rows = await listLeaders();
        const built = await Promise.all(rows.map(buildLeader));
        // Realised PnL first; leaders Lighter did not answer for fall below, ordered by AUM.
        const rank = (t: Leader) => (t.exchange ? t.exchange.realizedPnlUsd : -1e12);
        setLeaders(built.sort((a, b) => rank(b) - rank(a) || b.aumUsd - a.aumUsd));
        setError(null);
      } catch (e) {
        setError(errorText(e));
        setLeaders([]);
      }
    }
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h2 className="text-white font-bold text-xl mb-2">Кого копируют</h2>
        <p className="text-slate-400 text-sm">
          Лидеры — из таблицы <code className="text-slate-300">leaders</code>, подписчики и AUM — из <code className="text-slate-300">follows</code>.
          Капитал, реализованный PnL и открытые позиции — публичный ответ Lighter{" "}
          <code className="text-slate-300">GET /api/v1/account?by=index</code> по аккаунту лидера. Выдуманных цифр здесь нет: если Lighter не
          отвечает, карточка честно показывает прочерк. Handle лидер вписывает сам и подписи кошелька за ним пока нет — поэтому в карточке виден
          индекс аккаунта: по нему статика читается на самом Lighter.
        </p>
      </div>

      {leaders === null ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-4 bg-slate-800 rounded w-1/2 mb-3"></div>
              <div className="h-8 bg-slate-800 rounded"></div>
            </div>
          ))}
        </div>
      ) : leaders.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl py-16 flex flex-col items-center text-center px-6">
          <Users className="w-8 h-8 text-slate-700 mb-3" />
          <p className="text-slate-400 text-sm mb-1">В базе пока нет ни одного лидера</p>
          <p className="text-slate-600 text-xs max-w-md">
            Лидер появляется сам: в Терминале включи «Публиковать мои сделки» — переключатель пишет строку в{" "}
            <code className="text-slate-300">leaders</code> через <code className="text-slate-300">POST /leaders</code>.
            Нужен кошелёк с аккаунтом Lighter: лидера публикуют по индексу его аккаунта, поэтому статика потом читается с биржи, а не из формы.
            {error && <span className="text-amber-400 mt-2 block">Бэкенд ответил: {error}</span>}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {leaders.map((t) => {
            const pnl = t.exchange?.realizedPnlUsd ?? null;
            return (
              <div key={t.id} className="card-hover">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-12 h-12 rounded-full ${avatarColor(t.handle)} flex items-center justify-center text-base font-bold text-white shadow-lg`}
                    >
                      {shortHandle(t.handle)}
                    </div>
                    <div>
                      <div className="text-slate-100 font-semibold">{t.handle}</div>
                      <div className="text-slate-500 text-sm font-mono">Lighter #{t.lighterAccountIndex}</div>
                    </div>
                  </div>
                  <span className="text-xs text-slate-400 glass rounded-full px-3 py-1 shrink-0">{(t.feeBps / 100).toFixed(2)}% за сделку</span>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <div className="text-slate-500 text-xs flex items-center gap-1 mb-1">
                      <Wallet className="w-3 h-3" /> Капитал на Lighter
                    </div>
                    <div className="text-slate-100 font-mono">{pnl === null ? "—" : usd(t.exchange!.equityUsd, 0)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-xs flex items-center gap-1 mb-1">
                      {pnl != null && pnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />} Реализованный PnL
                    </div>
                    <div className={`font-mono ${pnl == null ? "text-slate-500" : pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
                    </div>
                  </div>
                </div>

                <div className="flex justify-between text-sm font-mono mb-1">
                  <span className="text-slate-400 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" />
                    {fmt(t.followers)} подписчиков
                  </span>
                  <span className="text-slate-400 flex items-center gap-1">
                    <DollarSign className="w-3.5 h-3.5" />
                    {fmt(t.aumUsd)} в копиях
                  </span>
                </div>
                <div className="text-xs text-slate-600 mb-4">
                  {t.exchange ? `${t.exchange.openPositions.length} открытых позиций` : "Lighter не ответил"} · в сети с{" "}
                  {new Date(t.since * 1000).toLocaleDateString("ru-RU")}
                </div>
                <button onClick={() => setCopyModal(t)} className="w-full btn-primary flex items-center justify-center gap-2">
                  <CopyIcon className="w-4 h-4" /> Copy
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
