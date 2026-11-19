import { useState, useEffect } from "react";
import { Users, DollarSign, Copy as CopyIcon, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { listHydratedLeaders } from "../lib/lighter";
import { errorText } from "../lib/backend";
import { leaderFromHydrated } from "../lib/leaders";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { Skeleton } from "./ui";
import { avatarSlot, fmt, shortHandle, stamp, usd } from "./utils";
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
        <div className="terminal-header terminal-header--stack">
          <div className="panel-head-row">
            <h2 className="section-title">Кого копируют</h2>
            {lastUpdated && (
              <span
                className="push-right section-note"
                title="Список лидеров и ответ Lighter обновляются раз в 20 секунд"
              >
                обновлено {stamp(lastUpdated)}
              </span>
            )}
          </div>
          <p className="panel-lead">
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
                  {lastUpdated ? `на ${stamp(lastUpdated)}` : "без свежей отметки"}
                </span>
                .
              </>
            ) : (
              <>Список лидеров не загружен: {error}</>
            )}
          </div>
        )}

        {/* Заглушка значит «ещё едет». После отказа она едет вечно рядом со
            строкой «не загружен», и панель противоречит сама себе. */}
        {leaders === null && !error ? (
          <div className="card-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="leader-card">
                <Skeleton height="12px" width="50%" />
                <Skeleton height="24px" />
              </div>
            ))}
          </div>
        ) : !leaders || leaders.length === 0 ? (
          /* Пустая витрина без ошибки — «лидеров правда нет»; с ошибкой выше уже
             всё сказано, и второй текст был бы противоречием. */
          error ? null : (
            <div className="empty-state">
              <Users size={24} className="muted" aria-hidden="true" />
              <p className="panel-lead">В базе пока нет ни одного лидера</p>
              <p className="muted">
                Лидер появляется сам: в Терминале включи «Публиковать мои сделки».
              </p>
            </div>
          )
        ) : (
          <div className="card-grid">
            {leaders.map((t) => {
              const pnl = t.exchange?.realizedPnlUsd ?? null;
              return (
                <div key={t.id} className="leader-card">
                  <div className="row-between">
                    <div className="row">
                      <span className="avatar avatar-lg" data-tag={avatarSlot(t.handle)}>
                        {shortHandle(t.handle)}
                      </span>
                      <div className="stack">
                        <div className="panel-title">{t.handle}</div>
                        <div className="muted num">Lighter #{t.lighterAccountIndex}</div>
                      </div>
                    </div>
                    <span className="chip">{(t.feeBps / 100).toFixed(2)}%</span>
                  </div>

                  <div className="desk-stats">
                    <div className="desk-stat">
                      <span className="label label-row">
                        <Wallet size={10} aria-hidden="true" /> Капитал
                      </span>
                      <b>{pnl === null ? "—" : usd(t.exchange!.equityUsd, 0)}</b>
                    </div>
                    <div className="desk-stat">
                      <span className="label label-row">
                        {pnl != null && pnl >= 0 ? (
                          <TrendingUp size={10} aria-hidden="true" />
                        ) : (
                          <TrendingDown size={10} aria-hidden="true" />
                        )}{" "}
                        PnL
                      </span>
                      <b className={pnl == null ? "muted" : pnl >= 0 ? "text-positive" : "text-negative"}>
                        {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl, 0)}`}
                      </b>
                    </div>
                  </div>

                  <div className="row-between num">
                    <span className="label label-row">
                      <Users size={11} aria-hidden="true" />
                      {fmt(t.followers)}
                    </span>
                    <span className="label label-row">
                      <DollarSign size={11} aria-hidden="true" />
                      {fmt(t.aumUsd)}
                    </span>
                  </div>
                  <p className="muted">
                    {t.exchange ? `${t.exchange.openPositions.length} позиций` : "Lighter не ответил"} · с {new Date(t.since * 1000).toLocaleDateString("ru-RU")}
                  </p>
                  <button onClick={() => setCopyModal(t)} className="btn-primary btn-block">
                    <CopyIcon size={12} aria-hidden="true" /> Copy
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
