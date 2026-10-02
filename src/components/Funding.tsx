import { useState, useEffect, useMemo } from "react";
import { RefreshCw, Percent, ArrowUpRight } from "lucide-react";
import { getFundingRates, getCandles, type FundingRateRow, type OrderBook } from "../lib/lighter";
import { backendJson, errorText } from "../lib/backend";
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

export function Funding({ markets, setToast }: FundingProps) {
  const [rates, setRates] = useState<FundingRateRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlyDeltaNeutral, setOnlyDeltaNeutral] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);
  const [capital, setCapital] = useState(2000);
  const [minApy, setMinApy] = useState(5);
  const [check, setCheck] = useState<any>(null);
  const [sizing, setSizing] = useState<any>(null);
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
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
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
    const perpById = new Map(markets.filter((m) => m.market_type === "perp").map((m) => [m.market_id, m]));
    const spotByBase = new Map(markets.filter((m) => m.market_type === "spot").map((m) => [m.symbol.split("/")[0], m]));

    const out: Row[] = [];
    for (const [marketId, entry] of byMarket) {
      const lighter = entry.lighter;
      if (!lighter) continue;
      const perp = perpById.get(marketId) ?? null;
      out.push({
        marketId,
        symbol: lighter.symbol,
        rate: lighter.rate,
        apy: lighter.rate * HOURS_PER_YEAR * 100,
        reference: entry.ref.map((r) => ({ exchange: r.exchange, rate: r.rate })),
        spot: spotByBase.get(lighter.symbol) ?? null,
        perp,
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
    setBusy(true);
    try {
      setCheck(await backendJson("/funding-arb/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market_id: row.marketId,
          symbol: row.symbol,
          hourly_rate: Math.abs(row.rate),
          // Знак ставки = кто платит: положительная — лонги платят шортам, и тогда
          // стратегия «шорт перпа + лонг спота» работает. Отрицательная — наоборот,
          // и бэкенд честно вернёт opportunity: null.
          direction: row.rate >= 0 ? "long" : "short",
          min_annualized_yield: minApy / 100,
        }),
      }));
    } catch (e) {
      setCheck(null);
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
    setBusy(true);
    try {
      const candles = await getCandles(row.marketId, "1h", 2);
      const price = candles[candles.length - 1]?.c;
      if (!price) throw new Error("нет цены в свечах");
      const plan = await backendJson<Record<string, unknown>>("/funding-arb/size", {
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
    <div>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-semibold">Funding Arbitrage</h2>
          <p className="text-slate-500 text-sm">
            Реальные ставки funding со всех площадок одним запросом — GET /api/v1/funding-rates. Шорт перпа + лонг спота
            того же актива: дельта-нейтрально, доход идёт от ставки, а не от направления цены.
          </p>
        </div>
        <button
          onClick={() => getFundingRates().then(setRates).catch((e) => setLoadError(errorText(e)))}
          className="shrink-0 flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 border border-slate-800 rounded-full px-3 py-1.5 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" /> обновить
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <input
            type="checkbox"
            checked={onlyDeltaNeutral}
            onChange={(e) => setOnlyDeltaNeutral(e.target.checked)}
            className="accent-cyan-500"
          />
          только там, где на Lighter есть и перп, и спот
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <Percent className="w-3.5 h-3.5" />
          порог APR
          <input
            type="number"
            value={minApy}
            onChange={(e) => setMinApy(Number(e.target.value))}
            className="w-16 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white font-mono text-xs outline-none"
          />
          %
        </label>
        <span className="text-xs text-slate-600">
          ставок в ответе: {rates ? rates.length : "—"}, перпов Lighter с funding: {rows.length}
        </span>
      </div>

      {loadError && (
        <div className="bg-slate-900 border border-amber-800 rounded-2xl p-3 mb-3 text-xs text-amber-300">
          funding-rates не ответили: {loadError}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden mb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
              <th className="px-4 py-2 font-normal">Актив</th>
              <th className="px-2 py-2 font-normal text-right">Lighter, %/час</th>
              <th className="px-2 py-2 font-normal text-right">APR</th>
              <th className="px-2 py-2 font-normal text-right">Binance</th>
              <th className="px-2 py-2 font-normal text-right">Bybit</th>
              <th className="px-2 py-2 font-normal text-right">Hyperliquid</th>
              <th className="px-2 py-2 font-normal">Спот-нога</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const ref = (name: string) => r.reference.find((x) => x.exchange === name)?.rate;
              return (
                <tr key={r.marketId} className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40 transition-colors">
                  <td className="px-4 py-2 text-slate-100 font-medium">
                    {r.symbol}
                    {r.perp == null && <span className="text-slate-600 text-xs ml-1.5">нет перпа в /orderBooks</span>}
                  </td>
                  <td className={`px-2 py-2 text-right font-mono ${r.rate >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {(r.rate * 100).toFixed(4)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">{r.apy >= 0 ? "+" : ""}{r.apy.toFixed(1)}%</td>
                  {["binance", "bybit", "hyperliquid"].map((exch) => (
                    <td key={exch} className="px-2 py-2 text-right font-mono text-slate-500">
                      {ref(exch) != null ? `${(ref(exch)! * 100).toFixed(4)}` : "—"}
                    </td>
                  ))}
                  <td className="px-2 py-2">
                    {r.spot ? (
                      <span className="text-xs text-cyan-400">{r.spot.symbol}</span>
                    ) : (
                      <span className="text-xs text-slate-700">—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => runCheck(r)}
                      disabled={r.perp == null || busy}
                      className="text-xs text-cyan-400 hover:text-cyan-300 disabled:text-slate-700 flex items-center gap-1 ml-auto transition-colors"
                    >
                      проверить <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rates != null && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-600 text-sm">
                  Под текущий порог ({minApy}% APR) ничего не подходит — понизь порог или сними фильтр по спот-ноге.
                </td>
              </tr>
            )}
            {rates == null &&
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-slate-800/60">
                  <td colSpan={8} className="px-4 py-2">
                    <div className="h-4 bg-slate-800 rounded animate-pulse" />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs text-slate-500 uppercase tracking-wide">
              {selected.symbol} · market_id {selected.marketId}
            </span>
            <span className="text-xs text-slate-600">POST /funding-arb/check · /funding-arb/size</span>
          </div>

          {check?.opportunity ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div>
                <div className="text-slate-500 text-xs mb-1">Нога перпа</div>
                <div className="text-red-400 font-mono text-sm uppercase">{check.opportunity.perp_side}</div>
              </div>
              <div>
                <div className="text-slate-500 text-xs mb-1">Нога спота</div>
                <div className="text-emerald-400 font-mono text-sm">{check.opportunity.spot_needed ? "buy" : "не нужна"}</div>
              </div>
              <div>
                <div className="text-slate-500 text-xs mb-1">APR простая</div>
                <div className="text-white font-mono text-sm">{(check.opportunity.annualized_yield * 100).toFixed(1)}%</div>
              </div>
              <div>
                <div className="text-slate-500 text-xs mb-1">Ставка за час</div>
                <div className="text-white font-mono text-sm">{(check.opportunity.hourly_rate * 100).toFixed(4)}%</div>
              </div>
            </div>
          ) : (
            !busy && (
              <p className="text-slate-500 text-sm mb-4">
                {selected.rate < 0
                  ? `Отрицательный funding: платят шорты, а лонгам. Симметричная нога требовала бы займа базового актива, а его на Lighter нет — бэкенд не притворяется, что он есть.`
                  : `APR ${(Math.abs(selected.apy)).toFixed(1)}% ниже порога ${minApy}% — связка двух ног не окупает операционную сложность.`}
              </p>
            )
          )}

          <div className="border-t border-slate-800 pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Капитал на обе ноги, USD</label>
                <div className="flex items-center bg-slate-950 border border-slate-700 rounded-xl px-3 py-2">
                  <span className="text-slate-500 mr-1">$</span>
                  <input
                    type="number"
                    value={capital}
                    onChange={(e) => setCapital(Number(e.target.value))}
                    className="bg-transparent text-white font-mono outline-none w-28"
                  />
                </div>
              </div>
              <button
                onClick={() => runSizing(selected)}
                disabled={busy || !selected.spot}
                className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:hover:bg-cyan-500 text-slate-950 text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
              >
                {busy ? "Считаю…" : "Разложить по ногам"}
              </button>
              {!selected.spot && <span className="text-xs text-amber-400">нет спот-двойника — дельта-нейтральность построить нечем</span>}
            </div>

            {sizing?.position && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                <div>
                  <div className="text-slate-500 text-xs mb-1">Перп, notional</div>
                  <div className="text-white font-mono text-sm">${fmt(sizing.position.perp_notional_usd, 2)}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs mb-1">Спот, notional</div>
                  <div className="text-white font-mono text-sm">${fmt(sizing.position.spot_notional_usd, 2)}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs mb-1">Перп, базовая</div>
                  <div className="text-white font-mono text-sm">{sizing.position.perp_base_amount}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs mb-1">Спот, базовая</div>
                  <div className="text-white font-mono text-sm">{sizing.position.spot_base_amount}</div>
                </div>
                <div className="col-span-2 md:col-span-4 text-xs text-slate-600">
                  Округление вниз по supported_size_decimals обеих ног, цена — последняя 1h-свеча: ${fmt(sizing.price, 4)}
                </div>
              </div>
            )}
            {sizing && !sizing.position && (
              <p className="text-xs text-amber-400 mt-3">{sizing.reason}</p>
            )}
          </div>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Откуда цифры</div>
        <div className="space-y-2 text-sm text-slate-400">
          <p>
            <span className="text-slate-200">Ставки</span> — GET /api/v1/funding-rates: строки {`{market_id, exchange, symbol, rate}`}
            для binance, bybit, hyperliquid и lighter по одному market_id. Колонки площадок рядом с Lighter — это тот же market_id,
            так что сравнивать ставки корректно.
          </p>
          <p>
            <span className="text-slate-200">APR</span> — ставка × 24 × 365. Эпоха funding у Lighter — 1 час, а не 8, как у
            большей части бирж; перепутать это значит занижать доходность в восемь раз (считает backend/funding_arb.py).
          </p>
          <p>
            <span className="text-slate-200">Размер ног</span> — минимальные base-суммы и decimals берутся из /orderBooks по
            конкретной паре, а не из головы: capital/2 на ногу, округление вниз, и если на минималки обеих ног не хватает —
            бэкенд отвечает причиной, а не красивым нулём.
          </p>
          <p>
            <span className="text-slate-200">Что это не даёт</span> ни гарантии, что ставка продержится час, ни защиты от
            деpeg спота, ни ликвидности в нужный момент. Funding меняется — поэтому данные обновляются раз в минуту.
          </p>
        </div>
      </div>
    </div>
  );
}
