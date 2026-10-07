import { useState, useEffect } from "react";
import { Users, DollarSign, Copy as CopyIcon, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { listLeaders } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { buildLeader } from "../lib/leaders";
import { fmt, shortHandle, usd } from "./utils";
import type { Leader } from "./types";

interface DiscoverProps {
  setCopyModal: (leader: Leader | null) => void;
}

export default function Discover({ setCopyModal }: DiscoverProps) {
  const [leaders, setLeaders] = useState<Leader[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const rows = await listLeaders();
        const built = await Promise.all(rows.map(buildLeader));
        const rank = (t: Leader) => (t.exchange ? t.exchange.realizedPnlUsd : -1e12);
        setLeaders(built.sort((a, b) => rank(b) - rank(a) || b.aumUsd - b.aumUsd));
        setError(null);
      } catch (e) {
        setError(errorText(e));
        setLeaders([]);
      }
    }
    void load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Кого копируют</h2>
          <p style={{ fontSize: "12px", color: "#666", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Лидеры — из таблицы leaders, подписчики и AUM — из follows. Капитал, реализованный PnL и открытые позиции — публичный ответ Lighter GET /api/v1/account?by=index по аккаунту лидера.
          </p>
        </div>

        {leaders === null ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
                <div style={{ height: "12px", background: "#1a1a1a", borderRadius: "3px", width: "50%", marginBottom: "12px" }} />
                <div style={{ height: "24px", background: "#1a1a1a", borderRadius: "3px" }} />
              </div>
            ))}
          </div>
        ) : leaders.length === 0 ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "48px 24px", textAlign: "center" }}>
            <Users style={{ width: "24px", height: "24px", color: "#666", marginBottom: "12px" }} />
            <p style={{ fontSize: "12px", color: "#ccc", margin: "0 0 4px 0" }}>В базе пока нет ни одного лидера</p>
            <p style={{ fontSize: "10px", color: "#666", margin: 0, maxWidth: "500px", marginLeft: "auto", marginRight: "auto" }}>
              Лидер появляется сам: в Терминале включи «Публиковать мои сделки».
              {error && <span style={{ color: "#fbbf24", marginTop: "8px", display: "block" }}>Бэкенд ответил: {error}</span>}
            </p>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "8px" }}>
            {leaders.map((t) => {
              const pnl = t.exchange?.realizedPnlUsd ?? null;
              return (
                <div key={t.id} style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", transition: "border-color 0.15s" }}
                  onMouseEnter={(e) => e.currentTarget.style.borderColor = "#333"}
                  onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1e1e1e"}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div
                        style={{ width: "40px", height: "40px", borderRadius: "50%", background: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color: "#fff" }}
                      >
                        {shortHandle(t.handle)}
                      </div>
                      <div>
                        <div style={{ fontSize: "13px", color: "#fafafa", fontWeight: 600 }}>{t.handle}</div>
                        <div style={{ fontSize: "10px", color: "#666", fontFamily: "'JetBrains Mono', monospace" }}>Lighter #{t.lighterAccountIndex}</div>
                      </div>
                    </div>
                    <span style={{ fontSize: "10px", color: "#ccc", padding: "3px 8px", background: "#1a1a1a", borderRadius: "3px", border: "1px solid #2a2a2a" }}>{(t.feeBps / 100).toFixed(2)}%</span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
                    <div>
                      <div style={{ fontSize: "10px", color: "#666", display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
                        <Wallet style={{ width: "10px", height: "10px" }} /> Капитал
                      </div>
                      <div style={{ fontSize: "12px", color: "#fafafa", fontFamily: "'JetBrains Mono', monospace" }}>{pnl === null ? "—" : usd(t.exchange!.equityUsd, 0)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: "10px", color: "#666", display: "flex", alignItems: "center", gap: "4px", marginBottom: "4px" }}>
                        {pnl != null && pnl >= 0 ? <TrendingUp style={{ width: "10px", height: "10px" }} /> : <TrendingDown style={{ width: "10px", height: "10px" }} />} PnL
                      </div>
                      <div style={{ fontSize: "12px", color: pnl == null ? "#666" : pnl >= 0 ? "#10b981" : "#ef4444", fontFamily: "'JetBrains Mono', monospace" }}>
                        {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", fontFamily: "'JetBrains Mono', monospace", marginBottom: "4px" }}>
                    <span style={{ color: "#ccc", display: "flex", alignItems: "center", gap: "4px" }}>
                      <Users style={{ width: "11px", height: "11px" }} />
                      {fmt(t.followers)}
                    </span>
                    <span style={{ color: "#ccc", display: "flex", alignItems: "center", gap: "4px" }}>
                      <DollarSign style={{ width: "11px", height: "11px" }} />
                      {fmt(t.aumUsd)}
                    </span>
                  </div>
                  <div style={{ fontSize: "10px", color: "#666", marginBottom: "16px" }}>
                    {t.exchange ? `${t.exchange.openPositions.length} позиций` : "Lighter не ответил"} · с {new Date(t.since * 1000).toLocaleDateString("ru-RU")}
                  </div>
                  <button
                    onClick={() => setCopyModal(t)}
                    style={{ width: "100%", background: "#3b82f6", color: "#fff", fontSize: "12px", fontWeight: 600, padding: "10px 0", border: "none", borderRadius: "4px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", minHeight: "44px" }}
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
