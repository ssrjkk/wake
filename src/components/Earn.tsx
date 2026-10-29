import { useEffect, useState } from "react";
import { Radio, ChevronRight, Users, DollarSign, TrendingUp, TrendingDown, Percent, Wallet } from "lucide-react";
import { listLeaders, listOwnLeaderFollowers, setLeaderFee, type LeaderFollowRow } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { buildLeader } from "../lib/leaders";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import type { Leader, Tab } from "./types";
import { fmt, shortHandle, avatarColor, usd } from "./utils";

interface EarnProps {
  isCopyable: boolean;
  setTab: (tab: Tab) => void;
  leaderId: string | null;
  leaderFeeBps: number;
  setLeaderFeeBps: (feeBps: number) => void;
  lighterAccountIndex: number | null;
}

export default function Earn({ isCopyable, setTab, leaderId, leaderFeeBps, setLeaderFeeBps, lighterAccountIndex }: EarnProps) {
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

  if (!isCopyable) {
    return (
      <div className="terminal-layout terminal-stack">
        <div className="empty-state">
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "var(--bg-2)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Radio style={{ width: "24px", height: "24px", color: "var(--text-muted)" }} />
          </div>
          <p style={{ fontSize: "var(--fs-body)", color: "var(--fg-2)", marginBottom: "4px" }}>Публикация выключена</p>
          <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "16px", maxWidth: "400px" }}>
            «Публиковать мои сделки» в Терминале записывает твой аккаунт Lighter в таблицу <code style={{ color: "var(--fg-2)" }}>leaders</code> — после этого
            карточка появляется в Discover, а сюда начинают приходить подписки из <code style={{ color: "var(--fg-2)" }}>follows</code>.
          </p>
          <button className="link-action" onClick={() => setTab("terminal")}>
            Перейти в Терминал <ChevronRight style={{ width: "16px", height: "16px" }} />
          </button>
        </div>
      </div>
    );
  }

  if (!leaderId) {
    return (
      <div className="terminal-layout terminal-stack">
        <div className="empty-state">
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "var(--warn-faint)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Radio style={{ width: "24px", height: "24px", color: "var(--warn)" }} />
          </div>
          <p style={{ fontSize: "var(--fs-body)", color: "var(--fg-2)", marginBottom: "4px" }}>Переключатель включён, лидера в базе нет</p>
          <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "16px", maxWidth: "400px" }}>
            Не удалось зарегистрировать лидера: бэкенд недоступен{lighterAccountIndex == null ? ", либо по этому адресу нет аккаунта Lighter" : ""}.
          </p>
          <button className="link-action" onClick={() => setTab("terminal")}>
            Проверить в Терминале <ChevronRight style={{ width: "16px", height: "16px" }} />
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
    <div className="terminal-layout terminal-stack" style={{ gap: "12px" }}>
      <div className="terminal-main">
        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: avatarColor(leader?.handle ?? ""), display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--on-accent)" }}>
                {shortHandle(leader?.handle ?? "?")}
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--fg)" }}>{leader?.handle ?? "загрузка…"}</div>
                <div style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  Lighter #{leader?.lighterAccountIndex ?? lighterAccountIndex ?? "—"}
                  {leader && <> · в сети с {new Date(leader.since * 1000).toLocaleDateString("ru-RU")}</>}
                </div>
              </div>
            </div>
            {loadError && <span style={{ fontSize: "var(--fs-data)", color: "var(--warn)" }}>{loadError}</span>}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px", marginBottom: "12px" }}>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              <Users style={{ width: "12px", height: "12px" }} /> Активные подписки
            </div>
            <div style={{ fontSize: "var(--fs-figure)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--fg)" }}>{leader ? fmt(leader.followers) : "—"}</div>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", marginTop: "4px" }}>строки follows где paused = 0</div>
          </div>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              <DollarSign style={{ width: "12px", height: "12px" }} /> AUM в копиях
            </div>
            <div style={{ fontSize: "var(--fs-figure)", fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--fg)" }}>{leader ? usd(aum, 0) : "—"}</div>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", marginTop: "4px" }}>сумма allocation_usd</div>
          </div>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              {pnl != null && pnl >= 0 ? <TrendingUp style={{ width: "12px", height: "12px" }} /> : <TrendingDown style={{ width: "12px", height: "12px" }} />} Реализованный PnL
            </div>
            <div style={{ fontSize: "var(--fs-figure)", fontFamily: "var(--font-mono)", fontWeight: 600, color: pnl == null ? "var(--fg-3)" : pnl >= 0 ? "var(--up)" : "var(--down)" }}>
              {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
            </div>
            <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", marginTop: "4px" }}>{pnl == null ? "Lighter не ответил" : "публичный GET /account?by=index"}</div>
          </div>
        </div>

        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
            <label htmlFor="leader-fee" className="label" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Percent style={{ width: "12px", height: "12px" }} /> Комиссия за скопированную сделку
            </label>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg)", fontSize: "var(--fs-ui)" }}>{(feeDraft / 100).toFixed(2)}%</span>
          </div>
          <input
            id="leader-fee"
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
            style={{ width: "100%", accentColor: "var(--info)", margin: "8px 0" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={() => void saveFee()}
              disabled={feeSaving || !leader || feeDraft === leader.feeBps}
              className="btn-primary"
            >
              {feeSaving ? "Записываю…" : feeDraft === leader?.feeBps ? "Сохранено" : "Сохранить в leaders.fee_bps"}
            </button>
            {feeError && <span style={{ fontSize: "var(--fs-data)", color: "var(--down)" }}>{feeError}</span>}
          </div>
          <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", marginTop: "8px" }}>
            Сейчас в базе: {(feeBps / 100).toFixed(2)}% — это значение видят подписчики в Discover.
          </div>
        </div>

        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>Сколько это может быть в месяц</div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <label htmlFor="leader-turns" style={{ fontSize: "var(--fs-ui)", color: "var(--fg-2)" }}>
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
              className="input-mono"
              style={{ width: "100px" }}
            />
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-ui)", color: "var(--fg-2)", marginBottom: "8px" }}>
            {usd(aum, 0)} × {feeBps} bps × {turnsPerMonth} = <span style={{ color: "var(--warn)" }}>{usd(projected, 2)}</span>
          </div>
          <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", margin: 0 }}>
            Арифметика по твоему допущению об обороте, а не начисление: в репозитории нет кода, который удерживает fee_bps со сделок подписчика.
            Комиссия сейчас — объявленное условие в таблице <code style={{ color: "var(--fg-2)" }}>leaders</code>, которое видно в Discover, но которое пока
            не списывается. Сбор появится вместе с расчётным контуром поверх <code style={{ color: "var(--fg-2)" }}>mirror_log</code>.
          </p>
        </div>

        <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "12px" }}>Подписчики</div>
          {!follows ? (
            <p style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Читаю follows…</p>
          ) : follows.length === 0 ? (
            <p style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>
              На тебя пока никто не подписан. Карточка появляется в Discover сразу после регистрации лидера — подписчик выбирает аллокацию и плечо,
              они попадают в <code style={{ color: "var(--fg-2)" }}>follows</code>.
            </p>
          ) : (
            <div className="table-scroll">
            <table style={{ width: "100%", fontSize: "var(--fs-ui)", minWidth: "500px" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "var(--fs-label)", color: "var(--text-muted)", borderBottom: "1px solid var(--line)" }}>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Подписчик</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Аллокация</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Плечо</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Зеркалировано</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>С</th>
                </tr>
              </thead>
              <tbody>
                {follows.map((f) => (
                  <tr key={f.id} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)", fontSize: "var(--fs-data)" }} title={f.follower_id}>
                      {f.follower_id.slice(0, 8)}…
                    </td>
                    <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg)" }}>{usd(f.allocation_usd, 0)}</td>
                    <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{f.max_leverage}x</td>
                    <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{fmt(f.current_mirrored_size, 4)}</td>
                    <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: "var(--fs-label)" }}>{new Date(f.created_at * 1000).toLocaleDateString("ru-RU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--fs-label)", color: "var(--text-muted)", marginTop: "12px" }}>
            <Wallet style={{ width: "12px", height: "12px" }} /> Идентификатор подписчика — внутренний id из таблицы followers; адреса кошельков здесь не показываются.
          </div>
        </div>

        <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)" }}>
          Чтобы сделки действительно копировались, на сервере запущен <code style={{ color: "var(--fg-2)" }}>backend/leader_listener.py</code>: он слушает
          позиции лидера, считает <code style={{ color: "var(--fg-2)" }}>mirror_engine.compute_mirror_plan()</code> по каждой активной подписке и пишет итог
          в <code style={{ color: "var(--fg-2)" }}>mirror_log</code>. Пока <code style={{ color: "var(--fg-2)" }}>WAKE_DRY_RUN=true</code> (значение по умолчанию),
          статус строки — <code style={{ color: "var(--fg-2)" }}>dry_run</code>, ордер на Lighter не уходит.
        </p>
      </div>
    </div>
  );
}
