import { useEffect, useState } from "react";
import { Radio, ChevronRight, Users, DollarSign, TrendingUp, TrendingDown, Percent } from "lucide-react";
import { listLeaders, listOwnLeaderFollowers, setLeaderFee, type LeaderFollowRow } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { buildLeader } from "../lib/leaders";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import type { Leader, Tab } from "./types";
import { avatarSlot, fmt, shortHandle, usd } from "./utils";

interface EarnProps {
  isCopyable: boolean;
  setTab: (tab: Tab) => void;
  leaderId: string | null;
  leaderError: string | null;
  leaderFeeBps: number;
  setLeaderFeeBps: (feeBps: number) => void;
  lighterAccountIndex: number | null;
}

export default function Earn({ isCopyable, setTab, leaderId, leaderError, leaderFeeBps, setLeaderFeeBps, lighterAccountIndex }: EarnProps) {
  const [leader, setLeader] = useState<Leader | null>(null);
  const [follows, setFollows] = useState<LeaderFollowRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feeDraft, setFeeDraft] = useState(leaderFeeBps);
  const [feeSaving, setFeeSaving] = useState(false);
  const [feeError, setFeeError] = useState<string | null>(null);
  /* Черновик комиссии «грязный», если человек сдвинул ползунок и ещё не
     сохранил. Опрос панели идёт каждые 15 секунд и присылает значение из базы;
     без этого флага он откатывал бы ползунок под рукой у того, кто его только
     что выставил, — контроль без видимого эффекта. */
  const [feeDirty, setFeeDirty] = useState(false);
  // Оборот за месяц — единственная цифра здесь, которой нет в базе. Она вводится
  // вручную и подписана как допущение; всё остальное — строки follows и ответ Lighter.
  const [turnsPerMonth, setTurnsPerMonth] = useState(4);

  useEffect(() => {
    if (!leaderId) return;
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
        const subs = await listOwnLeaderFollowers(leaderId!);
        if (!cancelled) {
          setLeader(built);
          setFollows(subs.sort((a, b) => b.allocation_usd - a.allocation_usd));
          setLoadError(null);
          if (!feeDirty) setFeeDraft(built.feeBps);
        }
      } catch (e) {
        if (!cancelled) setLoadError(errorText(e));
      }
    }
    void load();
    const stop = setIntervalWhenVisible(load, 15000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [leaderId, feeDirty]);

  async function saveFee() {
    if (!leaderId || feeDraft === leader?.feeBps) return;
    setFeeSaving(true);
    setFeeError(null);
    try {
      await setLeaderFee(leaderId, feeDraft);
      setLeaderFeeBps(feeDraft);
      // Черновик стал значением базы: с этого момента опрос снова имеет право
      // синхронизировать ползунок.
      setFeeDirty(false);
      const rows = await listLeaders();
      const mine = rows.find((r) => r.id === leaderId);
      if (mine) setLeader(await buildLeader(mine));
    } catch (e) {
      setFeeError(errorText(e));
    } finally {
      setFeeSaving(false);
    }
  }

  if (leaderError) {
    return (
      <div className="empty-state">
        <p className="panel-lead">Не удалось прочитать состояние публикации</p>
        <p className="muted">Бэкенд Wake не вернул запись лидера: {leaderError}</p>
        <button className="link-action" onClick={() => setTab("terminal")}>
          Проверить в Терминале <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (!isCopyable) {
    return (
      <div className="terminal-layout terminal-stack">
        <div className="empty-state">
          <span className="empty-mark">
            <Radio size={24} aria-hidden="true" />
          </span>
          <p className="panel-lead">Публикация выключена</p>
          <p className="muted">
            «Публиковать мои сделки» в Терминале записывает твой аккаунт Lighter в таблицу <code>leaders</code> — после этого
            карточка появляется в Discover, а сюда начинают приходить подписки из <code>follows</code>.
          </p>
          <button className="link-action" onClick={() => setTab("terminal")}>
            Перейти в Терминал <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  if (!leaderId) {
    return (
      <div className="terminal-layout terminal-stack">
        <div className="empty-state">
          <span className="empty-mark empty-mark-warn">
            <Radio size={24} aria-hidden="true" />
          </span>
          <p className="panel-lead">Переключатель включён, лидера в базе нет</p>
          <p className="muted">
            Не удалось зарегистрировать лидера: бэкенд недоступен{lighterAccountIndex == null ? ", либо по этому адресу нет аккаунта Lighter" : ""}.
          </p>
          <button className="link-action" onClick={() => setTab("terminal")}>
            Проверить в Терминале <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  const pnl = leader?.exchange?.realizedPnlUsd ?? null;
  const aum = leader?.aumUsd ?? 0;
  const feeBps = leader?.feeBps ?? leaderFeeBps;
  const projected = (aum * feeBps * turnsPerMonth) / 10000;

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header terminal-header--stack">
          <div className="panel-head-row">
            <h2 className="section-title">Заработок лидера</h2>
            <span className="section-note push-right">
              PATCH /leaders/&lt;id&gt;/fee · опрос раз в 15 с
            </span>
          </div>
          <p className="panel-lead">
            Сколько подписок читает копи-движок из таблицы <code>follows</code> и какую комиссию ты объявил в{" "}
            <code>leaders.fee_bps</code>. Объявить комиссию — не то же самое, что собирать её: что именно делает сервер с{" "}
            <code>leader_listener.py</code>, написано внизу панели.
          </p>
        </div>

        <div className="terminal-panel panel-pad">
          <div className="row">
            <span className="avatar avatar-lg" data-tag={avatarSlot(leader?.handle ?? "")}>
              {shortHandle(leader?.handle ?? "?")}
            </span>
            <div className="stack">
              <span className="panel-title">{leader?.handle ?? "загрузка…"}</span>
              <span className="muted num">
                Lighter #{leader?.lighterAccountIndex ?? lighterAccountIndex ?? "—"}
                {leader && <> · в сети с {new Date(leader.since * 1000).toLocaleDateString("ru-RU")}</>}
              </span>
            </div>
          </div>
          {/* Ошибка загрузки — строкой ниже ника: она длиннее самой шапки, и
              в inline-span справа она только съезжала вправо-вниз. */}
          {loadError && (
            <div className="notice notice-warn">
              leaders не ответили: <span className="num">{loadError}</span>
            </div>
          )}
        </div>

        <div className="terminal-panel panel-pad">
          <div className="desk-stats">
            <div className="desk-stat desk-stat-lg">
              <span className="label label-row">
                <Users size={10} aria-hidden="true" /> Активные подписки
              </span>
              <b>{leader ? fmt(leader.followers) : "—"}</b>
              <span className="sub-label">строки follows где paused = 0</span>
            </div>
            <div className="desk-stat desk-stat-lg">
              <span className="label label-row">
                <DollarSign size={10} aria-hidden="true" /> AUM в копиях
              </span>
              <b>{leader ? usd(aum, 0) : "—"}</b>
              <span className="sub-label">сумма allocation_usd</span>
            </div>
            <div className="desk-stat desk-stat-lg">
              <span className="label label-row">
                {pnl != null && pnl >= 0 ? (
                  <TrendingUp size={10} aria-hidden="true" />
                ) : (
                  <TrendingDown size={10} aria-hidden="true" />
                )}{" "}
                Реализованный PnL
              </span>
              <b className={pnl == null ? "muted" : pnl >= 0 ? "text-positive" : "text-negative"}>
                {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
              </b>
              <span className="sub-label">
                {pnl == null ? "Lighter не ответил" : "публичный GET /account?by=index"}
              </span>
            </div>
          </div>
        </div>

        <div className="terminal-panel panel-pad">
          <div className="row-between">
            <label htmlFor="leader-fee" className="label label-row">
              <Percent size={10} aria-hidden="true" /> Комиссия за скопированную сделку
            </label>
            <span className="num">{(feeDraft / 100).toFixed(2)}%</span>
          </div>
          <input
            id="leader-fee"
            className="range"
            type="range"
            min={0}
            max={50}
            step={1}
            value={feeDraft}
            onChange={(e) => {
              setFeeDraft(Number(e.target.value));
              setFeeDirty(true);
            }}
            aria-valuetext={`${(feeDraft / 100).toFixed(2)}% за сделку`}
          />
          <div className="row">
            <button
              onClick={() => void saveFee()}
              disabled={feeSaving || !leader || feeDraft === leader.feeBps}
              className="btn-primary"
            >
              {feeSaving ? "Записываю…" : feeDraft === leader?.feeBps ? "Сохранено" : "Сохранить в leaders.fee_bps"}
            </button>
            {feeError && <span className="text-negative">{feeError}</span>}
          </div>
          <p className="fineprint">
            Сейчас в базе: <span className="num">{(feeBps / 100).toFixed(2)}%</span> — это значение видят подписчики в Discover.
          </p>
        </div>

        <div className="terminal-panel panel-pad">
          <span className="label">Сколько это может быть в месяц</span>
          <div className="row-between">
            <label htmlFor="leader-turns" className="label">
              Оборотов на подписчика в месяц
            </label>
            <input
              id="leader-turns"
              type="number"
              min={0}
              max={200}
              value={turnsPerMonth}
              onChange={(e) => {
                // valueAsNumber: у «1e» и «-» Number(...) даёт NaN, и
                // Math.max(0, NaN) остаётся NaN — он попадал и в value поля
                // (браузер показывал пустую строку), и в сумму прогноза.
                const raw = e.target.valueAsNumber;
                setTurnsPerMonth(Number.isFinite(raw) ? Math.min(200, Math.max(0, raw)) : 0);
              }}
              className="input-mono input-num"
            />
          </div>
          <p className="num">
            {usd(aum, 0)} × {feeBps} bps × {turnsPerMonth} = <span className="text-warn">{usd(projected, 2)}</span>
          </p>
          <p className="muted">
            Арифметика по твоему допущению об обороте, а не начисление: в репозитории нет кода, который удерживает fee_bps со сделок подписчика.
            Комиссия сейчас — объявленное условие в таблице <code>leaders</code>, которое видно в Discover, но которое пока
            не списывается. Сбор появится вместе с расчётным контуром поверх <code>mirror_log</code>.
          </p>
        </div>

        <div className="terminal-panel panel-pad">
          <span className="label">Подписчики</span>
          {!follows ? (
            <p className="muted">Читаю follows…</p>
          ) : follows.length === 0 ? (
            <p className="muted">
              На тебя пока никто не подписан. Карточка появляется в Discover сразу после регистрации лидера — подписчик выбирает аллокацию и плечо,
              они попадают в <code>follows</code>.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table data-table--fit" aria-label="Подписчики">
                <thead>
                  <tr>
                    <th scope="col" className="left">Подписчик</th>
                    <th scope="col">Аллокация</th>
                    <th scope="col">Плечо</th>
                    <th scope="col">Зеркалировано</th>
                    <th scope="col">С даты</th>
                  </tr>
                </thead>
                <tbody>
                  {follows.map((f) => (
                    <tr key={f.id}>
                      <td className="left num" title={f.follower_id}>
                        {f.follower_id.slice(0, 8)}…
                      </td>
                      <td className="right num">{usd(f.allocation_usd, 0)}</td>
                      <td className="right num">{f.max_leverage}x</td>
                      <td className="right num">{fmt(f.current_mirrored_size, 4)}</td>
                      <td className="right num muted">{new Date(f.created_at * 1000).toLocaleDateString("ru-RU")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="fineprint">
            Идентификатор подписчика — внутренний id из таблицы followers; адреса кошельков здесь не показываются.
          </p>
        </div>

        <p className="fineprint">
          Чтобы сделки действительно копировались, на сервере запущен <code>backend/leader_listener.py</code>: он слушает
          позиции лидера, считает <code>mirror_engine.compute_mirror_plan()</code> по каждой активной подписке и пишет итог
          в <code>mirror_log</code>. Пока <code>WAKE_DRY_RUN=true</code> (значение по умолчанию),
          статус строки — <code>dry_run</code>, ордер на Lighter не уходит.
        </p>
      </div>
    </div>
  );
}
