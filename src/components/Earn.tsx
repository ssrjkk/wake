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

export default function Earn({ isCopyable, setTab, leaderId, leaderFeeBps, setLeaderFeeBps, lighterAccountIndex }: EarnProps) {
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
        const subs = await listFollowsForLeader(leaderId!);
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
    void load();
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
      <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
        <div className="terminal-main" style={{ padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Radio style={{ width: "24px", height: "24px", color: "#666" }} />
          </div>
          <p style={{ fontSize: "14px", color: "#a0a0a0", marginBottom: "4px" }}>Публикация выключена</p>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "16px", maxWidth: "400px" }}>
            «Публиковать мои сделки» в Терминале записывают твой аккаунт Lighter в таблицу <code style={{ color: "#a0a0a0" }}>leaders</code> — после этого
            карточка появляется в Discover, а сюда начинают приходить подписки из <code style={{ color: "#a0a0a0" }}>follows</code>.
          </p>
          <button onClick={() => setTab("terminal")} style={{ color: "#3b82f6", fontSize: "14px", fontWeight: 500, display: "flex", alignItems: "center", gap: "4px", background: "none", border: "none", cursor: "pointer" }}>
            Перейти в Терминал <ChevronRight style={{ width: "16px", height: "16px" }} />
          </button>
        </div>
      </div>
    );
  }

  if (!leaderId) {
    return (
      <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
        <div className="terminal-main" style={{ padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ width: "48px", height: "48px", borderRadius: "50%", background: "#2a2000", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
            <Radio style={{ width: "24px", height: "24px", color: "#fbbf24" }} />
          </div>
          <p style={{ fontSize: "14px", color: "#a0a0a0", marginBottom: "4px" }}>Переключатель включён, лидера в базе нет</p>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "16px", maxWidth: "400px" }}>
            Не удалось зарегистрировать лидера: бэкенд недоступен{lighterAccountIndex == null ? ", либо по этому адресу нет аккаунта Lighter" : ""}.
          </p>
          <button onClick={() => setTab("terminal")} style={{ color: "#3b82f6", fontSize: "14px", fontWeight: 500, display: "flex", alignItems: "center", gap: "4px", background: "none", border: "none", cursor: "pointer" }}>
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
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto", gap: "12px" }}>
      <div className="terminal-main">
        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <div style={{ width: "44px", height: "44px", borderRadius: "50%", background: avatarColor(leader?.handle ?? ""), display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 600, color: "#fff" }}>
                {shortHandle(leader?.handle ?? "?")}
              </div>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "#fafafa" }}>{leader?.handle ?? "загрузка…"}</div>
                <div style={{ fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>
                  Lighter #{leader?.lighterAccountIndex ?? lighterAccountIndex ?? "—"}
                  {leader && <> · в сети с {new Date(leader.since * 1000).toLocaleDateString("ru-RU")}</>}
                </div>
              </div>
            </div>
            {loadError && <span style={{ fontSize: "12px", color: "#fbbf24" }}>{loadError}</span>}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px", marginBottom: "12px" }}>
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              <Users style={{ width: "12px", height: "12px" }} /> Активные подписки
            </div>
            <div style={{ fontSize: "24px", fontFamily: "JetBrains Mono, monospace", fontWeight: 600, color: "#fafafa" }}>{leader ? fmt(leader.followers) : "—"}</div>
            <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>строки follows где paused = 0</div>
          </div>
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              <DollarSign style={{ width: "12px", height: "12px" }} /> AUM в копиях
            </div>
            <div style={{ fontSize: "24px", fontFamily: "JetBrains Mono, monospace", fontWeight: 600, color: "#fafafa" }}>{leader ? usd(aum, 0) : "—"}</div>
            <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>сумма allocation_usd</div>
          </div>
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
              {pnl != null && pnl >= 0 ? <TrendingUp style={{ width: "12px", height: "12px" }} /> : <TrendingDown style={{ width: "12px", height: "12px" }} />} Реализованный PnL
            </div>
            <div style={{ fontSize: "24px", fontFamily: "JetBrains Mono, monospace", fontWeight: 600, color: pnl == null ? "#666" : pnl >= 0 ? "#10b981" : "#ef4444" }}>
              {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
            </div>
            <div style={{ fontSize: "11px", color: "#666", marginTop: "4px" }}>{pnl == null ? "Lighter не ответил" : "публичный GET /account?by=index"}</div>
          </div>
        </div>

        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
            <span style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: "6px" }}>
              <Percent style={{ width: "12px", height: "12px" }} /> Комиссия за скопированную сделку
            </span>
            <span style={{ fontFamily: "JetBrains Mono, monospace", color: "#fafafa", fontSize: "13px" }}>{(feeDraft / 100).toFixed(2)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={50}
            step={1}
            value={feeDraft}
            onChange={(e) => setFeeDraft(Number(e.target.value))}
            style={{ width: "100%", accentColor: "#3b82f6", margin: "8px 0" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <button
              onClick={() => void saveFee()}
              disabled={feeSaving || !leader || feeDraft === leader.feeBps}
              style={{ background: feeSaving || !leader || feeDraft === leader.feeBps ? "#333" : "#3b82f6", color: "#fff", fontSize: "12px", fontWeight: 600, padding: "8px 12px", borderRadius: "4px", border: "none", cursor: feeSaving || !leader || feeDraft === leader.feeBps ? "not-allowed" : "pointer", minHeight: "44px" }}
            >
              {feeSaving ? "Записываю…" : feeDraft === leader?.feeBps ? "Сохранено" : "Сохранить в leaders.fee_bps"}
            </button>
            {feeError && <span style={{ fontSize: "12px", color: "#ef4444" }}>{feeError}</span>}
          </div>
          <div style={{ fontSize: "11px", color: "#666", marginTop: "8px" }}>
            Сейчас в базе: {(feeBps / 100).toFixed(2)}% — это значение видят подписчики в Discover.
          </div>
        </div>

        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px" }}>Сколько это может быть в месяц</div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
            <span style={{ fontSize: "13px", color: "#a0a0a0" }}>Оборотов на подписчика в месяц</span>
            <input
              type="number"
              min={0}
              max={200}
              value={turnsPerMonth}
              onChange={(e) => setTurnsPerMonth(Math.max(0, Number(e.target.value)))}
              style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "8px", width: "100px", color: "#fafafa", fontSize: "13px", fontFamily: "JetBrains Mono, monospace", outline: "none" }}
            />
          </div>
          <div style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "13px", color: "#a0a0a0", marginBottom: "8px" }}>
            {usd(aum, 0)} × {feeBps} bps × {turnsPerMonth} = <span style={{ color: "#fbbf24" }}>{usd(projected, 2)}</span>
          </div>
          <p style={{ fontSize: "12px", color: "#666", margin: 0 }}>
            Арифметика по твоему допущению об обороте, а не начисление: в репозитории нет кода, который удерживает fee_bps со сделок подписчика.
            Комиссия сейчас — объявленное условие в таблице <code style={{ color: "#a0a0a0" }}>leaders</code>, которое видно в Discover, но которое пока
            не списывается. Сбор появится вместе с расчётным контуром поверх <code style={{ color: "#a0a0a0" }}>mirror_log</code>.
          </p>
        </div>

        <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: "#666", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "12px" }}>Подписчики</div>
          {!follows ? (
            <p style={{ fontSize: "13px", color: "#666" }}>Читаю follows…</p>
          ) : follows.length === 0 ? (
            <p style={{ fontSize: "13px", color: "#666" }}>
              На тебя пока никто не подписан. Карточка появляется в Discover сразу после регистрации лидера — подписчик выбирает аллокацию и плечо,
              они попадают в <code style={{ color: "#a0a0a0" }}>follows</code>.
            </p>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <table style={{ width: "100%", fontSize: "13px", minWidth: "500px" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Подписчик</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Аллокация</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Плечо</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Зеркалировано</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>С</th>
                </tr>
              </thead>
              <tbody>
                {follows.map((f) => (
                  <tr key={f.id} style={{ borderBottom: "1px solid #1e1e1e" }}>
                    <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0", fontSize: "12px" }} title={f.follower_id}>
                      {f.follower_id.slice(0, 8)}…
                    </td>
                    <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#fafafa" }}>{usd(f.allocation_usd, 0)}</td>
                    <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{f.max_leverage}x</td>
                    <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(f.current_mirrored_size, 4)}</td>
                    <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#666", fontSize: "11px" }}>{new Date(f.created_at * 1000).toLocaleDateString("ru-RU")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#666", marginTop: "12px" }}>
            <Wallet style={{ width: "12px", height: "12px" }} /> Идентификатор подписчика — внутренний id из таблицы followers; адреса кошельков здесь не показываются.
          </div>
        </div>

        <p style={{ fontSize: "12px", color: "#666" }}>
          Чтобы сделки действительно копировались, на сервере запущен <code style={{ color: "#a0a0a0" }}>backend/leader_listener.py</code>: он слушает
          позиции лидера, считает <code style={{ color: "#a0a0a0" }}>mirror_engine.compute_mirror_plan()</code> по каждой активной подписке и пишет итог
          в <code style={{ color: "#a0a0a0" }}>mirror_log</code>. Пока <code style={{ color: "#a0a0a0" }}>WAKE_DRY_RUN=true</code> (значение по умолчанию),
          статус строки — <code style={{ color: "#a0a0a0" }}>dry_run</code>, ордер на Lighter не уходит.
        </p>
      </div>
    </div>
  );
}
