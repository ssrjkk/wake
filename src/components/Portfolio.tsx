import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Pause, Play, Wallet, X } from "lucide-react";
import { getAccountByIndex, getMirrorLog, type LighterAccount, type MirrorLogRow, type OrderBook } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { useRowWindow } from "../lib/useRowWindow";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import type { Following, Tab } from "./types";
import { Modal } from "./ui";
import { avatarColor, shortHandle, fmt, usd } from "./utils";

// Шаг строки журнала: 40 px — высота td вместе с padding 10+10 и нижним
// бордером (box-sizing: border-box делает высоту включённой). Окно считает
// позиции по этому числу, поэтому оно обязано совпадать с .log-row в index.css.
const LOG_ROW_PITCH = 40;

interface PortfolioProps {
  following: Following[];
  // Отдельно от пустого списка: «подписок нет» и «бэкенд их не отдал» — разные
  // экраны. На пустом списке без этой строки человек подписывался бы второй раз
  // и получал 409 там, где база просто не ответила.
  followsError: string | null;
  setTab: (tab: Tab) => void;
  togglePause: (followId: string) => void;
  unfollow: (followId: string) => void;
  signedIn: boolean;
  lighterAccountIndex: number | null;
  hasWallet: boolean;
  markets: OrderBook[];
}

const STATUS_STYLE: Record<MirrorLogRow["status"], { bg: string; color: string; border?: string }> = {
  planned: { bg: "var(--bg-2)", color: "var(--fg-2)" },
  skipped: { bg: "var(--warn-faint)", color: "var(--warn)", border: "var(--warn-line)" },
  dry_run: { bg: "var(--info-faint)", color: "var(--info)", border: "var(--info-line)" },
  sent: { bg: "var(--up-faint)", color: "var(--up)", border: "var(--up-line)" },
  failed: { bg: "var(--down-faint)", color: "var(--down-hi)", border: "var(--down-line)" },
};

// mirror_log.status — обычная колонка String, новый статус в неё может попасть
// раньше, чем этот файл узнает о ней. Неизвестный статус обязан отличаться от
// «failed» и не имеет права ронять панель: статус = единственное, чем человек
// проверяет, что движок сделал с его деньгами.
const UNKNOWN_STATUS = { bg: "var(--bg-2)", color: "var(--fg-2)" };

function statusStyle(status: string) {
  return STATUS_STYLE[status as MirrorLogRow["status"]] ?? UNKNOWN_STATUS;
}

