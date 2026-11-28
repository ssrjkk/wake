import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Pause, Play, Wallet, X } from "lucide-react";
import { getAccountByIndex, getMirrorLog, type LighterAccount, type MirrorLogRow, type OrderBook } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { useRowWindow } from "../lib/useRowWindow";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import type { Following, Tab } from "./types";
import { Modal } from "./ui";
import { avatarSlot, shortHandle, fmt, usd } from "./utils";

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
  accountLookupError: string | null;
  hasWallet: boolean;
  markets: OrderBook[];
}

// Статус журнала — чип темы, а не набор оттенков, который панель смешивала сама
// (bg/color/border тремя инлайнами на строку). Базовый .chip уже даёт «ничего не
// решено»: --bg-2, --line-strong, --fg-2.
const STATUS_CHIP: Record<MirrorLogRow["status"], string> = {
  planned: "",
  skipped: "chip-warn",
  dry_run: "chip-info",
  // Зелёный здесь только у подтверждённого исполнения. `sent` — это «заявка
  // принята площадкой», и до появления сверки он был единственным «успехом»
  // журнала: MARKET+IOC, снятый с цены, отвечал успешно и красился как
  // открывшая позиция. Теперь он info: подтверждения нет, позиция неизвестна.
  sent: "chip-info",
  filled: "chip-up",
  partially_filled: "chip-warn",
  // Снят с цены: заявка прожила и не исполнилась ни на единицу. Не ошибка —
  // цена ушла, и ордер с IOC обязан был сняться, — поэтому нейтральный чип.
  unfilled: "",
  // Неизвестно: ленту сделок не прочитали. От «не исполнилось» это отличается
  // правом двигать учёт — у unknown такого права нет, и цвет обязан это помнить.
  unconfirmed: "",
  failed: "chip-down",
};

// mirror_log.status — обычная колонка String, новый статус в неё может попасть
// раньше, чем этот файл узнает о ней. Неизвестный статус обязан отличаться от
// «failed» и не имеет права ронять панель: статус = единственное, чем человек
// проверяет, что движок сделал с его деньгами.
const UNKNOWN_CHIP = "";

function statusChip(status: string): string {
  return `chip ${STATUS_CHIP[status as MirrorLogRow["status"]] ?? UNKNOWN_CHIP}`.trim();
}

