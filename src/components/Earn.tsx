import { useEffect, useState } from "react";
import { Radio, ChevronRight, Users, DollarSign, TrendingUp, TrendingDown, Percent, Wallet } from "lucide-react";
import { listLeaders, listFollowsForLeader, setLeaderFee, type LeaderFollowRow } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { buildLeader } from "../lib/leaders";
import type { Leader } from "./types";
import { fmt, shortHandle, avatarColor, usd } from "./utils";

type Tab = "terminal" | "discover" | "portfolio" | "earn" | "predict" | "agent" | "risk" | "funding";

interface EarnProps {
  isCopyable: boolean;
  setTab: (tab: Tab) => void;
  leaderId: string | null;
  leaderFeeBps: number;
  setLeaderFeeBps: (feeBps: number) => void;
  lighterAccountIndex: number | null;
}

export function Earn({ isCopyable, setTab, leaderId, leaderFeeBps, setLeaderFeeBps, lighterAccountIndex }: EarnProps) {
  const [leader, setLeader] = useState<Leader | null>(null);
  const [follows, setFollows] = useState<LeaderFollowRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feeDraft, setFeeDraft] = useState(leaderFeeBps);
  const [feeSaving, setFeeSaving] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  // Оборот за месяц — единственная цифра здесь, которой нет в базе. Она вводится
  // вручную и подписана как допущение; всё остальное — строки follows и ответ Lighter.
  const [turnsPerMonth, setTurnsPerMonth] = useState(4);

  useEffect(() => {
    if (!leaderId) {
      setLeader(null);
      setFollows(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const rows = await listLeaders();
        const mine = rows.find((r) => r.id === leaderId);
        if (!mine) {
          if (!cancelled) {
            setLeader(null);
            setLoadError("Такой записи нет в таблице leaders — включи «Публиковать мои сделки» заново");
          }
          return;
        }
        const built = await buildLeader(mine);
        const subs = await listFollowsForLeader(leaderId!).catch(() => []);
        if (!cancelled) {
          setLeader(built);
          setFollows(subs.sort((a, b) => b.allocation_usd - a.allocation_usd));
          setLoadError(null);
          setFeeDraft(built.feeBps);
        }
      } catch (e) {
        if (!cancelled) setLoadError(errorText(e));
      }
    }
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [leaderId]);

  async function saveFee() {
    if (!leaderId || feeDraft === leader?.feeBps) return;
    setFeeSaving(true);
    setFeeError(null);
    try {
      await setLeaderFee(leaderId, feeDraft);
      setLeaderFeeBps(feeDraft);
      const rows = await listLeaders();
      const mine = rows.find((r) => r.id === leaderId);
      if (mine) setLeader(await buildLeader(mine));
    } catch (e) {
      setFeeError(errorText(e));
    } finally {
      setFeeSaving(false);
    }
  }

  if (!isCopyable) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl py-20 flex flex-col items-center text-center px-6">
        <Radio className="w-8 h-8 text-slate-700 mb-3" />
        <p className="text-slate-400 text-sm mb-1">Публикация выключена</p>
        <p className="text-slate-600 text-xs mb-4 max-w-md">
          «Публиковать мои сделки» в Терминале записывают твой аккаунт Lighter в таблицу <code className="text-slate-300">leaders</code> — после этого
          карточка появляется в Discover, а сюда начинают приходить подписки из <code className="text-slate-300">follows</code>.
        </p>
        <button onClick={() => setTab("terminal")} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
          Перейти в Терминал <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (!leaderId) {
    return (
      <div className="bg-slate-900 border border-amber-900 rounded-2xl py-16 flex flex-col items-center text-center px-6">
        <Radio className="w-8 h-8 text-amber-700 mb-3" />
        <p className="text-slate-300 text-sm mb-1">Переключатель включён, лидера в базе нет</p>
        <p className="text-slate-500 text-xs mb-4 max-w-md">
          POST /leaders не прошёл: бэкенд не отвечает{lighterAccountIndex == null ? ", либо по этому адресу нет аккаунта Lighter (лидер публикуется по номеру аккаунта, а не по адресу кошелька)" : ""}.
        </p>
        <button onClick={() => setTab("terminal")} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
          Проверить в Терминале <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  const pnl = leader?.exchange?.realizedPnlUsd ?? null;
  const aum = leader?.aumUsd ?? 0;
  const feeBps = leader?.feeBps ?? leaderFeeBps;
  const projected = (aum * feeBps * turnsPerMonth) / 10000;

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`w-11 h-11 rounded-full ${avatarColor(leader?.handle ?? "")} flex items-center justify-center text-sm font-bold text-white`}>
              {shortHandle(leader?.handle ?? "?")}
            </div>
            <div>
              <div className="text-slate-100 font-semibold">{leader?.handle ?? "загрузка…"}</div>
              <div className="text-slate-500 text-xs font-mono">
                Lighter #{leader?.lighterAccountIndex ?? lighterAccountIndex ?? "—"}
                {leader && <> · в сети с {new Date(leader.since * 1000).toLocaleDateString("ru-RU")}</>}
              </div>
            </div>
          </div>
          {loadError && <span className="text-xs text-amber-400">{loadError}</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-xs uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <Users className="w-3 h-3" /> Активные подписки
          </div>
          <div className="text-2xl font-mono font-bold text-white">{leader ? fmt(leader.followers) : "—"}</div>
          <div className="text-slate-600 text-[11px] mt-1">строки follows где paused = 0</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-xs uppercase tracking-wide mb-1 flex items-center gap-1.5">
            <DollarSign className="w-3 h-3" /> AUM в копиях
          </div>
          <div className="text-2xl font-mono font-bold text-white">{leader ? usd(aum, 0) : "—"}</div>
          <div className="text-slate-600 text-[11px] mt-1">сумма allocation_usd</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-xs uppercase tracking-wide mb-1 flex items-center gap-1.5">
            {pnl != null && pnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />} Реализованный PnL
          </div>
          <div className={`text-2xl font-mono font-bold ${pnl == null ? "text-slate-500" : pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
          </div>
          <div className="text-slate-600 text-[11px] mt-1">{pnl == null ? "Lighter не ответил" : "публичный GET /account?by=index"}</div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
            <Percent className="w-3 h-3" /> Комиссия за скопированную сделку
          </span>
          <span className="font-mono text-slate-100">{(feeDraft / 100).toFixed(2)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={feeDraft}
          onChange={(e) => setFeeDraft(Number(e.target.value))}
          className="w-full accent-cyan-400 my-2"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={saveFee}
            disabled={feeSaving || !leader || feeDraft === leader.feeBps}
            className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:hover:bg-cyan-500 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors"
          >
            {feeSaving ? "Записываю…" : feeDraft === leader?.feeBps ? "Сохранено" : "Сохранить в leaders.fee_bps"}
          </button>
          {feeError && <span className="text-xs text-red-400">{feeError}</span>}
        </div>
        <div className="text-slate-600 text-[11px] mt-2">
          Сейчас в базе: {(feeBps / 100).toFixed(2)}% — это значение видят подписчики в Discover.
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">Сколько это может быть в месяц</div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-slate-500 text-sm">Оборотов на подписчика в месяц</span>
          <input
            type="number"
            min={0}
            max={200}
            value={turnsPerMonth}
            onChange={(e) => setTurnsPerMonth(Math.max(0, Number(e.target.value)))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 w-20 text-white text-sm font-mono outline-none"
          />
        </div>
        <div className="font-mono text-sm text-slate-300 mb-2">
          {usd(aum, 0)} × {feeBps} bps × {turnsPerMonth} = <span className="text-amber-400">{usd(projected, 2)}</span>
        </div>
        <p className="text-slate-600 text-xs">
          Арифметика по твоему допущению об обороте, а не начисление: в репозитории нет кода, который удерживает fee_bps со сделок подписчика.
          Комиссия сейчас — объявленное условие в таблице <code className="text-slate-300">leaders</code>, которое видно в Discover, но которое пока
          не списывается. Сбор появится вместе с расчётным контуром поверх <code className="text-slate-300">mirror_log</code>.
        </p>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Подписчики</div>
        {!follows ? (
          <p className="text-slate-600 text-sm">Читаю follows…</p>
        ) : follows.length === 0 ? (
          <p className="text-slate-600 text-sm">
            На тебя пока никто не подписан. Карточка появляется в Discover сразу после регистрации лидера — подписчик выбирает аллокацию и плечо,
            они попадают в <code className="text-slate-300">follows</code>.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-normal">Подписчик</th>
                <th className="pb-2 font-normal">Аллокация</th>
                <th className="pb-2 font-normal">Плечо</th>
                <th className="pb-2 font-normal">Зеркалировано</th>
                <th className="pb-2 font-normal">С</th>
              </tr>
            </thead>
            <tbody>
              {follows.map((f) => (
                <tr key={f.id} className="border-b border-slate-800 last:border-0">
                  <td className="py-2.5 font-mono text-slate-400" title={f.follower_id}>
                    {f.follower_id.slice(0, 8)}…
                  </td>
                  <td className="py-2.5 font-mono text-slate-200">{usd(f.allocation_usd, 0)}</td>
                  <td className="py-2.5 font-mono text-slate-400">{f.max_leverage}x</td>
                  <td className="py-2.5 font-mono text-slate-400">{fmt(f.current_mirrored_size, 4)}</td>
                  <td className="py-2.5 font-mono text-slate-500 text-xs">{new Date(f.created_at * 1000).toLocaleDateString("ru-RU")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center gap-1.5 text-slate-600 text-[11px] mt-3">
          <Wallet className="w-3 h-3" /> Идентификатор подписчика — внутренний id из таблицы followers; адреса кошельков здесь не показываются.
        </div>
      </div>

      <p className="text-xs text-slate-600">
        Чтобы сделки действительно копировались, на сервере запущен <code className="text-slate-300">backend/leader_listener.py</code>: он слушает
        позиции лидера, считает <code className="text-slate-300">mirror_engine.compute_mirror_plan()</code> по каждой активной подписке и пишет итог
        в <code className="text-slate-300">mirror_log</code>. Пока <code className="text-slate-300">WAKE_DRY_RUN=true</code> (значение по умолчанию),
        статус строки — <code className="text-slate-300">dry_run</code>, ордер на Lighter не уходит.
      </p>
    </div>
  );
}
