import { useState, useEffect, useMemo } from "react";
import { RefreshCw, Percent, ArrowUpRight } from "lucide-react";
import { getFundingRates, getCandles, type FundingRateRow, type OrderBook } from "../lib/lighter";
import { getMarkets as getArcusMarkets, isArcusPerp, type ArcusMarket } from "../lib/arcus";
import { backendJson, errorText } from "../lib/backend";
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
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
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
      setCheck(await backendJson<FundingCheck>("/funding-arb/check", {
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
    <div className="terminal-layout" style={{ gridTemplateColumns: "1fr", height: "auto" }}>
      <div className="terminal-main">
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%" }}>
            <h2 style={{ fontSize: "16px", fontWeight: 600, color: "#fafafa", margin: 0 }}>Funding Arbitrage</h2>
            <button
              onClick={() => {
                void getFundingRates().then(setRates).catch((e) => setLoadError(errorText(e)));
              }}
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "#888", background: "transparent", border: "1px solid #2a2a2a", borderRadius: "4px", padding: "6px 10px", cursor: "pointer" }}
            >
              <RefreshCw style={{ width: "12px", height: "12px" }} /> обновить
            </button>
          </div>
          <p style={{ fontSize: "12px", color: "#666", margin: "8px 0 0 0", maxWidth: "800px" }}>
            Реальные ставки funding со всех площадок — GET /api/v1/funding-rates. Шорт перпа + лонг спота того же актива: дельта-нейтрально, доход от ставки.
          </p>
        </div>

      <div className="terminal-header" style={{ gap: "16px", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "#ccc", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={onlyDeltaNeutral}
            onChange={(e) => setOnlyDeltaNeutral(e.target.checked)}
            style={{ accentColor: "#3b82f6" }}
          />
          только там, где есть и перп, и спот
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "#ccc" }}>
          <Percent style={{ width: "12px", height: "12px" }} />
          порог APR
          <input
            type="number"
            value={minApy}
            onChange={(e) => setMinApy(Number(e.target.value))}
            style={{ width: "60px", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "4px 8px", color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px" }}
          />
          %
        </label>
        <span style={{ fontSize: "11px", color: "#666", marginLeft: "auto" }}>
          ставок: {rates ? rates.length : "—"}, перпов Lighter: {rows.length}
        </span>
      </div>

      {loadError && (
        <div className="terminal-header" style={{ color: "#fbbf24", fontSize: "12px" }}>
          funding-rates не ответили: {loadError}
        </div>
      )}

      <div style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: "6px", overflow: "hidden" }}>
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", minWidth: "700px" }}>
          <thead>
            <tr style={{ textAlign: "left", fontSize: "11px", color: "#666", borderBottom: "1px solid #1e1e1e" }}>
              <th style={{ padding: "10px 16px", fontWeight: 500 }}>Актив</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Lighter, %/час</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>APR</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Binance</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Bybit</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>Hyperliquid</th>
              <th style={{ padding: "10px 8px", fontWeight: 500, textAlign: "right" }}>
                Arcus{arcusError && <span style={{ color: "#ef4444", fontSize: "10px", display: "block", fontWeight: 400 }}>ошибка загрузки</span>}
              </th>
              <th style={{ padding: "10px 8px", fontWeight: 500 }}>Спот-нога</th>
              <th style={{ padding: "10px 8px" }}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const ref = (name: string) => r.reference.find((x) => x.exchange === name)?.rate;
              return (
                <tr key={r.marketId} style={{ borderBottom: "1px solid #1a1a1a", transition: "background 0.1s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#1a1a1a"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <td style={{ padding: "8px 16px", color: "#fafafa", fontWeight: 500 }}>
                    {r.symbol}
                    {r.perp == null && <span style={{ color: "#666", fontSize: "10px", marginLeft: "6px" }}>нет перпа</span>}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: r.rate >= 0 ? "#10b981" : "#ef4444" }}>
                    {(r.rate * 100).toFixed(4)}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#fafafa" }}>{r.apy >= 0 ? "+" : ""}{r.apy.toFixed(1)}%</td>
                  {["binance", "bybit", "hyperliquid"].map((exch) => (
                    <td key={exch} style={{ padding: "8px", textAlign: "right", fontFamily: "'JetBrains Mono', monospace", color: "#888" }}>
                      {ref(exch) != null ? `${(ref(exch)! * 100).toFixed(4)}` : "—"}
                    </td>
                  ))}
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    {arcusPerps.some((p) => p.baseAsset === r.symbol) ? (
                      <span style={{ fontSize: "10px", color: "#10b981" }}>есть перп</span>
                    ) : (
                      <span style={{ fontSize: "10px", color: "#666" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "8px" }}>
                    {r.spot ? (
                      <span style={{ fontSize: "10px", color: "#3b82f6" }}>{r.spot.symbol}</span>
                    ) : (
                      <span style={{ fontSize: "10px", color: "#666" }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    <button
                      onClick={() => void runCheck(r)}
                      disabled={r.perp == null || busy}
                      style={{ fontSize: "11px", color: r.perp == null || busy ? "#666" : "#3b82f6", background: "transparent", border: "none", cursor: r.perp == null || busy ? "default" : "pointer", display: "flex", alignItems: "center", gap: "4px", marginLeft: "auto" }}
                    >
                      проверить <ArrowUpRight style={{ width: "12px", height: "12px" }} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rates != null && visible.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: "16px", textAlign: "center", color: "#666", fontSize: "12px" }}>
                  Под текущий порог ({minApy}% APR) ничего не подходит.
                </td>
              </tr>
            )}
            {rates == null &&
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} style={{ borderBottom: "1px solid #1a1a1a" }}>
                  <td colSpan={9} style={{ padding: "8px" }}>
                    <div style={{ height: "16px", background: "#1a1a1a", borderRadius: "3px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        </div>
      </div>

      {selected && (
        <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", marginBottom: "12px" }}>
            <span style={{ fontSize: "10px", color: "#666", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {selected.symbol} · market_id {selected.marketId}
            </span>
            <span style={{ fontSize: "10px", color: "#666", marginLeft: "auto" }}>POST /funding-arb/check · /funding-arb/size</span>
          </div>

          {check?.opportunity ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "12px", marginBottom: "16px" }}>
              <div>
                <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Нога перпа</div>
                <div style={{ color: "#ef4444", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", textTransform: "uppercase" }}>{check.opportunity.perp_side}</div>
              </div>
              <div>
                <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Нога спота</div>
                <div style={{ color: "#10b981", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>{check.opportunity.spot_needed ? "buy" : "не нужна"}</div>
              </div>
              <div>
                <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>APR простая</div>
                <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>{(check.opportunity.annualized_yield * 100).toFixed(1)}%</div>
              </div>
              <div>
                <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Ставка за час</div>
                <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>{(check.opportunity.hourly_rate * 100).toFixed(4)}%</div>
              </div>
            </div>
          ) : (
            !busy && (
              <p style={{ color: "#888", fontSize: "12px", marginBottom: "16px" }}>
                {selected.rate < 0
                  ? `Отрицательный funding: платят шорты, а лонгам. Симметричная нога требовала бы займа базового актива.`
                  : `APR ${(Math.abs(selected.apy)).toFixed(1)}% ниже порога ${minApy}%.`}
              </p>
            )
          )}

          <div style={{ borderTop: "1px solid #1e1e1e", paddingTop: "12px", width: "100%" }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "12px" }}>
              <div>
                <label style={{ fontSize: "11px", color: "#ccc", marginBottom: "4px", display: "block" }}>Капитал на обе ноги, USD</label>
                <div style={{ display: "flex", alignItems: "center", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: "4px", padding: "8px 12px" }}>
                  <span style={{ color: "#666", marginRight: "4px" }}>$</span>
                  <input
                    type="number"
                    value={capital}
                    onChange={(e) => setCapital(Number(e.target.value))}
                    style={{ background: "transparent", color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", border: "none", outline: "none", width: "100px" }}
                  />
                </div>
              </div>
              <button
                onClick={() => void runSizing(selected)}
                disabled={busy || !selected.spot}
                style={{ background: busy || !selected.spot ? "#333" : "#3b82f6", color: "#fafafa", fontSize: "12px", fontWeight: 600, padding: "8px 16px", border: "none", borderRadius: "4px", cursor: busy || !selected.spot ? "default" : "pointer" }}
              >
                {busy ? "Считаю…" : "Разложить по ногам"}
              </button>
              {!selected.spot && <span style={{ fontSize: "11px", color: "#fbbf24" }}>нет спот-двойника</span>}
            </div>

            {sizing?.position && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "12px", marginTop: "16px" }}>
                <div>
                  <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Перп, notional</div>
                  <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>${fmt(sizing.position.perp_notional_usd, 2)}</div>
                </div>
                <div>
                  <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Спот, notional</div>
                  <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>${fmt(sizing.position.spot_notional_usd, 2)}</div>
                </div>
                <div>
                  <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Перп, базовая</div>
                  <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>{sizing.position.perp_base_amount}</div>
                </div>
                <div>
                  <div style={{ color: "#666", fontSize: "11px", marginBottom: "4px" }}>Спот, базовая</div>
                  <div style={{ color: "#fafafa", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px" }}>{sizing.position.spot_base_amount}</div>
                </div>
                <div style={{ gridColumn: "1 / -1", fontSize: "11px", color: "#666" }}>
                  Округление вниз по supported_size_decimals обеих ног, цена — последняя 1h-свеча: ${fmt(sizing.price ?? 0, 4)}
                </div>
              </div>
            )}
            {sizing && !sizing.position && (
              <p style={{ fontSize: "11px", color: "#fbbf24", marginTop: "12px" }}>{sizing.reason}</p>
            )}
          </div>
        </div>
      )}

      <div className="terminal-header" style={{ flexDirection: "column", alignItems: "flex-start" }}>
        <div style={{ fontSize: "10px", color: "#666", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "12px" }}>Откуда цифры</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", color: "#ccc" }}>
          <p style={{ margin: 0 }}>
            <span style={{ color: "#fafafa" }}>Ставки</span> — GET /api/v1/funding-rates: строки {`{market_id, exchange, symbol, rate}`} для binance, bybit, hyperliquid и lighter по одному market_id.
          </p>
          <p style={{ margin: 0 }}>
            <span style={{ color: "#fafafa" }}>APR</span> — ставка × 24 × 365. Эпоха funding у Lighter — 1 час, а не 8, как у большей части бирж.
          </p>
          <p style={{ margin: 0 }}>
            <span style={{ color: "#fafafa" }}>Размер ног</span> — минимальные base-суммы и decimals берутся из /orderBooks, capital/2 на ногу, округление вниз.
          </p>
          <p style={{ margin: 0 }}>
            <span style={{ color: "#fafafa" }}>Что это не даёт</span> ни гарантии, что ставка продержится час, ни защиты от деpeg спота. Funding меняется — данные обновляются раз в минуту.
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}