export default function Portfolio({ following, followsError, setTab, togglePause, unfollow, signedIn, lighterAccountIndex, hasWallet, markets }: PortfolioProps) {
  const [account, setAccount] = useState<LighterAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mirrorLog, setMirrorLog] = useState<MirrorLogRow[] | null>(null);
  const [mirrorLogError, setMirrorLogError] = useState<string | null>(null);
  // Подтверждение отписки — панель приложения, а не window.confirm: в
  // Telegram-мини-аппе нативных диалогов нет, и кнопка «удалить подписку» в
  // вебвью не делала ничего. В state держится вся строка, чтобы в диалоге
  // было видно, от кого именно человек отписывается.
  const [unfollowTarget, setUnfollowTarget] = useState<Following | null>(null);
  // Журнал рендерится окном: 200 строк (потолок /mirror-log) mounted целиком
  // делали страницу 10 317 px и 2 348 узлов (замер e2e/render-budget.spec.ts).
  // Шаг строки = height из .log-row, менять вместе.
  const { attach: attachLog, ...logWindow } = useRowWindow<HTMLDivElement>(
    mirrorLog?.length ?? 0,
    LOG_ROW_PITCH,
  );

  useEffect(() => {
    if (lighterAccountIndex == null) return;
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
    const stop = setIntervalWhenVisible(load, 20000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [lighterAccountIndex]);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    async function load() {
      try {
        const rows = await getMirrorLog(50);
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
    const stopLog = setIntervalWhenVisible(load, 20000);
    return () => {
      cancelled = true;
      stopLog();
    };
  }, [signedIn, following.length]);

  const openPositions = account?.positions.filter((p) => Math.abs(p.size) > 0) ?? [];
  const unrealized = openPositions.reduce((s, p) => s + p.unrealizedPnl, 0);

  // Book читается один раз на рендер, а не по две тысячи поисков: журнал
  // отдаёт до 200 строк, рынков в книге 246, и прежний markets.find на каждую
  // ячейку символа и decimals давал ~80 000 сравнений на перерисовку панели.
  const marketById = useMemo(
    () => new Map(markets.map((m) => [m.market_id, m])),
    [markets]
  );

  function symbolOf(marketId: number) {
    return marketById.get(marketId)?.symbol ?? `#${marketId}`;
  }

  function decimalsOf(marketId: number) {
    return marketById.get(marketId)?.supported_price_decimals ?? 2;
  }

  return (
    <div className="terminal-layout terminal-stack" style={{ gap: "16px" }}>
      <section>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
          <h2 style={{ fontSize: "var(--fs-heading)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Мои подписки</h2>
          <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>таблица follows</span>
        </div>
        {followsError && (
          <div className="notice notice-error">
            Подписки не загружены: {followsError}. Пустой список ниже — не ответ базы, а её отсутствие.
          </div>
        )}
        {following.length === 0 ? (
          <div className="empty-state">
            <p style={{ fontSize: "var(--fs-body)", color: "var(--fg-2)", marginBottom: "4px" }}>
              {signedIn ? "Ты пока никого не копируешь" : "Войди через Telegram или кошелёк — подписки привязаны к подтверждённому входу"}
            </p>
            <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "16px", maxWidth: "400px" }}>
              Подписка — это строка в <code style={{ color: "var(--fg-2)" }}>follows</code> с аллокацией и потолком плеча. Её читает копи-движок из{" "}
              <code style={{ color: "var(--fg-2)" }}>mirror_engine.py</code>.
            </p>
            <button className="link-action" onClick={() => setTab("discover")}>
              Найти трейдера <ChevronRight style={{ width: "16px", height: "16px" }} />
            </button>
          </div>
        ) : (
          <div className="table-scroll" style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <table style={{ width: "100%", fontSize: "var(--fs-ui)" }}>
              <thead>
                <tr style={{ textAlign: "left", fontSize: "var(--fs-label)", color: "var(--text-muted)", borderBottom: "1px solid var(--line)" }}>
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
                  <tr key={t.followId} style={{ borderBottom: "1px solid var(--line)" }}>
                    <td style={{ padding: "12px 0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: avatarColor(t.handle), display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--fs-label)", fontWeight: 600, color: "var(--on-accent)" }}>
                          {shortHandle(t.handle)}
                        </div>
                        <span style={{ color: "var(--fg)", fontWeight: 500 }}>{t.handle}</span>
                      </div>
                    </td>
                    <td style={{ padding: "12px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{usd(t.allocationUsd)}</td>
                    <td style={{ padding: "12px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{t.maxLeverage}x</td>
                    <td style={{ padding: "12px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{fmt(t.mirroredSize, 4)}</td>
                    <td style={{ padding: "12px 0" }}>
                      <button
                        onClick={() => togglePause(t.followId)}
                        style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "var(--fs-label)", padding: "8px 10px", borderRadius: "4px", border: "none", cursor: "pointer", background: t.paused ? "var(--bg-2)" : "var(--up-faint)", color: t.paused ? "var(--fg-3)" : "var(--up)", minHeight: "var(--touch)" }}
                      >
                        {t.paused ? <Play style={{ width: "12px", height: "12px" }} /> : <Pause style={{ width: "12px", height: "12px" }} />}
                        {t.paused ? "На паузе" : "Копирует"}
                      </button>
                    </td>
                    <td style={{ padding: "12px 0", textAlign: "right" }}>
                      <button
                        onClick={() => setUnfollowTarget(t)}
                        style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", padding: "14px", display: "flex", alignItems: "center", justifyContent: "center" }}
                        title="Удалить подписку из follows"
                        aria-label={`Удалить подписку на ${t.handle}`}
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
          <h2 style={{ fontSize: "var(--fs-heading)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Счёт на Lighter</h2>
          <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>GET /api/v1/account?by=index</span>
        </div>
        {!hasWallet ? (
          <div className="empty-state">
            <div style={{ width: "28px", height: "28px", borderRadius: "50%", background: "var(--bg-2)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: "12px" }}>
              <Wallet style={{ width: "20px", height: "20px", color: "var(--text-muted)" }} />
            </div>
            <p style={{ fontSize: "var(--fs-body)", color: "var(--fg-2)", margin: 0 }}>Кошелёк не подключён — позиции по адресу не видны</p>
            <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginTop: "4px", maxWidth: "400px" }}>
              Вход через Telegram даёт подписки и журнал, но сам счёт на Lighter привязан к адресу. Подключи кошелёк в шапке.
            </p>
          </div>
        ) : lighterAccountIndex == null ? (
          <div className="empty-state">
            <p style={{ fontSize: "var(--fs-body)", color: "var(--fg-2)", margin: 0 }}>Аккаунт на Lighter не найден</p>
            <p style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginTop: "4px", maxWidth: "400px" }}>
              Регистрация — на app.lighter.xyz. Wake читает только публичные данные счёта и никогда не просит приватный ключ.
            </p>
          </div>
        ) : accountError ? (
          <div style={{ background: "var(--warn-faint)", border: "1px solid var(--warn-line)", borderRadius: "6px", padding: "12px 16px", fontSize: "var(--fs-ui)", color: "var(--warn)" }}>
            Lighter не ответил: <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-data)" }}>{accountError}</span>
          </div>
        ) : account ? (
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "16px", marginBottom: "16px" }}>
              <div>
                <div style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "4px" }}>Капитал</div>
                <div style={{ fontSize: "var(--fs-metric)", fontFamily: "var(--font-mono)", color: "var(--fg)" }}>{usd(account.equityUsd, 2)}</div>
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "4px" }}>Нереализованный PnL</div>
                <div style={{ fontSize: "var(--fs-metric)", fontFamily: "var(--font-mono)", color: unrealized >= 0 ? "var(--up)" : "var(--down)" }}>
                  {unrealized >= 0 ? "+" : ""}
                  {usd(unrealized, 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "4px" }}>Реализованный PnL</div>
                <div style={{ fontSize: "var(--fs-metric)", fontFamily: "var(--font-mono)", color: account.realizedPnlUsd >= 0 ? "var(--up)" : "var(--down)" }}>
                  {account.realizedPnlUsd >= 0 ? "+" : ""}
                  {usd(account.realizedPnlUsd, 2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "var(--fs-data)", color: "var(--text-muted)", marginBottom: "4px" }}>Открытых позиций</div>
                <div style={{ fontSize: "var(--fs-metric)", fontFamily: "var(--font-mono)", color: "var(--fg)" }}>{fmt(openPositions.length)}</div>
              </div>
            </div>

            {openPositions.length === 0 ? (
              <p style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)", margin: 0 }}>Открытых позиций нет — lighter возвращает строку на каждый рынок, который счёт когда-либо трогал.</p>
            ) : (
              <div className="table-scroll">
              <table style={{ width: "100%", fontSize: "var(--fs-ui)", minWidth: "600px" }}>
                <thead>
                  <tr style={{ textAlign: "left", fontSize: "var(--fs-label)", color: "var(--text-muted)", borderBottom: "1px solid var(--line)" }}>
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
                    <tr key={p.marketId} style={{ borderBottom: "1px solid var(--line)" }}>
                      <td style={{ padding: "10px 0" }}>
                        <span style={{ color: "var(--fg)", fontWeight: 500 }}>{p.symbol}</span>
                        <span style={{ marginLeft: "8px", fontSize: "var(--fs-label)", color: p.size >= 0 ? "var(--up)" : "var(--down)" }}>{p.size >= 0 ? "LONG" : "SHORT"}</span>
                      </td>
                      <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{fmt(p.size, 4)}</td>
                      <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{fmt(p.avgEntry, decimalsOf(p.marketId))}</td>
                      <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{usd(Math.abs(p.value), 0)}</td>
                      <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: p.unrealizedPnl >= 0 ? "var(--up)" : "var(--down)" }}>
                        {p.unrealizedPnl >= 0 ? "+" : ""}
                        {usd(p.unrealizedPnl, 2)}
                      </td>
                      <td style={{ padding: "10px 0", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{p.liquidationPrice > 0 ? `$${fmt(p.liquidationPrice, decimalsOf(p.marketId))}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        ) : (
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "24px", fontSize: "var(--fs-ui)", color: "var(--text-muted)" }}>Загружаю счёт…</div>
        )}
      </section>

      {signedIn && (
        <section>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "12px" }}>
            <h2 style={{ fontSize: "var(--fs-heading)", fontWeight: 600, color: "var(--fg)", margin: 0 }}>Журнал копи-движка</h2>
            <span style={{ fontSize: "var(--fs-label)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>таблица mirror_log</span>
          </div>
          <div style={{ background: "var(--bg-1)", border: "1px solid var(--line)", borderRadius: "6px", padding: "16px" }}>
            {mirrorLog === null ? (
              <p style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)", margin: 0 }}>Читаю журнал…</p>
            ) : mirrorLogError ? (
              <p style={{ fontSize: "var(--fs-ui)", color: "var(--down)", margin: 0 }}>
                Не удалось загрузить журнал: {mirrorLogError}
              </p>
            ) : mirrorLog.length === 0 ? (
              <p style={{ fontSize: "var(--fs-ui)", color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
                Пусто. Строки появляются, когда <code style={{ color: "var(--fg-2)" }}>leader_listener.py</code> видит изменение позиции лидера по одной из
                твоих подписок. С <code style={{ color: "var(--fg-2)" }}>WAKE_DRY_RUN=true</code> (значение по умолчанию) исход пишется как{" "}
                <code style={{ color: "var(--fg-2)" }}>dry_run</code>, ордер на Lighter не уходит. Проверить расчёт без листенера можно запросом{" "}
                <code style={{ color: "var(--fg-2)" }}>POST /simulate-mirror</code>.
              </p>
            ) : (
              <div className="table-scroll log-scroll" ref={attachLog}>
                <table style={{ width: "100%", fontSize: "var(--fs-ui)" }}>
                  <thead>
                    <tr style={{ textAlign: "left", fontSize: "var(--fs-label)", color: "var(--text-muted)" }}>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Время</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Лидер</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Рынок</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Сторона</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Размер</th>
                      <th style={{ paddingBottom: "8px", fontWeight: 400 }}>Исход</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logWindow.padTop > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={6} style={{ height: logWindow.padTop, padding: 0, border: "none" }} />
                      </tr>
                    )}
                    {mirrorLog.slice(logWindow.start, logWindow.end).map((r) => (
                      <tr key={r.id} className="log-row">
                        <td style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-data)", whiteSpace: "nowrap" }}>{new Date(r.created_at * 1000).toLocaleString("ru-RU")}</td>
                        <td style={{ color: "var(--fg-2)" }}>{r.leader_handle}</td>
                        <td style={{ color: "var(--fg)" }}>
                          {symbolOf(r.market_id)}
                          {r.reduce_only === 1 && <span style={{ marginLeft: "6px", fontSize: "var(--fs-label)", color: "var(--text-muted)" }}>закрытие</span>}
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-data)", color: r.side === "long" ? "var(--up)" : "var(--down)" }}>{r.side.toUpperCase()}</td>
                        <td style={{ fontFamily: "var(--font-mono)", color: "var(--fg-2)" }}>{fmt(r.base_amount, 4)}</td>
                        <td>
                          <span style={{ fontSize: "var(--fs-label)", padding: "2px 8px", borderRadius: "3px", fontFamily: "var(--font-mono)", background: statusStyle(r.status).bg, color: statusStyle(r.status).color, border: statusStyle(r.status).border ? `1px solid ${statusStyle(r.status).border}` : "none" }}>{r.status}</span>
                          {r.reason && <span style={{ marginLeft: "8px", fontSize: "var(--fs-data)", color: "var(--text-muted)" }}>{r.reason}</span>}
                          {r.tx_hash && (
                            <span style={{ marginLeft: "8px", fontSize: "var(--fs-data)", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }} title={r.tx_hash}>
                              {r.tx_hash.slice(0, 10)}…
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {logWindow.padBottom > 0 && (
                      <tr aria-hidden="true">
                        <td colSpan={6} style={{ height: logWindow.padBottom, padding: 0, border: "none" }} />
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
      {/* Подтверждение отписки. Отдельная панель, а не window.confirm:
          в мини-аппе нативный диалог не показывается, и кнопка молчала. */}
      {unfollowTarget && (
        <Modal label={`Отписаться от ${unfollowTarget.handle}`} onClose={() => setUnfollowTarget(null)}>
          <div className="overlay-shell">
            <h3 className="panel-title" style={{ margin: "0 0 12px" }}>
              Отписаться от {unfollowTarget.handle}
            </h3>
            <div className="kv kv-cols" style={{ marginBottom: "14px" }}>
              <span className="label">Аллокация</span>
              <b className="num">{usd(unfollowTarget.allocationUsd)}</b>
              <span className="label">Зеркальный размер</span>
              <b className="num">{fmt(unfollowTarget.mirroredSize, 4)}</b>
            </div>
            <p className="fineprint" style={{ marginBottom: "14px" }}>
              Строка <code>follows</code> помечается удалённой: движок перестаёт
              строить план по этому лидеру, а журнал <code>mirror_log</code>
              остаётся — по нему видно, что движок уже сделал с деньгами.
              Действие необратимо: подписку придётся оформлять заново.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setUnfollowTarget(null)}
                className="btn-ghost"
                style={{ flex: 1, justifyContent: "center" }}
              >
                Оставить
              </button>
              <button
                onClick={() => {
                  const id = unfollowTarget.followId;
                  setUnfollowTarget(null);
                  unfollow(id);
                }}
                data-autofocus=""
                className="btn-action btn-down"
                style={{ flex: 1, justifyContent: "center" }}
              >
                Удалить подписку
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
