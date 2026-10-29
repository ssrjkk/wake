import { useState, useEffect } from "react";
import { Users, DollarSign, Copy as CopyIcon, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { listHydratedLeaders } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { leaderFromHydrated } from "../lib/leaders";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { fmt, shortHandle, usd, avatarColor } from "./utils";
import type { Leader } from "./types";

interface DiscoverProps {
  setCopyModal: (leader: Leader | null) => void;
}

export default function Discover({ setCopyModal }: DiscoverProps) {
  const [leaders, setLeaders] = useState<Leader[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    // Витрина собирается на сервере (GET /leaders/hydrated): каптал и PnL —
    // публичный ответ Lighter на строку, и поштучная сборка на фронте стоила по
    // два запроса на карточку. Поэтому вкладка не работает без бэкенда: список
    // лидеров взять неоткуда.
    async function load() {
      try {
        const rows = await listHydratedLeaders();
        const built = rows.map(leaderFromHydrated);
        const rank = (t: Leader) => (t.exchange ? t.exchange.realizedPnlUsd : -1e12);
        setLeaders(built.sort((a, b) => rank(b) - rank(a) || b.aumUsd - a.aumUsd));
        setError(null);
        setLastUpdated(new Date());
      } catch (e) {
        // Один сбой опроса не имеет права стирать уже показанный список:
        // витрина перечитывается каждые 20 секунд, и одна 500-ка Lighter
        // обнуляла бы весь экран, оставив человека без единственного ответа на
        // вопрос «кого копируют». lastUpdated при этом НЕ двигается: строка
        // «обновлено» в шапке и есть подпись о том, насколько цифры устарели.
        setError(errorText(e));
      }
    }
    void load();
    const stop = setIntervalWhenVisible(load, 20000);
    return () => stop();
  }, []);

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
            <h2 style={{ fontSize: "var(--fs-heading)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Кого копируют</h2>
            {lastUpdated && (
              <span
                style={{ marginLeft: "auto", fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}
                title="Список лидеров и ответ Lighter обновляются раз в 20 секунд"
              >
                обновлено {lastUpdated.toLocaleTimeString("ru-RU", { hour12: false })}
              </span>
            )}
          </div>
          <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Лидеры — из таблицы leaders, подписчики и AUM — из follows. Капитал, реализованный PnL и открытые позиции — публичный ответ Lighter GET /api/v1/account?by=index по аккаунту лидера.
            Порядок: по реализованному PnL, при равенстве — по AUM; у кого Lighter не ответил, тот в конце списка.
          </p>
        </div>

        {error && (
          <div className="notice notice-error">
            {leaders && leaders.length > 0 ? (
              <>
                Список не перечитался: {error}. Показаны данные{" "}
                <span className="num">
                  {lastUpdated ? `на ${lastUpdated.toLocaleTimeString("ru-RU", { hour12: false })}` : "без свежей отметки"}
                </span>
                .
              </>
            ) : (
              <>Список лидеров не загружен: {error}</>
            )}
          </div>
        )}

        {leaders === null ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="leader-card">
                <div style={{ height: "12px", background: "var(--bg-2)", borderRadius: "3px", width: "50%", marginBottom: "12px" }} />
                <div style={{ height: "24px", background: "var(--bg-2)", borderRadius: "3px" }} />
              </div>
            ))}
          </div>
        ) : leaders.length === 0 ? (
          /* Пустая витрина без ошибки — «лидеров правда нет»; с ошибкой выше уже
             всё сказано, и второй текст был бы противоречием. */
          error ? null : (
            <div className="empty-state">
              <Users style={{ width: "24px", height: "24px", color: "var(--text-muted)", marginBottom: "12px" }} />
              <p style={{ fontSize: "var(--fs-data)", color: "var(--fg-2)", margin: "0 0 4px 0" }}>В базе пока нет ни одного лидера</p>
              <p style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", margin: 0, maxWidth: "500px", marginLeft: "auto", marginRight: "auto" }}>
                Лидер появляется сам: в Терминале включи «Публиковать мои сделки».
              </p>
            </div>
          )
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" }}>
            {leaders.map((t) => {
              const pnl = t.exchange?.realizedPnlUsd ?? null;
              return (
                <div key={t.id} className="leader-card">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div
                        style={{ width: "40px", height: "40px", borderRadius: "50%", background: avatarColor(t.handle), display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--fs-body)", fontWeight: 700, color: "var(--on-accent)" }}
                      >
                        {shortHandle(t.handle)}
                      </div>
                      <div>
                        <div style={{ fontSize: "var(--fs-ui)", color: "var(--fg)", fontWeight: 600 }}>{t.handle}</div>
                        <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>Lighter #{t.lighterAccountIndex}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: "var(--fs-label)", color: "var(--fg-2)", padding: "3px 8px", background: "var(--bg-2)", borderRadius: "3px", border: "1px solid var(--line-strong)" }}>{(t.feeBps / 100).toFixed(2)}%</span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
                        <Wallet style={{ width: "10px", height: "10px" }} /> Капитал
                      </div>
                      <div style={{ fontSize: "var(--fs-data)", color: "var(--fg)", fontFamily: "var(--font-mono)" }}>{pnl === null ? "—" : usd(t.exchange!.equityUsd, 0)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
                        {pnl != null && pnl >= 0 ? <TrendingUp style={{ width: "10px", height: "10px" }} /> : <TrendingDown style={{ width: "10px", height: "10px" }} />} PnL
                      </div>
                      <div style={{ fontSize: "var(--fs-data)", color: pnl == null ? "var(--fg-3)" : pnl >= 0 ? "var(--up)" : "var(--down)", fontFamily: "var(--font-mono)" }}>
                        {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--fs-label)", fontFamily: "var(--font-mono)", marginBottom: "4px" }}>
                    <span style={{ color: "var(--fg-2)", display: "flex", alignItems: "center", gap: "4px" }}>
                      <Users style={{ width: "11px", height: "11px" }} />
                      {fmt(t.followers)}
                    </span>
                    <span style={{ color: "var(--fg-2)", display: "flex", alignItems: "center", gap: "4px" }}>
                      <DollarSign style={{ width: "11px", height: "11px" }} />
                      {fmt(t.aumUsd)}
                    </span>
                  </div>
                  <div style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", marginBottom: "16px" }}>
                    {t.exchange ? `${t.exchange.openPositions.length} позиций` : "Lighter не ответил"} · с {new Date(t.since * 1000).toLocaleDateString("ru-RU")}
                  </div>
                  <button
                    onClick={() => setCopyModal(t)}
                    className="btn-primary"
                    style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}
                  >
                    <CopyIcon style={{ width: "12px", height: "12px" }} /> Copy
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
