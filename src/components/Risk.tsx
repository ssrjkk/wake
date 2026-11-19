import { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { getCandles, isTradeable, openInterestUsd, type OrderBook } from "../lib/lighter";
import { alignHourlyReturns } from "../lib/series";
import { backendJson, errorText } from "../lib/backend";
import { usd } from "./utils";
import { Modal } from "./ui";
import type { RiskAnalysis, HedgeSuggestion, RiskPosition } from "./types";

interface RiskProps {
  markets: OrderBook[];
  setToast: (toast: string | null) => void;
}

export default function Risk({ markets, setToast }: RiskProps) {
  const [riskPositions, setRiskPositions] = useState<RiskPosition[]>([]);
  const [riskPickerOpen, setRiskPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [riskResult, setRiskResult] = useState<RiskAnalysis | null>(null);
  const [hedgeResult, setHedgeResult] = useState<{ target: RiskPosition; suggestion: HedgeSuggestion | null } | null>(null);
  const [hedgeTarget, setHedgeTarget] = useState(0);
  const [riskBusy, setRiskBusy] = useState(false);

  // Поиск по списку: сотни живых рынков и «первые 60 в порядке книги» — это не
  // выбор, а лотерея. Cap оставлен, но считается уже по совпадениям.
  const pickerMatches = (() => {
    const q = pickerQuery.trim().toUpperCase();
    const base = q ? markets.filter((m) => m.symbol.toUpperCase().includes(q)) : markets;
    return base.slice(0, 60);
  })();

  function addRiskPosition(m: OrderBook, side: "long" | "short") {
    setRiskPositions((p) => [...p, { marketId: m.market_id, symbol: m.symbol, notionalUsd: 1000, side }]);
    setRiskPickerOpen(false);
    setPickerQuery("");
  }

  function removeRiskPosition(i: number) {
    setRiskPositions((p) => p.filter((_, idx) => idx !== i));
    setRiskResult(null);
    setHedgeResult(null);
  }

  async function analyzePortfolioRisk() {
    if (riskPositions.length < 1) {
      setToast("Добавь хотя бы одну позицию");
      return;
    }
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      // Свечи независимых рынков читаются параллельно: последовательный цикл на
      // корзине из пяти позиций это пять сетевых RTT подряд.
      const series = await Promise.all(
        riskPositions.map(async (pos) => ({
          marketId: pos.marketId,
          candles: await getCandles(pos.marketId, "1h", 30),
        }))
      );
      // Ряды приводятся к общим ЧАСАМ (lib/series.ts), а не к одинаковой длине
      // массива: бэкенд выравнивает по индексам, и сдвиг на один пропущенный
      // час считал бы корреляцию BTC против других суток.
      const aligned = alignHourlyReturns(series);
      if (aligned.hours.length < 2) {
        setToast(
          aligned.skipped.length
            ? `Нет данных хотя бы по двум часам у всех рынков корзины; без свечей: ${aligned.skipped.join(", ")}`
            : "Нет двух общих часов между рынками корзины — корреляцию считать не по чему"
        );
        return;
      }
      const returnsByMarket: Record<string, number[]> = Object.fromEntries(
        [...aligned.returns.entries()].map(([id, returns]) => [String(id), returns])
      );

      setRiskResult(await backendJson<RiskAnalysis>("/portfolio/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: riskPositions.map((p) => ({
            market_id: p.marketId,
            symbol: p.symbol,
            signed_notional_usd: p.side === "long" ? p.notionalUsd : -p.notionalUsd,
          })),
          returns_by_market: returnsByMarket,
        }),
      }));
    } catch (e) {
      setToast(`Анализ риска недоступен: ${errorText(e)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  async function findHedge() {
    if (riskPositions.length === 0) return;
    // Цель хеджа выбирается явно и подписана в карточке результата: молча хеджировать
    // riskPositions[0] значило бы, что при пяти позициях человек получал предложение
    // для первой из них, никак об этом не узнав.
    const target = riskPositions[Math.min(hedgeTarget, riskPositions.length - 1)];
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      // Вселенная кандидатов — 15 рынков с наибольшим открытым интересом в
      // долларах, а не «первые 15 по индексу книги»: best hedge зависел от того,
      // какие строки Lighter вернул раньше, и в списке без ликвидного контрагента
      // предложение было бы недостижимым. Interest считается из строки книги один
      // раз, а не по два раза на каждое сравнение.
      const pool = markets
        .filter(isTradeable)
        .map((m) => ({ market: m, interest: openInterestUsd(m) }))
        .filter((row) => row.interest > 0)
        .sort((a, b) => b.interest - a.interest)
        .slice(0, 15)
        .map((row) => row.market);
      const series = await Promise.all(
        pool.map(async (m) => ({
          marketId: m.market_id,
          candles: await getCandles(m.market_id, "1h", 30),
        }))
      );
      const aligned = alignHourlyReturns(series);
      if (aligned.hours.length < 2) {
        setToast("По кандидатам нет двух общих часов свечей — сравнивать нечего");
        return;
      }
      const returnsByMarket: Record<string, number[]> = {};
      const candidates: [number, string][] = [];
      for (const [id, returns] of aligned.returns) {
        returnsByMarket[String(id)] = returns;
        if (id !== target.marketId) {
          const symbol = pool.find((m) => m.market_id === id)?.symbol ?? `#${id}`;
          candidates.push([id, symbol]);
        }
      }
      const data = await backendJson<{ suggestion: HedgeSuggestion | null }>("/portfolio/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { market_id: target.marketId, symbol: target.symbol, signed_notional_usd: target.side === "long" ? target.notionalUsd : -target.notionalUsd },
          candidates,
          returns_by_market: returnsByMarket,
        }),
      });
      // Цель запоминается вместе с предложением: если человек после расчёта
      // переключит селектор, карточка не должна начинать врать, к кому она.
      setHedgeResult({ target, suggestion: data.suggestion });
    } catch (e) {
      setToast(`Поиск хеджа недоступен: ${errorText(e)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  return (
    <div className="terminal-layout terminal-stack">
      <div className="terminal-main">
        <div className="terminal-header terminal-header--stack">
          <h2 className="section-title">Риск корзины</h2>
          <p className="panel-lead">
            Единая маржа Lighter: риск считается по всему набору позиций разом, а не по одной ноге. Выбираешь позиции из{" "}
            {markets.length ? `${markets.length} живых рынков ` : "списка живых рынков "}
            Lighter во вкладке «Терминал» — корреляции считаются по их часовым свечам.
          </p>
        </div>

        <div className="terminal-panel panel-pad">
          <div className="row-between">
            <span className="stat-label">Позиции для анализа</span>
            <button onClick={() => setRiskPickerOpen(true)} className="btn-ghost">
              + Добавить
            </button>
          </div>
          {riskPositions.length === 0 ? (
            <p className="list-empty">Добавь хотя бы одну позицию с разных рынков, чтобы увидеть эффект диверсификации</p>
          ) : (
            <div className="stack">
              {riskPositions.map((p, i) => (
                <div key={`${p.marketId}:${p.side}`} className="list-row">
                  <div className="row">
                    <span className={`stat-label ${p.side === "long" ? "text-positive" : "text-negative"}`}>{p.side === "long" ? "LONG" : "SHORT"}</span>
                    <span className="cell-name">{p.symbol}</span>
                  </div>
                  <div className="row">
                    <input
                      type="number"
                      aria-label={`Нотионал позиции ${p.symbol}, USD`}
                      min={0}
                      step={100}
                      value={p.notionalUsd}
                      onChange={(e) => {
                        const raw = e.target.valueAsNumber;
                        const v = Number.isFinite(raw) ? raw : 0;
                        setRiskPositions((arr) => arr.map((x, idx) => (idx === i ? { ...x, notionalUsd: v } : x)));
                      }}
                      className="input-mono input-num"
                    />
                    <button onClick={() => removeRiskPosition(i)} aria-label="Удалить позицию" className="icon-btn">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {riskPositions.length > 0 && (
            <div className="row">
              <button
                onClick={() => void analyzePortfolioRisk()}
                disabled={riskBusy}
                className="btn-primary btn-grow"
              >
                {riskBusy ? (
                  <span className="label-row">
                    <Loader2 size={14} className="spinner" />
                    Считаю на реальных свечах…
                  </span>
                ) : "Проанализировать"}
              </button>
              {riskPositions.length > 1 && (
                <label className="label-row muted">
                  хедж для
                  <select
                    aria-label="Позиция, для которой ищется хедж"
                    value={Math.min(hedgeTarget, riskPositions.length - 1)}
                    onChange={(e) => setHedgeTarget(Number(e.target.value))}
                    className="input-mono"
                  >
                    {riskPositions.map((p, i) => (
                      <option key={`${p.marketId}:${i}`} value={i}>
                        {p.symbol} · {p.side}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                onClick={() => void findHedge()}
                disabled={riskBusy || riskPositions.length < 1}
                className="btn-ghost btn-grow"
              >
                Найти хедж
              </button>
            </div>
          )}
        </div>

      {riskResult && (
        <div className="terminal-panel panel-pad">
          <div className="stat-label">Результат</div>
          <div className="desk-stats">
            <div className="desk-stat desk-stat-lg">
              <span className="label">Наивная сумма риска</span>
              <b>{usd(riskResult.naive_dollar_volatility, 0)}</b>
            </div>
            <div className="desk-stat desk-stat-lg">
              <span className="label">Реальный риск портфеля</span>
              <b className="text-info">{usd(riskResult.portfolio_dollar_volatility, 0)}</b>
            </div>
          </div>
          <div className="market-prob">
            <div className="prob-bar">
              <i style={{ width: `${Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}%` }} />
            </div>
            <span className="stat-value secondary">{Math.min(100, Math.max(0, riskResult.diversification_score * 100)).toFixed(0)}% диверсификация</span>
          </div>
        </div>
      )}

      {hedgeResult && (
        <div className="terminal-panel panel-pad panel-warn">
          <div className="stat-label">
            Хедж к {hedgeResult.target.symbol} ({hedgeResult.target.side})
          </div>
          {hedgeResult.suggestion ? (
            <div className="stack">
              <p className="primary-line">
                {hedgeResult.suggestion.hedge_notional_usd < 0 ? "Short" : "Long"}{" "}
                <span className="num">
                  {usd(Math.abs(hedgeResult.suggestion.hedge_notional_usd), 0)}
                </span>{" "}
                {hedgeResult.suggestion.symbol}
              </p>
              <p className="muted">
                Корреляция {(hedgeResult.suggestion.correlation_to_target * 100).toFixed(0)}% · риск позиции{" "}
                <span className="num">{usd(hedgeResult.suggestion.unhedged_vol_usd, 0)}</span> → с хеджем{" "}
                <span className="num text-positive">
                  {usd(hedgeResult.suggestion.resulting_portfolio_vol_usd, 0)}
                </span>{" "}
                на час
              </p>
            </div>
          ) : (
            <p className="muted">
              Среди 15 рынков с наибольшим открытым интересом нет такого, рядом с которым риск этой позиции снижается.
            </p>
          )}
        </div>
      )}

      {riskPickerOpen && (
        <Modal label="Добавить позицию" onClose={() => setRiskPickerOpen(false)}>
          <div className="overlay-shell" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <h3>Добавить позицию</h3>
              <button
                onClick={() => setRiskPickerOpen(false)}
                className="overlay-close"
                aria-label="Закрыть"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              data-autofocus=""
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              placeholder="Поиск по символу…"
              aria-label="Поиск рынка для добавления"
              className="input-mono w-full"
            />
            <div className="picker-list">
              {pickerMatches.length === 0 && (
                <p className="muted picker-empty">
                  {markets.length === 0 ? "Рынки ещё загружаются" : `По «${pickerQuery}» совпадений нет`}
                </p>
              )}
              {pickerMatches.map((m) => (
                <div key={m.market_id} className="list-row">
                  <span className="primary-line">{m.symbol}</span>
                  <div className="row">
                    <button onClick={() => addRiskPosition(m, "long")} className="btn-primary btn-up">
                      Long
                    </button>
                    {m.market_type === "perp" && (
                      <button onClick={() => addRiskPosition(m, "short")} className="btn-primary btn-down">
                        Short
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
      </div>
    </div>
  );
}
