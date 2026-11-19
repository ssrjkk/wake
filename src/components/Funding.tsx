import { useState, useEffect, useMemo } from "react";
import { RefreshCw, Percent, ArrowUpRight } from "lucide-react";
import { getFundingRates, getCandles, isTradeable, type FundingRateRow, type OrderBook } from "../lib/lighter";
import { getMarkets as getArcusMarkets, isArcusPerp, type ArcusMarket } from "../lib/arcus";
import { pairableCarryMarkets } from "../lib/carry";
import { backendJson, errorText } from "../lib/backend";
import { setIntervalWhenVisible } from "../lib/visibleInterval";
import { Skeleton } from "./ui";
import type { FundingCheck, FundingSizing } from "./types";
import { fmt } from "./utils";

// Lighter's funding epoch is 1 hour (see backend/funding_arb.py for how that was
// established), so annualising is rate * 24 * 365, not rate * 3 * 365.
const HOURS_PER_YEAR = 24 * 365;

type Row = {
  marketId: number;
  symbol: string;
  rate: number;
  apy: number;
  reference: { exchange: string; rate: number }[];
  spot: OrderBook | null;
  perp: OrderBook | null;
};

interface FundingProps {
  markets: OrderBook[];
  setToast: (toast: string | null) => void;
}

export default function Funding({ markets, setToast }: FundingProps) {
  const [rates, setRates] = useState<FundingRateRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [arcusPerps, setArcusPerps] = useState<ArcusMarket[]>([]);
  const [arcusError, setArcusError] = useState<string | null>(null);
  const [onlyDeltaNeutral, setOnlyDeltaNeutral] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [capital, setCapital] = useState(2000);
  const [minApy, setMinApy] = useState(5);
  const [check, setCheck] = useState<FundingCheck | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [sizing, setSizing] = useState<FundingSizing | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function load() {
      getFundingRates()
        .then((r) => {
          setRates(r);
          setLoadError(null);
        })
        .catch((e) => setLoadError(errorText(e)));
    }
    load();
    const stop = setIntervalWhenVisible(load, 60000);
    return () => stop();
  }, []);

  useEffect(() => {
    getArcusMarkets()
      .then((m) => {
        setArcusPerps(m.filter(isArcusPerp));
        setArcusError(null);
      })
      .catch((e) => {
        setArcusPerps([]);
        setArcusError(errorText(e));
      });
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!rates) return [];
    const byMarket = new Map<number, { lighter?: FundingRateRow; ref: FundingRateRow[] }>();
    for (const r of rates) {
      const entry = byMarket.get(r.market_id) ?? { ref: [] };
      if (r.exchange === "lighter") entry.lighter = r;
      else entry.ref.push(r);
      byMarket.set(r.market_id, entry);
    }
    // Обе ноги берутся одним разбором — pairableCarryMarkets из src/lib/carry.ts,
    // где правило совпадает с бэкендовским pairable_carry_markets: активный перп,
    // активный спот и котировка спота ровно тот же стейбл. Раньше спот резался по
    // суффиксу "/USDC", а status не читался вовсе, и панель показывала
    // возможность по неактивной книге и по написанию, которое бэкенд отвергает.
    const carry = pairableCarryMarkets(markets);
    const perpById = new Map(
      markets
        .filter((m) => m.market_type === "perp" && isTradeable(m))
        .map((m) => [m.market_id, m]),
    );

    const out: Row[] = [];
    for (const [marketId, entry] of byMarket) {
      const lighter = entry.lighter;
      if (!lighter) continue;
      const pair = carry.get(lighter.symbol);
      out.push({
        marketId,
        symbol: lighter.symbol,
        rate: lighter.rate,
        apy: lighter.rate * HOURS_PER_YEAR * 100,
        reference: entry.ref.map((r) => ({ exchange: r.exchange, rate: r.rate })),
        spot: pair?.spot ?? null,
        perp: perpById.get(marketId) ?? null,
      });
    }
    return out.sort((a, b) => b.apy - a.apy);
  }, [rates, markets]);

  const visible = rows
    .filter((r) => (onlyDeltaNeutral ? r.spot != null : true))
    .filter((r) => Math.abs(r.apy) >= minApy)
    .slice(0, 40);

  async function runCheck(row: Row) {
    setSelected(row);
    setSizing(null);
    setCheckError(null);
    setBusy(true);
    try {
      const res = await backendJson<FundingCheck>("/funding-arb/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market_id: row.marketId,
          symbol: row.symbol,
          hourly_rate: Math.abs(row.rate),
          // Знак ставки = кто платит: положительная — лонги платят шортам, и тогда
          // стратегия «шорт перпа + лонг спота» работает. Отрицательная — наоборот,
          // и бэкенд честно вернёт opportunity: null.
          direction: row.rate > 0 ? "long" : row.rate < 0 ? "short" : "none",
          min_annualized_yield: minApy / 100,
        }),
      });
      setCheck(res);
    } catch (e) {
      setCheck(null);
      // Ответ бэкенда и его отсутствие — разные ответы. До этой строки catch писал
      // тот же null, что и «возможности нет», и панель на неудачном запросе
      // печатала «APR 3416.4% ниже порога 5%» — про собственную же строку таблицы
      // это заведомо неверное утверждение.
      setCheckError(errorText(e));
      setToast(`Проверка не прошла: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runSizing(row: Row) {
    if (!row.spot || !row.perp) {
      setToast(`Для ${row.symbol} нет спот-двойника — вторую ногу построить нечем`);
      return;
    }
    if (!(capital > 0)) {
      setToast("Капитал должен быть больше нуля: на каждую ногу берётся половина суммы");
      return;
    }
    setBusy(true);
    try {
      const candles = await getCandles(row.marketId, "1h", 2);
      const price = candles[candles.length - 1]?.c;
      if (!price) throw new Error("нет цены в свечах");
      const plan = await backendJson<FundingSizing>("/funding-arb/size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capital_usd: capital,
          price,
          perp_size_decimals: row.perp.supported_size_decimals,
          spot_size_decimals: row.spot.supported_size_decimals,
          perp_min_base_amount: Number(row.perp.min_base_amount),
          spot_min_base_amount: Number(row.spot.min_base_amount),
        }),
      });
      setSizing({ ...plan, price });
    } catch (e) {
      setSizing(null);
      setToast(`Расчёт размера не прошёл: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header terminal-header--stack">
          <div className="panel-head-row">
            <h2 className="section-title">Funding и carry</h2>
            <button
              onClick={() => {
                void getFundingRates()
                  .then((r) => {
                    setRates(r);
                    // Баннер ошибки обязан гаснуть и здесь: прежний .then(setRates)
                    // оставлял «funding-rates не ответили» над уже загрузившейся
                    // таблицей, и по этому баннеру нельзя было понять, живые цифры
                    // перед человеком или протухшие.
                    setLoadError(null);
                  })
                  .catch((e) => setLoadError(errorText(e)));
              }}
              className="btn-ghost push-right"
            >
              <RefreshCw size={12} aria-hidden="true" /> обновить
            </button>
          </div>
          <p className="panel-lead">
            Реальные ставки funding со всех площадок — GET /api/v1/funding-rates. Шорт перпа + лонг спота того же актива: дельта-нейтрально, доход от ставки.
            Знак — это кто платит: положительная ставка означает, что funding платят лонги и забирают его шорты перпа; отрицательная — наоборот, и cash-and-carry
            без займа на таком рынке не строится. Колонки чужих площадок — ставка за ИХ эпоху выплат, а не за час: у Lighter эпох час (подтверждено живым API),
            у остальных свой интервал, поэтому рядом эти числа читать как «кто платит больше» нельзя.
          </p>
        </div>

        <div className="terminal-header">
          <button
            onClick={() => setOnlyDeltaNeutral((v) => !v)}
            aria-pressed={onlyDeltaNeutral}
            className={`chip chip-btn chip-btn--wrap${onlyDeltaNeutral ? " chip-info" : ""}`}
            title="Отобрать рынки, где на Lighter есть и перп, и спот того же стейбла — только там нога строится"
          >
            только там, где есть и перп, и спот
          </button>
          <label htmlFor="funding-min-apy" className="row">
            <Percent size={12} aria-hidden="true" />
            <span className="label">порог APR</span>
            <input
              id="funding-min-apy"
              type="number"
              value={minApy}
              onChange={(e) => {
                // valueAsNumber: у очищенного поля Number("") = 0, а у «-» это
                // NaN, и фильтр Math.abs(apy) >= NaN не проходит ни для одной
                // строки — таблица пустела без единого объяснения.
                const raw = e.target.valueAsNumber;
                setMinApy(Number.isFinite(raw) ? Math.max(0, raw) : 0);
              }}
              className="input-mono input-num"
            />
            <span className="muted">%</span>
          </label>
          <span className="section-note push-right">
            ставок: {rates ? rates.length : "—"}, перпов Lighter: {rows.length}
            {rates != null && visible.length < rows.length ? `, показано ${visible.length}` : ""}
          </span>
        </div>

        {loadError && (
          <div className="notice notice-warn">
            funding-rates не ответили: <span className="num">{loadError}</span>
          </div>
        )}

        <div className="terminal-panel table-scroll">
          <table className="data-table data-table--fit" aria-label="Ставки funding по площадкам">
            <thead>
              <tr>
                <th scope="col">Актив</th>
                <th scope="col">Lighter<div className="sub-label">%/час</div></th>
                <th scope="col">APR</th>
                <th scope="col">Binance<div className="sub-label">%/эпоху</div></th>
                <th scope="col">Bybit<div className="sub-label">%/эпоху</div></th>
                <th scope="col">Hyperliquid<div className="sub-label">%/эпоху</div></th>
                <th scope="col">
                  Arcus
                  {arcusError && <div className="sub-label text-negative">ошибка загрузки</div>}
                </th>
                <th scope="col">Спот-нога</th>
                <th scope="col"><span className="sr-only">Действия</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const ref = (name: string) => r.reference.find((x) => x.exchange === name)?.rate;
                return (
                  <tr key={r.marketId}>
                    <td>
                      {r.symbol}
                      {r.perp == null && <span className="sub-label"> · нет перпа</span>}
                    </td>
                    <td className={`right num ${r.rate >= 0 ? "text-positive" : "text-negative"}`}>
                      {(r.rate * 100).toFixed(4)}
                    </td>
                    <td className="right num">{r.apy >= 0 ? "+" : ""}{r.apy.toFixed(1)}%</td>
                    {["binance", "bybit", "hyperliquid"].map((exch) => (
                      <td key={exch} className="right num muted">
                        {ref(exch) == null ? "—" : (ref(exch)! * 100).toFixed(4)}
                      </td>
                    ))}
                    <td className="right">
                      {arcusPerps.some((p) => p.baseAsset === r.symbol) ? (
                        <span className="text-positive">есть перп</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {r.spot ? <span className="num">{r.spot.symbol}</span> : <span className="muted">—</span>}
                    </td>
                    <td className="right">
                      <button
                        onClick={() => void runCheck(r)}
                        disabled={r.perp == null || busy}
                        className="link-action"
                        title={r.perp == null ? "Нет активной книги перпа — проверять нечего" : undefined}
                      >
                        проверить <ArrowUpRight size={12} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rates != null && visible.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <p className="picker-empty">
                      Под текущий порог ({minApy}% APR) ничего не подходит.
                    </p>
                  </td>
                </tr>
              )}
              {rates == null &&
                [0, 1, 2, 3, 4].map((i) => (
                  <tr key={i}>
                    <td colSpan={9}>
                      <Skeleton height="16px" />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="terminal-panel panel-pad">
            <div className="row-between">
              <span className="label">{selected.symbol} · market_id {selected.marketId}</span>
              <span className="section-note">POST /funding-arb/check · /funding-arb/size</span>
            </div>

            {check?.opportunity ? (
              <div className="desk-stats">
                <div className="desk-stat">
                  <span className="label">Нога перпа</span>
                  <b className="text-negative">{check.opportunity.perp_side}</b>
                </div>
                <div className="desk-stat">
                  <span className="label">Нога спота</span>
                  <b className="text-positive">{check.opportunity.spot_needed ? "buy" : "не нужна"}</b>
                </div>
                <div className="desk-stat">
                  <span className="label">APR простая</span>
                  <b>{(check.opportunity.annualized_yield * 100).toFixed(1)}%</b>
                </div>
                <div className="desk-stat">
                  <span className="label">Ставка за час</span>
                  <b>{(check.opportunity.hourly_rate * 100).toFixed(4)}%</b>
                </div>
              </div>
            ) : busy ? (
              <p className="panel-lead">Проверяю market_id {selected.marketId} на бэкенде…</p>
            ) : checkError ? (
              <div className="notice notice-error">
                Проверка не прошла: <span className="num">{checkError}</span>. Ответа нет, поэтому вывода тоже нет —
                ниже только форма расчёта ног.
              </div>
            ) : (
              /* Две формулировки — ровно два ответа find_opportunity с
                 opportunity: null (направление не «long», APR ниже порога);
                 третьего branch там нет, поэтому и здесь не выдумываем. */
              <p className="panel-lead">
                {selected.rate < 0
                  ? "Отрицательный funding: платят шорты, а лонгам. Симметричная нога требовала бы займа базового актива."
                  : `APR ${Math.abs(selected.apy).toFixed(1)}% ниже порога ${minApy}%.`}
              </p>
            )}

            <div className="stack">
              <label htmlFor="carry-capital" className="label">Капитал на обе ноги, USD</label>
              <div className="row">
                <div className="field-box">
                  <span className="muted">$</span>
                  <input
                    id="carry-capital"
                    type="number"
                    min={0}
                    value={capital}
                    onChange={(e) => {
                      // Тот же valueAsNumber, что у порога APR выше: у «-» и «1e»
                      // Number(...) даёт NaN, и NaN уходил в capital_usd — бэкенд
                      // отвечал 422, а в панели стояла пустая строка вместо числа.
                      const raw = e.target.valueAsNumber;
                      setCapital(Number.isFinite(raw) ? Math.max(0, raw) : 0);
                    }}
                    className="input-mono input-num"
                  />
                </div>
                <button
                  onClick={() => void runSizing(selected)}
                  disabled={busy || !selected.spot}
                  className="btn-primary"
                >
                  {busy ? "Считаю…" : "Разложить по ногам"}
                </button>
                {!selected.spot && <span className="chip chip-warn">нет спот-двойника</span>}
              </div>
            </div>

            {sizing?.position && (
              <>
                <div className="desk-stats">
                  <div className="desk-stat">
                    <span className="label">Перп, notional</span>
                    <b>${fmt(sizing.position.perp_notional_usd, 2)}</b>
                  </div>
                  <div className="desk-stat">
                    <span className="label">Спот, notional</span>
                    <b>${fmt(sizing.position.spot_notional_usd, 2)}</b>
                  </div>
                  <div className="desk-stat">
                    <span className="label">Перп, базовая</span>
                    <b>{sizing.position.perp_base_amount}</b>
                  </div>
                  <div className="desk-stat">
                    <span className="label">Спот, базовая</span>
                    <b>{sizing.position.spot_base_amount}</b>
                  </div>
                </div>
                <p className="fineprint">
                  Округление вниз по <code>supported_size_decimals</code> обеих ног, цена — последняя 1h-свеча: ${fmt(sizing.price ?? 0, 4)}
                </p>
              </>
            )}
            {sizing && !sizing.position && (
              <div className="notice notice-warn">{sizing.reason}</div>
            )}
          </div>
        )}

        <div className="terminal-panel panel-pad">
          <div className="label">Откуда цифры</div>
          <div className="stack">
            <p className="fineprint">
              <b>Ставки</b> — GET /api/v1/funding-rates: строки <code>{`{market_id, exchange, symbol, rate}`}</code> для binance, bybit, hyperliquid и lighter по одному market_id.
            </p>
            <p className="fineprint">
              <b>APR</b> — ставка × 24 × 365. Эпоха funding у Lighter — 1 час, а не 8, как у большей части бирж.
            </p>
            <p className="fineprint">
              <b>Размер ног</b> — минимальные base-суммы и decimals берутся из <code>/orderBooks</code>, capital/2 на ногу, округление вниз.
            </p>
            <p className="fineprint">
              <b>Что это не даёт</b> ни гарантии, что ставка продержится час, ни защиты от depeg спота. Funding меняется — данные обновляются раз в минуту.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