export default function Portfolio({ following, followsError, setTab, togglePause, unfollow, signedIn, lighterAccountIndex, accountLookupError, hasWallet, markets }: PortfolioProps) {
  const [account, setAccount] = useState<LighterAccount | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [mirrorLog, setMirrorLog] = useState<MirrorLogRow[] | null>(null);
  const [mirrorLogError, setMirrorLogError] = useState<string | null>(null);
  // Подтверждение отписки — панель приложения, а не window.confirm: в
  // Telegram-мини-аппе нативных диалогов нет, и кнопка «удалить подписку» в
  // вебвью не делала ничего. В state держится вся строка, чтобы в диалоге
  // было видно, от кого именно человек отписывается.
  const [unfollowTarget, setUnfollowTarget] = useState<Following | null>(null);
  // Журнал рендерится окном: mounted целиком он растит страницу вместо
  // скролла внутри панели. Где проходит граница «слишком», решает прогон
  // e2e/render-budget.spec.ts, а не число в этом комментарии.
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
  // отдаёт строку на каждое решение движка (лимит запроса и его потолок —
  // в роуте /mirror-log), книга — сотни рынков, и прежний markets.find на
  // каждую ячейку символа и decimals давал десятки тысяч сравнений на
  // перерисовку панели.
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
    <div className="terminal-layout terminal-stack">
      <section>
        <div className="section-head">
          <h2 className="section-title">Мои подписки</h2>
          <span className="section-note">таблица follows</span>
        </div>
        {followsError && (
          <div className="notice notice-error">
            Подписки не загружены: {followsError}. Пустой список ниже — не ответ базы, а её отсутствие.
          </div>
        )}
        {following.length === 0 ? (
          <div className="empty-state">
            <p className="panel-lead">
              {signedIn ? "Ты пока никого не копируешь" : "Войди через Telegram или кошелёк — подписки привязаны к подтверждённому входу"}
            </p>
            <p className="muted">
              Подписка — это строка в <code>follows</code> с аллокацией и потолком плеча. Её читает копи-движок из{" "}
              <code>mirror_engine.py</code>.
            </p>
            <button className="link-action" onClick={() => setTab("discover")}>
              Найти трейдера <ChevronRight size={16} />
            </button>
          </div>
        ) : (
          <div className="terminal-panel table-scroll">
            <table className="data-table data-table--wide">
              <thead>
                <tr>
                  <th scope="col">Лидер</th>
                  <th scope="col">Аллокация</th>
                  <th scope="col">Плечо</th>
                  <th scope="col">Зеркальный размер</th>
                  <th className="left">Статус</th>
                  <th className="left"><span className="sr-only">Действия</span></th>
                </tr>
              </thead>
              <tbody>
                {following.map((t) => (
                  <tr key={t.followId}>
                    <td>
                      <div className="row">
                        <span className="avatar" data-tag={avatarSlot(t.handle)}>{shortHandle(t.handle)}</span>
                        <span>{t.handle}</span>
                      </div>
                    </td>
                    <td className="right num muted">{usd(t.allocationUsd)}</td>
                    <td className="right num muted">{t.maxLeverage}x</td>
                    <td className="right num muted">{fmt(t.mirroredSize, 4)}</td>
                    <td className="left">
                      <button
                        onClick={() => togglePause(t.followId)}
                        className={`chip chip-btn${t.paused ? "" : " chip-up"}`}
                        aria-pressed={!t.paused}
                      >
                        {t.paused ? <Play size={12} /> : <Pause size={12} />}
                        {t.paused ? "На паузе" : "Копирует"}
                      </button>
                    </td>
                    <td className="left">
                      <button
                        onClick={() => setUnfollowTarget(t)}
                        className="icon-btn"
                        title="Удалить подписку из follows"
                        aria-label={`Удалить подписку на ${t.handle}`}
                      >
                        <X size={16} />
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
        <div className="section-head">
          <h2 className="section-title">Счёт на Lighter</h2>
          <span className="section-note">GET /api/v1/account?by=index</span>
        </div>
        {!hasWallet ? (
          <div className="empty-state">
            <Wallet size={20} className="muted" aria-hidden="true" />
            <p className="panel-lead">Кошелёк не подключён — позиции по адресу не видны</p>
            <p className="muted">
              Вход через Telegram даёт подписки и журнал, но сам счёт на Lighter привязан к адресу. Подключи кошелёк в шапке.
            </p>
          </div>
        ) : accountLookupError ? (
          <div className="notice notice-warn">
            Не удалось проверить аккаунт Lighter: <span className="num">{accountLookupError}</span>
          </div>
        ) : lighterAccountIndex == null ? (
          <div className="empty-state">
            <p className="panel-lead">Аккаунт на Lighter не найден</p>
            <p className="muted">
              Регистрация — на app.lighter.xyz. Wake читает только публичные данные счёта и никогда не просит приватный ключ.
            </p>
          </div>
        ) : accountError ? (
          <div className="notice notice-warn">
            Lighter не ответил: <span className="num">{accountError}</span>
          </div>
        ) : account ? (
          <div className="terminal-panel panel-pad">
            <div className="desk-stats">
              <div className="desk-stat desk-stat-lg">
                <span className="label">Капитал</span>
                <b>{usd(account.equityUsd, 2)}</b>
              </div>
              <div className="desk-stat desk-stat-lg">
                <span className="label">Нереализованный PnL</span>
                <b className={unrealized >= 0 ? "text-positive" : "text-negative"}>
                  {unrealized >= 0 ? "+" : ""}
                  {usd(unrealized, 2)}
                </b>
              </div>
              <div className="desk-stat desk-stat-lg">
                <span className="label">Реализованный PnL</span>
                <b className={account.realizedPnlUsd >= 0 ? "text-positive" : "text-negative"}>
                  {account.realizedPnlUsd >= 0 ? "+" : ""}
                  {usd(account.realizedPnlUsd, 2)}
                </b>
              </div>
              <div className="desk-stat desk-stat-lg">
                <span className="label">Открытых позиций</span>
                <b>{fmt(openPositions.length)}</b>
              </div>
            </div>

            {openPositions.length === 0 ? (
              <p className="muted">Открытых позиций нет — lighter возвращает строку на каждый рынок, который счёт когда-либо трогал.</p>
            ) : (
              <div className="table-scroll">
                <table className="data-table data-table--wide">
                  <thead>
                    <tr>
                      <th scope="col">Рынок</th>
                      <th scope="col">Размер</th>
                      <th scope="col">Средняя входа</th>
                      <th scope="col">Номинал</th>
                      <th scope="col">PnL</th>
                      <th scope="col">Ликв.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map((p) => (
                      <tr key={p.marketId}>
                        <td>
                          <span className="row">
                            <span>{p.symbol}</span>
                            <span className={`chip ${p.size >= 0 ? "chip-up" : "chip-down"}`}>{p.size >= 0 ? "LONG" : "SHORT"}</span>
                          </span>
                        </td>
                        <td className="right num">{fmt(p.size, 4)}</td>
                        <td className="right num">{fmt(p.avgEntry, decimalsOf(p.marketId))}</td>
                        <td className="right num">{usd(Math.abs(p.value), 0)}</td>
                        <td className={`right num ${p.unrealizedPnl >= 0 ? "text-positive" : "text-negative"}`}>
                          {p.unrealizedPnl >= 0 ? "+" : ""}
                          {usd(p.unrealizedPnl, 2)}
                        </td>
                        <td className="right num muted">{p.liquidationPrice > 0 ? `$${fmt(p.liquidationPrice, decimalsOf(p.marketId))}` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div className="terminal-panel panel-pad">
            <span className="muted">Загружаю счёт…</span>
          </div>
        )}
      </section>

      {signedIn && (
        <section>
          <div className="section-head">
            <h2 className="section-title">Журнал копи-движка</h2>
            <span className="section-note">таблица mirror_log</span>
          </div>
          {mirrorLog === null ? (
            <div className="terminal-panel panel-pad">
              <span className="muted">Читаю журнал…</span>
            </div>
          ) : mirrorLogError ? (
            <div className="notice notice-error">Не удалось загрузить журнал: {mirrorLogError}</div>
          ) : mirrorLog.length === 0 ? (
            <div className="empty-state">
              <p className="panel-lead">Пусто</p>
              <p className="muted">
                Строки появляются, когда <code>leader_listener.py</code> видит изменение позиции лидера по одной из твоих подписок. С{" "}
                <code>WAKE_DRY_RUN=true</code> (значение по умолчанию) исход пишется как <code>dry_run</code>, ордер на Lighter не уходит.
                Проверить расчёт без листенера можно запросом <code>POST /simulate-mirror</code>.
              </p>
            </div>
          ) : (
            <div className="terminal-panel table-scroll log-scroll" ref={attachLog}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col" className="left">Время</th>
                    <th scope="col" className="left">Лидер</th>
                    <th scope="col" className="left">Рынок</th>
                    <th scope="col" className="left">Сторона</th>
                    <th scope="col" className="left">Заявлено</th>
                    <th scope="col" className="left">Исход</th>
                  </tr>
                </thead>
                <tbody>
                  {logWindow.padTop > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={6} className="log-spacer" style={{ height: logWindow.padTop }} />
                    </tr>
                  )}
                  {mirrorLog.slice(logWindow.start, logWindow.end).map((r) => (
                    <tr key={r.id} className="log-row">
                      <td className="muted num">{new Date(r.created_at * 1000).toLocaleString("ru-RU")}</td>
                      <td className="left">{r.leader_handle}</td>
                      <td className="left">
                        {symbolOf(r.market_id)}
                        {r.reduce_only === 1 && <span className="muted"> закрытие</span>}
                      </td>
                      <td className={`left num ${r.side === "long" ? "text-positive" : "text-negative"}`}>{r.side.toUpperCase()}</td>
                      <td className="num">{fmt(r.base_amount, 4)}</td>
                      <td className="left">
                        <span className={statusChip(r.status)}>{r.status}</span>
                        {/* Исполненный базовый размер — то, что сверка прочитала
                            в ленте сделок, а не то, что было заказано. Числа в
                            этой колонке расходится с «Размером» ровно там, где
                            IOC снялся с цены; null — «сверки не было», и
                            выдумывать за него ноль нельзя. */}
                        {r.filled_base_amount != null && (
                          <span className="muted"> исполнено {fmt(r.filled_base_amount, 4)}</span>
                        )}
                        {r.reason && <span className="muted"> {r.reason}</span>}
                        {r.tx_hash && (
                          <span className="muted num" title={r.tx_hash}> {r.tx_hash.slice(0, 10)}…</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {logWindow.padBottom > 0 && (
                    <tr aria-hidden="true">
                      <td colSpan={6} className="log-spacer" style={{ height: logWindow.padBottom }} />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {/* Подтверждение отписки. Отдельная панель, а не window.confirm:
          в мини-аппе нативный диалог не показывается, и кнопка молчала. */}
      {unfollowTarget && (
        <Modal label={`Отписаться от ${unfollowTarget.handle}`} onClose={() => setUnfollowTarget(null)}>
          <div className="overlay-shell">
            <h3 className="panel-title">Отписаться от {unfollowTarget.handle}</h3>
            <div className="kv kv-cols">
              <span className="label">Аллокация</span>
              <b className="num">{usd(unfollowTarget.allocationUsd)}</b>
              <span className="label">Зеркальный размер</span>
              <b className="num">{fmt(unfollowTarget.mirroredSize, 4)}</b>
            </div>
            <p className="fineprint">
              Строка <code>follows</code> помечается удалённой: движок перестаёт
              строить план по этому лидеру, а журнал <code>mirror_log</code>
              остаётся — по нему видно, что движок уже сделал с деньгами.
              Действие необратимо: подписку придётся оформлять заново.
            </p>
            <div className="overlay-actions">
              <button
                onClick={() => setUnfollowTarget(null)}
                className="btn-ghost"
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
