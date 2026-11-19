import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, Percent, RefreshCw, ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { getMarketOverview, isTradeable, type MarketOverview, type MarketOverviewRow, type OrderBook } from "../lib/lighter";
import { getMarkets as getArcusMarkets, getMidPrices, isArcusOnline, arcusFundingHourly, arcusAnnualizedFunding, type ArcusMarket } from "../lib/arcus";
import { errorText } from "../lib/backend";
import { getPredictMarkets, predictTimeLeft, type PredictMarket } from "../lib/predict";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { fmtPrice, fmtPct, fmtUsdCompact } from "./utils";
import { Skeleton } from "./ui";
import type { Tab } from "./types";

// Бэкенд кэширует обзор под ttl своего @cached (backend/lighter_rest.py),
// поэтому крутить чаще — это не «свежее», а пустые запросы.
const REFRESH_MS = 60_000;
const SHOWN_BY_DEFAULT = 10;

interface DashboardProps {
  setTab: (tab: Tab) => void;
  setAsset: (asset: string) => void;
  // Книга Lighter: по ней видно, откроется ли аркусный тикер в Терминале.
  markets: OrderBook[];
}

export default function Dashboard({ setTab, setAsset, markets }: DashboardProps) {
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [arcusMarkets, setArcusMarkets] = useState<ArcusMarket[]>([]);
  const [arcusPrices, setArcusPrices] = useState<Record<string, string>>({});
  const [arcusError, setArcusError] = useState<string | null>(null);
  // null — это «ещё не загрузилось», [] — «загрузилось и рынков правда нет».
  // Одно состояние на оба случая печатало бы «Открытых рынков нет» до первого
  // ответа бэкенда, а /markets/overview стоит дорого (по свечному запросу на
  // рынок) и не успевает до отрисовки.
  const [predict, setPredict] = useState<PredictMarket[] | null>(null);
  // Ошибка Predict — отдельным состоянием: «рынков нет» и «бэкенд не ответил» —
  // это разные вещи, и показывать первое вместо второго значит прятать поломку.
  const [predictError, setPredictError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Кнопка «обновить» меняет именно зависимость эффекта. Сбросить состояние в
  // null — это не перезагрузка: следующий запрос всё равно произошёл бы только
  // через 60 секунд, и кнопка выглядела бы рабочей, не будучи ею.
  const [nonce, setNonce] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Два независимых эффекта, а не один с двумя await подряд: обзор считается
  // секунды, и последовательное ожидание держало бы Predict пустым всё это время.
  useEffect(() => {
    let alive = true;
    getMarketOverview()
      .then((data) => {
        if (!alive) return;
        setOverview(data);
        setMarketsError(null);
        setLastUpdated(new Date());
      })
      .catch((e) => {
        if (alive) setMarketsError(errorText(e));
      });
    const stopRefresh = setIntervalWhenVisible(() => setNonce((n) => n + 1), REFRESH_MS);
    return () => {
      alive = false;
      stopRefresh();
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    getPredictMarkets("open")
      .then((rows) => {
        if (!alive) return;
        setPredict(rows);
        setPredictError(null);
      })
      .catch((e) => {
        if (alive) setPredictError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  useEffect(() => {
    let alive = true;
    getArcusMarkets()
      .then((markets) => {
        if (!alive) return;
        setArcusMarkets(markets);
        setArcusError(null);
        return getMidPrices().then((data) => {
          if (!alive) return;
          setArcusPrices(data.mids);
        });
      })
      .catch((e) => {
        if (alive) setArcusError(errorText(e));
      });
    function pollMids() {
      getMidPrices()
        .then((data) => {
          if (!alive) return;
          setArcusPrices(data.mids);
          setArcusError(null);
        })
        .catch((error) => {
          if (alive) setArcusError(errorText(error));
        });
    }
    const stopMids = setIntervalWhenVisible(pollMids, 30000);
    return () => {
      alive = false;
      stopMids();
    };
  }, []);

  /* Тикеры Lighter по базовому активу: аркусная строка ведёт в Терминал, а тот
      ищет рынок по символу книги. Без проверки клик по «TSLA», которого на
      Lighter нет, открывал бы терминал с надписью «Рынок не загружен» —
      выглядит как поломка Терминала, а не как отсутствие инструмента. Тот же
      isTradeable, что фильтрует рельс Терминала: снятый с торгов рынок в этот
      рельс не попадает, значит и вести строку на него некуда. */
  const lighterSymbols = useMemo(
    () => new Set(markets.filter(isTradeable).map((m) => m.symbol.toUpperCase())),
    [markets]
  );

  function openMarket(row: MarketOverviewRow) {
    // symbol — ровно то, что лежит в книге Lighter: Terminal ищет рынок по этому
    // же полю, и расхождение (base вместо symbol) открывало бы пустой терминал.
    setAsset(row.symbol);
    setTab("terminal");
  }

  // Торгующиеся рынки впереди: 6 строк из 70 в живом /v1/markets — OFFLINE, и в
  // простом срезе «первые 15» они вытесняют те, по которым что-то видно.
  // Порядок внутри группы сохраняется (sort стабилен).
  const arcusRows = useMemo(
    () => [...arcusMarkets].sort((a, b) => Number(isArcusOnline(b)) - Number(isArcusOnline(a))),
    [arcusMarkets]
  );

  const rows = overview?.rows ?? [];
  const visible = showAll ? rows : rows.slice(0, SHOWN_BY_DEFAULT);
  const missing = [...(overview?.no_market ?? []), ...(overview?.no_data ?? [])];

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header terminal-header--stack">
          <div className="panel-head-row">
            <h2 className="section-title">Рынки Lighter</h2>
            <span className="chip chip-accent">zkLighter</span>
            <button
              onClick={() => setNonce((n) => n + 1)}
              className="btn-ghost push-right"
              title="Обновить сейчас"
            >
              <RefreshCw size={12} /> обновить
            </button>
            {lastUpdated && (
              <span className="section-note">
                {lastUpdated.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
          </div>
          <p className="panel-lead">
            Перпы на zkLighter, отсортированные по фактическому $-обороту за 24 часа: оборот — сумма 24 часовых свечей по каждому
            рынку, а не поле из книги (его в /orderBooks нет). Те же строки и тот же метод, что печатает{" "}
            <code>/markets</code> в Telegram-боте.
          </p>
        </div>

      {marketsError && (
        <div className="notice">
          <TriangleAlert size={14} aria-hidden="true" />
          <span>
            Обзор рынка временно недоступен. Функция требует подключённый бэкенд Wake.
          </span>
        </div>
      )}

      {!overview && !marketsError ? (
        <div className="terminal-header terminal-header--stack">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} height="20px" />
          ))}
        </div>
      ) : !overview ? (
        null
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p className="panel-lead">Ни один рынок не собрался из живых данных</p>
          <p className="muted">
            Бэкенд вернул ответ без рядов — детали в no_market / no_data ниже.
          </p>
        </div>
      ) : (
        <div className="terminal-panel">
          <div className="table-scroll">
          <table className="data-table data-table--fit" aria-label="Рынки Lighter">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col" className="left">Актив</th>
                <th scope="col" className="right">Цена</th>
                <th scope="col" className="right">24ч</th>
                <th scope="col" className="right">Оборот 24ч</th>
                <th scope="col" className="right" title="Ставка за часовую эпоху funding">
                  Funding, %/ч
                </th>
                <th scope="col" className="right">Годовая</th>
                <th scope="col" className="left">Платят</th>
                <th scope="col" className="right" title="Открытый интерес в единицах актива">
                  OI, баз.
                </th>
                <th scope="col" className="right">Мин. лот</th>
                <th scope="col" className="right"><span className="sr-only">Открыть</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.market_id} data-action onClick={() => openMarket(r)}>
                  <td className="muted num">{i + 1}</td>
                  <td className="left cell-name">{r.symbol}</td>
                  <td className="right num">{fmtPrice(r.price)}</td>
                  <td className={`right num cell-em ${r.change_24h >= 0 ? "text-positive" : "text-negative"}`}>
                    {fmtPct(r.change_24h)}
                  </td>
                  <td className="right num secondary">{fmtUsdCompact(r.quote_volume_24h)}</td>
                  <td className="right num secondary">
                    {r.funding_hourly == null ? "—" : (r.funding_hourly * 100).toFixed(4)}
                  </td>
                  <td className="right num cell-em">
                    {r.funding_annualized == null ? "—" : `${(r.funding_annualized * 100).toFixed(1)}%`}
                  </td>
                  <td className="left">
                    {r.funding_payer == null ? (
                      <span className="muted">нет ставки</span>
                    ) : r.funding_payer === "long" ? (
                      <span className="text-positive cell-em">лонги</span>
                    ) : r.funding_payer === "short" ? (
                      <span className="text-negative cell-em">шорты</span>
                    ) : (
                      <span className="muted">никто (0%)</span>
                    )}
                  </td>
                  <td className="right num secondary">
                    {r.open_interest_base > 0 ? r.open_interest_base.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}
                  </td>
                  <td className="right num secondary">
                    {r.min_base_amount > 0 ? r.min_base_amount.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                  </td>
                  <td className="right">
                    {/* Ряд открывается и мышью, и клавиатурой: `data-action` даёт
                        строке курсор, но с клавиатуры рынок иначе не открыть. */}
                    <button
                      className="row-open"
                      aria-label={`Открыть ${r.symbol} в Терминале`}
                      onClick={(event) => {
                        event.stopPropagation();
                        openMarket(r);
                      }}
                    >
                      <ArrowRight size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="panel-foot">
            <span>
              сеть {overview?.network} · рядов {rows.length}
            </span>
            {rows.length > SHOWN_BY_DEFAULT && (
              <button onClick={() => setShowAll((v) => !v)} className="link-action">
                {showAll ? "свернуть" : `показать все ${rows.length}`}
              </button>
            )}
            {missing.length > 0 && <span className="secondary">без данных: {missing.join(", ")}</span>}
          </div>
        </div>
      )}

      <div className="terminal-header terminal-header--stack">
        <div className="panel-head-row">
          <h2 className="section-title">Рынки Arcus</h2>
          <span className="chip chip-up">Robinhood Chain</span>
          {arcusError && (
            <div className="head-alert">
              <TriangleAlert size={12} aria-hidden="true" />
              <span>{Object.keys(arcusPrices).length ? "Arcus не отвечает — показаны последние котировки" : "Arcus не отвечает"}</span>
            </div>
          )}
        </div>
        <p className="panel-lead">
          Рынки из публичного API Arcus — все perpetual (поле <code>type</code> = PERPETUAL), класс актива: крипта, акции, сырьё или индекс. Mid-цены с{" "}
          <code>api.arcus.xyz/v1/mids</code> каждые 30 секунд; это середина котировок, не цена исполнения. Funding читается из ответа{" "}
          <code>v1/markets</code>, а не пересчитывается: начисление почасовое, годовая = ставка × 24 × 365 для крипты и × 24 × 360 для RWA.
        </p>
      </div>

      {arcusMarkets.length === 0 && !arcusError ? (
        <div className="terminal-header terminal-header--stack">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height="20px" />
          ))}
        </div>
      ) : arcusMarkets.length === 0 ? (
        <div className="empty-state">
          <p className="panel-lead">Arcus не вернул рынков</p>
          <p className="muted">
            API доступен, но список markets пуст.
          </p>
        </div>
      ) : (
        <div className="terminal-panel">
          <div className="table-scroll">
          <table className="data-table data-table--fit" aria-label="Рынки Arcus">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col" className="left">Актив</th>
                <th scope="col" className="left">Класс</th>
                <th scope="col" className="right">Mid-цена</th>
                <th scope="col" className="right" title="Ставка funding за часовую эпоху, из ответа рынка">
                  Funding, %/ч
                </th>
                <th scope="col" className="right" title="Крипта: ставка × 24 × 365; RWA: × 24 × 360 (год по конвенции SOFR)">
                  Годовая
                </th>
                <th scope="col" className="right">Tick size</th>
                <th scope="col" className="right">Step size</th>
                <th scope="col" className="left">Статус</th>
                <th scope="col" className="right"><span className="sr-only">Открыть</span></th>
              </tr>
            </thead>
            <tbody>
              {arcusRows.slice(0, 15).map((m, i) => {
                const price = arcusPrices[m.marketDisplayName];
                const online = isArcusOnline(m);
                const hourly = arcusFundingHourly(m);
                const annual = arcusAnnualizedFunding(m);
                const onLighter = lighterSymbols.has(m.baseAsset.toUpperCase());
                return (
                  <tr
                    key={m.marketId}
                    data-action={onLighter ? "" : undefined}
                    onClick={
                      onLighter
                        ? () => {
                            setAsset(m.baseAsset);
                            setTab("terminal");
                          }
                        : undefined
                    }
                  >
                    <td className="muted num">{i + 1}</td>
                    <td className="left">
                      <div className="cell-name">{m.marketDisplayName}</div>
                      <div className="muted num">{m.baseAsset}/{m.quoteAsset}</div>
                    </td>
                    <td className="left">
                      {m.category ? (
                        <span className="chip">{m.category}</span>
                      ) : (
                        <span className="muted">нет класса</span>
                      )}
                    </td>
                    <td className="right num cell-em">
                      {price ? fmtPrice(Number(price)) : "—"}
                    </td>
                    <td className="right num secondary">
                      {hourly === null ? "—" : (hourly * 100).toFixed(4)}
                    </td>
                    <td className="right num cell-em">
                      {annual === null ? "—" : `${(annual * 100).toFixed(1)}%`}
                    </td>
                    <td className="right num secondary">{m.tickSize}</td>
                    <td className="right num secondary">{m.stepSize}</td>
                    <td className="left">
                      <span className={online ? "text-positive cell-em" : "muted"}>
                        {online ? "торгуется" : "выключен"}
                      </span>
                    </td>
                    <td className="right">
                      {/* Терминал читает Lighter: строку Arcus он открывает только
                          по тикеру, который есть в его книге. */}
                      {onLighter ? (
                        <button
                          className="row-open"
                          aria-label={`Открыть ${m.baseAsset} в Терминале`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setAsset(m.baseAsset);
                            setTab("terminal");
                          }}
                        >
                          <ArrowRight size={12} />
                        </button>
                      ) : (
                        <span className="muted">нет на Lighter</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {arcusRows.length > 15 && (
            <div className="panel-foot">
              показано 15 из {arcusRows.length} рынков
            </div>
          )}
        </div>
      )}

      <div className="terminal-header terminal-header--stack">
        <div className="panel-head-row">
          <BarChart3 size={14} className="text-info" aria-hidden="true" />
          <h3 className="sub-title">Predict — открытые рынки</h3>
          <button onClick={() => setTab("predict")} className="link-action push-right">
            торговать <ArrowRight size={12} />
          </button>
        </div>
      </div>
        {predictError ? (
          <div className="notice notice-warn">
            Открытые рынки Predict временно недоступны. Функция требует подключённый бэкенд Wake.
          </div>
        ) : predict === null ? (
          <div className="card-grid">
            {[0, 1].map((i) => (
              <div key={i} className="sk-card">
                <Skeleton height="12px" width="96px" />
                <Skeleton height="16px" />
                <Skeleton height="6px" />
              </div>
            ))}
          </div>
        ) : predict.length === 0 ? (
          <div className="notice">
            Открытых рынков нет. Резолвленные с исходами — во вкладке Predict; создать рынок может только куратор
            (POST /predict/markets/price или /predict/markets/event с X-Curator-Token).
          </div>
        ) : (
          <div className="card-grid">
            {predict.slice(0, 4).map((m) => (
              <button key={m.id} className="nav-card" onClick={() => setTab("predict")}>
                <div className="market-card-head">
                  <span className="label">
                    {m.kind === "price" ? "цена на Lighter" : "событие"}
                  </span>
                  <span className="sub-label push-right">{predictTimeLeft(m.resolve_at)}</span>
                </div>
                <p className="market-question">{m.question}</p>
                <div className="market-prob">
                  <span className="prob-bar">
                    <i style={{ width: `${m.price_yes * 100}%` }} />
                  </span>
                  <span className="num prob-value">{(m.price_yes * 100).toFixed(0)}% YES</span>
                </div>
                <p className="sub-label num">
                  {fmtUsdCompact(m.volume_usd)} · {m.trade_count} сдел.
                </p>
              </button>
            ))}
          </div>
        )}

      <div className="card-grid">
        <button className="nav-card" onClick={() => setTab("discover")}>
          <Users size={14} className="text-info" aria-hidden="true" />
          <span className="nav-card-title">Копирование сделок</span>
          <span className="nav-card-body">
            Лидер торгует своим депозитом; его сделка повторяется пропорционально аллокации. Комиссия — б.п. от скопированной сделки,
            в базе она объявлена и пока не списывается.
          </span>
        </button>
        <button className="nav-card" onClick={() => setTab("risk")}>
          <ShieldAlert size={14} className="text-accent" aria-hidden="true" />
          <span className="nav-card-title">Риск корзины</span>
          <span className="nav-card-body">
            30 часовых закрытий, волатильность корзины и подбор хеджа из реальных рынков.
          </span>
        </button>
        <button className="nav-card" onClick={() => setTab("funding")}>
          <Percent size={14} className="text-positive" aria-hidden="true" />
          <span className="nav-card-title">Funding и carry</span>
          <span className="nav-card-body">
            Ставки Lighter рядом с Binance, Bybit и Hyperliquid. Дельта-нейтральная связка с округлением под минимальный лот.
          </span>
        </button>
      </div>
      </div>
    </div>
  );
}
