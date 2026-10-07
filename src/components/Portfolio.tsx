import { useState, useEffect } from "react";
import { ChevronRight, Pause, Play, Wallet, X } from "lucide-react";
import { getAccountByIndex, getMirrorLog, type LighterAccount, type MirrorLogRow, type OrderBook } from "../lib/lighter";
import { errorText } from "../lib/backend";
import type { Following } from "./types";
import { avatarColor, shortHandle, fmt, usd } from "./utils";

type Tab = "terminal" | "discover" | "portfolio" | "earn" | "predict" | "agent" | "risk" | "funding";

interface PortfolioProps {
  following: Following[];
  setTab: (tab: Tab) => void;
  togglePause: (followId: string) => void;
  unfollow: (followId: string) => void;
  followerId: string | null;
  lighterAccountIndex: number | null;
  hasWallet: boolean;
  markets: OrderBook[];
}

const STATUS_STYLE: Record<MirrorLogRow["status"], { bg: string; color: string; border?: string }> = {
  planned: { bg: "#1a1a1a", color: "#a0a0a0" },
  skipped: { bg: "#2a2000", color: "#fbbf24", border: "#3d3000" },
  dry_run: { bg: "#0a1a2a", color: "#3b82f6", border: "#1a3050" },
  sent: { bg: "#0a2a1a", color: "#10b981", border: "#1a3d2a" },
  failed: { bg: "#2a0a0a", color: "#ef4444", border: "#3d1a1a" },
};

