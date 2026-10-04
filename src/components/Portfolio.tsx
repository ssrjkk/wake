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

const STATUS_STYLE: Record<MirrorLogRow["status"], string> = {
  planned: "bg-surface-200 text-text-secondary",
  skipped: "bg-amber-950 text-amber-400 border border-amber-900",
  dry_run: "bg-sky-950 text-sky-400 border border-sky-900",
  sent: "bg-emerald-950 text-success border border-emerald-900",
  failed: "bg-red-950 text-danger border border-red-900",
};

export function Portfolio({ following, setTab, togglePause, unfollow, followerId, lighterAccountIndex, hasWallet, markets }: PortfolioProps) {
  const [account, setAccount] = useState<LighterAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mirrorLog, setMirrorLog] = useState<MirrorLogRow[] | null>(null);

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
        if (!cancelled) setMirrorLog(rows);
      } catch {
        // Бэкенд лежит — журнала просто нет, без красных экранов.
        if (!cancelled) setMirrorLog([]);
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
    <div className="space-y-5">
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-text-primary font-bold text-lg">Мои подписки</h2>
          <span className="text-xs text-text-tertiary font-mono">таблица follows</span>
        </div>
        {following.length === 0 ? (
          <div className="bg-surface-100 border border-border rounded-2xl py-14 flex flex-col items-center text-center px-6">
            <p className="text-text-secondary text-sm mb-1">
              {followerId ? "Ты пока никого не копируешь" : "Войди через Telegram или кошелёк — подписки привязаны к follower_id"}
            </p>
            <p className="text-text-muted text-xs mb-4 max-w-md">
              Подписка — это строка в <code className="text-text-tertiary">follows</code> с аллокацией и потолком плеча. Её читает копи-движок из{" "}
              <code className="text-text-tertiary">mirror_engine.py</code>.
            </p>
            <button onClick={() => setTab("discover")} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
              Найти трейдера <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="bg-surface-100 border border-border rounded-2xl p-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-tertiary border-b border-border">
                  <th className="pb-2 font-normal">Лидер</th>
                  <th className="pb-2 font-normal">Аллокация</th>
                  <th className="pb-2 font-normal">Плечо</th>
                  <th className="pb-2 font-normal">Зеркальный размер</th>
                  <th className="pb-2 font-normal">Статус</th>
                  <th className="pb-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {following.map((t) => (
                  <tr key={t.followId} className="border-b border-border last:border-0">
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className={`w-7 h-7 rounded-full ${avatarColor(t.handle)} flex items-center justify-center text-xs font-bold text-text-primary`}>
                          {shortHandle(t.handle)}
                        </div>
                        <span className="text-text-primary font-medium">{t.handle}</span>
                      </div>
                    </td>
                    <td className="py-3 font-mono text-text-secondary">{usd(t.allocationUsd)}</td>
                    <td className="py-3 font-mono text-text-secondary">{t.maxLeverage}x</td>
                    <td className="py-3 font-mono text-text-secondary">{fmt(t.mirroredSize, 4)}</td>
                    <td className="py-3">
                      <button
                        onClick={() => togglePause(t.followId)}
                        className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-colors ${
                          t.paused ? "bg-surface-200 text-text-tertiary hover:text-text-secondary" : "bg-emerald-950 text-success hover:text-emerald-300"
                        }`}
                      >
                        {t.paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        {t.paused ? "На паузе" : "Копирует"}
                      </button>
                    </td>
                    <td className="py-3 text-right">
                      <button
                        onClick={() => unfollow(t.followId)}
                        className="text-text-muted hover:text-danger transition-colors"
                        title="Удалить подписку из follows"
                      >
                        <X className="w-4 h-4" />
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
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-text-primary font-bold text-lg">Счёт на Lighter</h2>
          <span className="text-xs text-text-tertiary font-mono">GET /api/v1/account?by=index</span>
        </div>
        {!hasWallet ? (
          <div className="bg-surface-100 border border-border rounded-2xl py-10 flex flex-col items-center text-center px-6">
            <Wallet className="w-7 h-7 text-text-muted mb-3" />
            <p className="text-text-secondary text-sm">Кошелёк не подключён — позиции по адресу не видны</p>
            <p className="text-text-muted text-xs mt-1 max-w-md">
              Вход через Telegram даёт подписки и журнал, но сам счёт на Lighter привязан к адресу. Подключи кошелёк в шапке.
            </p>
          </div>
        ) : lighterAccountIndex == null ? (
          <div className="bg-surface-100 border border-border rounded-2xl py-10 flex flex-col items-center text-center px-6">
            <p className="text-text-secondary text-sm">Аккаунт на Lighter не найден</p>
            <p className="text-text-muted text-xs mt-1 max-w-md">
              Регистрация — на app.lighter.xyz. Wake читает только публичные данные счёта и никогда не просит приватный ключ.
            </p>
          </div>
        ) : accountError ? (
          <div className="bg-surface-100 border border-amber-900 rounded-2xl p-4 text-sm text-amber-300">
            Lighter не ответил: <span className="font-mono text-xs">{accountError}</span>
          </div>
        ) : account ? (
          <div className="bg-surface-100 border border-border rounded-2xl p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <div className="text-xs text-text-tertiary mb-1">Капитал</div>
                <div className="text-lg font-mono text-text-primary">{usd(account.equityUsd, 2)}</div>
              </div>
              <div>
                <div className="text-xs text-text-tertiary mb-1">Нереализованный PnL</div>
                <div className={`text-lg font-mono ${unrealized >= 0 ? "text-success" : "text-danger"}`}>
                  {unrealized >= 0 ? "+" : ""}
                  {usd(unrealized, 2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-text-tertiary mb-1">Реализованный PnL</div>
                <div className={`text-lg font-mono ${account.realizedPnlUsd >= 0 ? "text-success" : "text-danger"}`}>
                  {account.realizedPnlUsd >= 0 ? "+" : ""}
                  {usd(account.realizedPnlUsd, 2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-text-tertiary mb-1">Открытых позиций</div>
                <div className="text-lg font-mono text-text-primary">{fmt(openPositions.length)}</div>
              </div>
            </div>

            {openPositions.length === 0 ? (
              <p className="text-text-muted text-sm">Открытых позиций нет — lighter возвращает строку на каждый рынок, который счёт когда-либо трогал.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-text-tertiary border-b border-border">
                    <th className="pb-2 font-normal">Рынок</th>
                    <th className="pb-2 font-normal">Размер</th>
                    <th className="pb-2 font-normal">Средняя входа</th>
                    <th className="pb-2 font-normal">Номинал</th>
                    <th className="pb-2 font-normal">PnL</th>
                    <th className="pb-2 font-normal">Ликв.</th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p) => (
                    <tr key={p.marketId} className="border-b border-border last:border-0">
                      <td className="py-2.5">
                        <span className="text-text-primary font-medium">{p.symbol}</span>
                        <span className={`ml-2 text-xs ${p.size >= 0 ? "text-success" : "text-danger"}`}>{p.size >= 0 ? "LONG" : "SHORT"}</span>
                      </td>
                      <td className="py-2.5 font-mono text-text-secondary">{fmt(p.size, 4)}</td>
                      <td className="py-2.5 font-mono text-text-secondary">{fmt(p.avgEntry, decimalsOf(p.marketId))}</td>
                      <td className="py-2.5 font-mono text-text-secondary">{usd(Math.abs(p.value), 0)}</td>
                      <td className={`py-2.5 font-mono ${p.unrealizedPnl >= 0 ? "text-success" : "text-danger"}`}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}
                        {usd(p.unrealizedPnl, 2)}
                      </td>
                      <td className="py-2.5 font-mono text-text-tertiary">{p.liquidationPrice > 0 ? `$${fmt(p.liquidationPrice, decimalsOf(p.marketId))}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <div className="bg-surface-100 border border-border rounded-2xl p-6 text-sm text-text-tertiary">Загружаю счёт…</div>
        )}
      </section>

      {followerId && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-text-primary font-bold text-lg">Журнал копи-движка</h2>
            <span className="text-xs text-text-tertiary font-mono">таблица mirror_log</span>
          </div>
          <div className="bg-surface-100 border border-border rounded-2xl p-4">
            {mirrorLog === null ? (
              <p className="text-text-tertiary text-sm">Читаю журнал…</p>
            ) : mirrorLog.length === 0 ? (
              <p className="text-text-tertiary text-sm leading-relaxed">
                Пусто. Строки появляются, когда <code className="text-text-secondary">leader_listener.py</code> видит изменение позиции лидера по одной из
                твоих подписок. С <code className="text-text-secondary">WAKE_DRY_RUN=true</code> (значение по умолчанию) исход пишется как{" "}
                <code className="text-text-secondary">dry_run</code>, ордер на Lighter не уходит. Проверить расчёт без листенера можно запросом{" "}
                <code className="text-text-secondary">POST /simulate-mirror</code>.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-text-tertiary border-b border-border">
                      <th className="pb-2 font-normal">Время</th>
                      <th className="pb-2 font-normal">Лидер</th>
                      <th className="pb-2 font-normal">Рынок</th>
                      <th className="pb-2 font-normal">Сторона</th>
                      <th className="pb-2 font-normal">Размер</th>
                      <th className="pb-2 font-normal">Исход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mirrorLog.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="py-2.5 text-text-tertiary font-mono text-xs whitespace-nowrap">{new Date(r.created_at * 1000).toLocaleString("ru-RU")}</td>
                        <td className="py-2.5 text-text-secondary">{r.leader_handle}</td>
                        <td className="py-2.5 text-text-primary">
                          {symbolOf(r.market_id)}
                          {r.reduce_only === 1 && <span className="ml-1.5 text-xs text-text-tertiary">закрытие</span>}
                        </td>
                        <td className={`py-2.5 font-mono text-xs ${r.side === "long" ? "text-success" : "text-danger"}`}>{r.side.toUpperCase()}</td>
                        <td className="py-2.5 font-mono text-text-secondary">{fmt(r.base_amount, 4)}</td>
                        <td className="py-2.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-mono ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                          {r.reason && <span className="ml-2 text-xs text-text-tertiary">{r.reason}</span>}
                          {r.tx_hash && (
                            <span className="ml-2 text-xs text-text-muted font-mono" title={r.tx_hash}>
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