export default function Portfolio({ following, setTab, togglePause, unfollow, followerId, lighterAccountIndex, hasWallet, markets }: PortfolioProps) {
  const [account, setAccount] = useState<LighterAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mirrorLog, setMirrorLog] = useState<MirrorLogRow[] | null>(null);
  const [mirrorLogError, setMirrorLogError] = useState<string | null>(null);

  useEffect(() => {
    if (lighterAccountIndex == null) {
      setAccount(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const data = await getAccountByIndex(lighterAccountIndex!);
        if (!cancelled) {
          setAccount(data);
          setAccountError(null);
        }
      } catch (e) {
        if (!cancelled) setAccountError(errorText(e));
      }
    }
    void load();
    const id = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [lighterAccountIndex]);

  useEffect(() => {
    if (!followerId) {
      setMirrorLog(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const rows = await getMirrorLog(followerId!, 50);
        if (!cancelled) {
          setMirrorLog(rows);
          setMirrorLogError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setMirrorLog([]);
          setMirrorLogError(errorText(e));
        }
      }
    }
    void load();
    const id = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [followerId, following.length]);

  const openPositions = account?.positions.filter((p) => Math.abs(p.size) > 0) ?? [];
  const unrealized = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);

  function symbolOf(marketId: number) {
    return markets.find((m) => m.market_id === marketId)?.symbol ?? `#${marketId}`;
  }

  function decimalsOf(marketId: number) {
    return markets.find((m) => m.market_id === marketId)?.supported_price_decimals ?? 2;
  }

  return (
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto", gap: "16px" }}>
      <section>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Мои подписки</h2>
          <span style={{ fontSize: "11px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>таблица follows</span>
        </div>
        {following.length === 0 ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "40px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <p style={{ fontSize: "14px", color: "#a0a0a0", marginBottom: "4px" }}>
              {followerId ? "Ты пока никого не копируешь" : "Войди через Telegram или кошелёк — подписки привязаны к follower_id"}
            </p>
            <p style={{ fontSize: "12px", color: "#666", marginBottom: "16px", maxWidth: "400px" }}>
              Подписка — это строка в <code style={{ color: "#a0a0a0" }}>follows</code> с аллокацией и потолком плеча. Её читает копи-движок из{" "}
              <code style={{ color: "#a0a0a0" }}>mirror_engine.py</code>.
            </p>
            <button onClick={() => setTab("discover")} style={{ color: "#3b82f6", fontSize: "14px", fontWeight: 500, display: "flex", alignItems: "center", gap: "4px", background: "none", border: "none", cursor: "pointer" }}>
              Найти трейдера <ChevronRight style={{ width: "16px", height: "16px" }} />
            </button>
          </div>
        ) : (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px", overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: "13px" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Лидер</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Аллокация</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Плечо</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Зеркальный размер</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Статус</th>
                  <th style={{ paddingBottom: "8px", fontWeight: 400 }}></th>
                </tr>
              </thead>
              <tbody>
                {following.map((t) => (
                  <tr key={t.followId} style={{ borderBottom: "1px solid #1e1e1e" }}>
                    <td style={{ padding: "12px 0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: avatarColor(t.handle), display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", fontWeight: 600, color: "#fff" }}>
                          {shortHandle(t.handle)}
                        </div>
                        <span style={{ color: "#fafafa", fontWeight: 500 }}>{t.handle}</span>
                      </div>
                    </td>
                    <td style={{ padding: "12px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{usd(t.allocationUsd)}</td>
                    <td style={{ padding: "12px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{t.maxLeverage}x</td>
                    <td style={{ padding: "12px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(t.mirroredSize, 4)}</td>
                    <td style={{ padding: "12px 0" }}>
                      <button
                        onClick={() => togglePause(t.followId)}
                        style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", padding: "8px 10px", borderRadius: "4px", border: "none", cursor: "pointer", background: t.paused ? "#1a1a1a" : "#0a2a1a", color: t.paused ? "#666" : "#10b981", minHeight: "36px" }}
                      >
                        {t.paused ? <Play style={{ width: "12px", height: "12px" }} /> : <Pause style={{ width: "12px", height: "12px" }} />}
                        {t.paused ? "На паузе" : "Копирует"}
                      </button>
                    </td>
                    <td style={{ padding: "12px 0", textAlign: "right" }}>
                      <button
                        onClick={() => {
                          if (window.confirm("Удалить подписку? Это действие нельзя отменить.")) {
                            unfollow(t.followId);
                          }
                        }}
                        style={{ color: "#666", background: "none", border: "none", cursor: "pointer", padding: "14px", display: "flex", alignItems: "center", justifyContent: "center" }}
                        title="Удалить подписку из follows"
                        aria-label="Удалить подписку"
                      >
                        <X style={{ width: "16px", height: "16px" }} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Счёт на Lighter</h2>
          <span style={{ fontSize: "11px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>GET /api/v1/account?by=index</span>
        </div>
        {!hasWallet ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "32px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
              <Wallet style={{ width: "20px", height: "20px", color: "#666" }} />
            </div>
            <p style={{ fontSize: "14px", color: "#a0a0a0", margin: 0 }}>Кошелёк не подключён — позиции по адресу не видны</p>
            <p style={{ fontSize: "12px", color: "#666", marginTop: "4px", maxWidth: "400px" }}>
              Вход через Telegram даёт подписки и журнал, но сам счёт на Lighter привязан к адресу. Подключи кошелёк в шапке.
            </p>
          </div>
        ) : lighterAccountIndex == null ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "32px 20px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <p style={{ fontSize: "14px", color: "#a0a0a0", margin: 0 }}>Аккаунт на Lighter не найден</p>
            <p style={{ fontSize: "12px", color: "#666", marginTop: "4px", maxWidth: "400px" }}>
              Регистрация — на app.lighter.xyz. Wake читает только публичные данные счёта и никогда не просит приватный ключ.
            </p>
          </div>
        ) : accountError ? (
          <div style={{ background: "#1a1500", border: "1px solid #3d3000", borderRadius: "6px", padding: "12px 16px", fontSize: "13px", color: "#fbbf24" }}>
            Lighter не ответил: <span style={{ fontFamily: "JetBrains Mono, monospace", fontSize: "12px" }}>{accountError}</span>
          </div>
        ) : account ? (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px", marginBottom: "16px" }}>
              <div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Капитал</div>
                <div style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", color: "#fafafa" }}>{usd(account.equityUsd, 2)}</div>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Нереализованный PnL</div>
                <div style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", color: unrealized >= 0 ? "#10b981" : "#ef4444" }}>
                  {unrealized >= 0 ? "+" : ""}
                  {usd(unrealized, 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Реализованный PnL</div>
                <div style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", color: account.realizedPnlUsd >= 0 ? "#10b981" : "#ef4444" }}>
                  {account.realizedPnlUsd >= 0 ? "+" : ""}
                  {usd(account.realizedPnlUsd, 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "12px", color: "#666", marginBottom: "4px" }}>Открытых позиций</div>
                <div style={{ fontSize: "18px", fontFamily: "JetBrains Mono, monospace", color: "#fafafa" }}>{fmt(openPositions.length)}</div>
              </div>
            </div>

            {openPositions.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#666", margin: 0 }}>Открытых позиций нет — lighter возвращает строку на каждый рынок, который счёт когда-либо трогал.</p>
            ) : (
              <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", fontSize: "13px", minWidth: "600px" }}>
                <thead>
                  <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Рынок</th>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Размер</th>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Средняя входа</th>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Номинал</th>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>PnL</th>
                    <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Ликв.</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p) => (
                    <tr key={p.marketId} style={{ borderBottom: "1px solid #1e1e1e" }}>
                      <td style={{ padding: "10px 0" }}>
                        <span style={{ color: "#fafafa", fontWeight: 500 }}>{p.symbol}</span>
                        <span style={{ marginLeft: "8px", fontSize: "11px", color: p.size >= 0 ? "#10b981" : "#ef4444" }}>{p.size >= 0 ? "LONG" : "SHORT"}</span>
                      </td>
                      <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(p.size, 4)}</td>
                      <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(p.avgEntry, decimalsOf(p.marketId))}</td>
                      <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{usd(Math.abs(p.value), 0)}</td>
                      <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: p.unrealizedPnl >= 0 ? "#10b981" : "#ef4444" }}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}
                        {usd(p.unrealizedPnl, 2)}
                      </td>
                      <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#666" }}>{p.liquidationPrice > 0 ? `$${fmt(p.liquidationPrice, decimalsOf(p.marketId))}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        ) : (
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "24px", fontSize: "13px", color: "#666" }}>Загружаю счёт…</div>
        )}
      </section>

      {followerId && (
        <section>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Журнал копи-движка</h2>
            <span style={{ fontSize: "11px", color: "#666", fontFamily: "JetBrains Mono, monospace" }}>таблица mirror_log</span>
          </div>
          <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", padding: "16px" }}>
            {mirrorLog === null ? (
              <p style={{ fontSize: "13px", color: "#666", margin: 0 }}>Читаю журнал…</p>
            ) : mirrorLogError ? (
              <p style={{ fontSize: "13px", color: "#ef4444", margin: 0 }}>
                Не удалось загрузить журнал: {mirrorLogError}
              </p>
            ) : mirrorLog.length === 0 ? (
              <p style={{ fontSize: "13px", color: "#666", lineHeight: 1.6, margin: 0 }}>
                Пусто. Строки появляются, когда <code style={{ color: "#a0a0a0" }}>leader_listener.py</code> видит изменение позиции лидера по одной из
                твоих подписок. С <code style={{ color: "#a0a0a0" }}>WAKE_DRY_RUN=true</code> (значение по умолчанию) исход пишется как{" "}
                <code style={{ color: "#a0a0a0" }}>dry_run</code>, ордер на Lighter не уходит. Проверить расчёт без листенера можно запросом{" "}
                <code style={{ color: "#a0a0a0" }}>POST /simulate-mirror</code>.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Время</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Лидер</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Рынок</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Сторона</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Размер</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Исход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mirrorLog.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid #1e1e1e" }}>
                        <td style={{ padding: "10px 0", color: "#666", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", whiteSpace: "nowrap" }}>{new Date(r.created_at * 1000).toLocaleString("ru-RU")}</td>
                        <td style={{ padding: "10px 0", color: "#a0a0a0" }}>{r.leader_handle}</td>
                        <td style={{ padding: "10px 0", color: "#fafafa" }}>
                          {symbolOf(r.market_id)}
                          {r.reduce_only === 1 && <span style={{ marginLeft: "6px", fontSize: "11px", color: "#666" }}>закрытие</span>}
                        </td>
                        <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", fontSize: "12px", color: r.side === "long" ? "#10b981" : "#ef4444" }}>{r.side.toUpperCase()}</td>
                        <td style={{ padding: "10px 0", fontFamily: "JetBrains Mono, monospace", color: "#a0a0a0" }}>{fmt(r.base_amount, 4)}</td>
                        <td style={{ padding: "10px 0" }}>
                          <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "3px", fontFamily: "JetBrains Mono, monospace", background: STATUS_STYLE[r.status].bg, color: STATUS_STYLE[r.status].color, border: STATUS_STYLE[r.status].border ? `1px solid ${STATUS_STYLE[r.status].border}` : "none" }}>{r.status}</span>
                          {r.reason && <span style={{ marginLeft: "8px", fontSize: "12px", color: "#666" }}>{r.reason}</span>}
                          {r.tx_hash && (
                            <span style={{ marginLeft: "8px", fontSize: "12px", color: "#666", fontFamily: "JetBrains Mono, monospace" }} title={r.tx_hash}>
                              {r.tx_hash.slice(0, 10)}…
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
