import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { depthSpread, type OrderBookDepth } from "../lib/lighter";
import {
  buildLadder,
  bookKey,
  imbalance,
  sizeChanges,
  type BookChange,
  type BookRow,
} from "./orderBook";
import { fmt, fmtUsdCompact, stamp } from "./utils";

/* ── Стакан ─────────────────────────────────────────────────────────────────
   Панель живёт отдельно от Терминала не для порядка в файлах: у лестницы своё
   состояние между витками опроса (что изменилось, каким краем мерится полоса),
   и внутри Терминала оно перемешивалось с рендер-циклом графика и тикета.

   Порядок строк — биржевой, как в Lighter, Bybit и Hyperliquid: продажи
   перевёрнуты (худшая цена сверху, лучшая у середины), покупки идут от лучшей
   цены вниз. Середина книги и баланс сторон вынесены над прокруткой: на
   двадцати уровнях с каждой стороны лестница не влезает в панель целиком, а
   следить принято именно за best bid / best ask, а не за двадцатым уровнем.

   Числа лестницы считаются в ./orderBook: они не касаются разметки и
   проверяются без рендера. */

const share = (fraction: number) => `${(fraction * 100).toFixed(0)}%`;
const barWidth = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

interface OrderBookPanelProps {
  depth: OrderBookDepth;
  /** Знаков у цены — столько, сколько объявила площадка. */
  decimals: number;
  /** Знаков у размера — supported_size_decimals рынка, а не константа панели. */
  sizeDecimals: number;
  loading: boolean;
  /** Отказ самой книги. */
  error: string | null;
  /** Причина, по которой Lighter не ответил вообще (свечи тоже не пришли):
      стакан обязан назвать её, а не молча показать пустую лестницу. */
  unavailable: string | null;
  updated: Date | null;
}

export default function OrderBookPanel({
  depth,
  decimals,
  sizeDecimals,
  loading,
  error,
  unavailable,
  updated,
}: OrderBookPanelProps) {
  const ladder = useMemo(() => buildLadder(depth), [depth]);
  const spread = useMemo(() => depthSpread(depth), [depth]);
  const imb = imbalance(ladder);
  const empty = depth.asks.length === 0 && depth.bids.length === 0;

  /* Вспышка считается по смене данных, а не по рендеру: иначе строка мигала бы
     на любом обновлении страницы. serial нужен, чтобы повторное изменение той
     же цены проигралось заново — пока класс не меняется, браузер анимацию
     не перезапускает. */
  const previous = useRef<OrderBookDepth | null>(null);
  const [flash, setFlash] = useState<{ at: Map<string, BookChange>; serial: number }>({
    at: new Map(),
    serial: 0,
  });

  useEffect(() => {
    const at = sizeChanges(previous.current, depth);
    previous.current = depth;
    if (at.size === 0) return;
    setFlash((current) => ({ at, serial: current.serial + 1 }));
  }, [depth]);

  const rows = (list: BookRow[]) =>
    list.map((row) => {
      const change = flash.at.get(bookKey(row.side, row.price));
      return (
        <tr key={`${row.side}-${row.price}`} className={`book-row ${row.side}`}>
          <td className="num book-price">
            <i className="book-bar" style={{ "--w": barWidth(row.fraction) } as CSSProperties} aria-hidden="true" />
            <span style={{ color: row.side === "ask" ? "var(--down-hi)" : "var(--up)" }}>
              {fmt(row.price, decimals)}
            </span>
          </td>
          <td className="num right">
            <span
              key={change ? `${row.size}-${flash.serial}` : "steady"}
              className={change ? `book-flash-${change}` : undefined}
              style={{ color: "var(--fg-2)" }}
            >
              {fmt(row.size, sizeDecimals)}
            </span>
          </td>
          <td className="num right">
            <span style={{ color: "var(--fg-3)" }}>{fmtUsdCompact(row.cumQuote)}</span>
          </td>
        </tr>
      );
    });

  return (
    <div className="book-panel">
      <div className="panel-caption">
        <span className="label">Стакан · Lighter</span>
        <span className="num muted">обновлено {stamp(updated)}</span>
      </div>

      {error && empty ? (
        <p className="book-note" style={{ color: "var(--down)" }}>{error}</p>
      ) : empty ? (
        <p className="book-note">
          {loading ? "загрузка…" : unavailable ? "Заявок нет: Lighter не ответил." : "Заявок в книге нет."}
        </p>
      ) : (
        <>
          {/* Лучшая покупка, середина, лучшая продажа и спред — то, на чём
              держат стакан. mid здесь же, а не в подписи спреда: это три
              разных числа, и «1.0 · 100.50 bps» не говорило, где середина. */}
          <div className="book-mid">
            <span className="book-mid-cell">
              <i className="label">покупка</i>
              <b className="num" style={{ color: "var(--up)" }}>
                {fmt(depth.bids[0]?.price ?? NaN, decimals)}
              </b>
            </span>
            <span className="book-mid-cell">
              <i className="label">середина</i>
              <b className="num">{spread ? fmt(spread.mid, decimals) : "—"}</b>
            </span>
            <span className="book-mid-cell">
              <i className="label">продажа</i>
              <b className="num" style={{ color: "var(--down-hi)" }}>
                {fmt(depth.asks[0]?.price ?? NaN, decimals)}
              </b>
            </span>
            <span className="book-mid-cell">
              <i className="label">спред</i>
              {/* сторона без заявок названа своей строкой в лестнице — здесь прочерк */}
              <b className="num">{spread ? `${fmt(spread.gap, decimals)} · ${spread.bps.toFixed(2)} bps` : "—"}</b>
            </span>
          </div>

          {imb && (
            <div className="book-imb">
              <span className="book-imb-cell book-imb-bid-cell">
                <i className="label">покупки {share(imb.bid)}</i>
                <b className="num muted">{ladder.bids.length} ур. · {fmtUsdCompact(ladder.bidQuote)}</b>
              </span>
              <span className="book-imb-bar" aria-hidden="true">
                <i className="book-imb-bid" style={{ "--w": barWidth(imb.bid) } as CSSProperties} />
                <i className="book-imb-ask" style={{ "--w": barWidth(imb.ask) } as CSSProperties} />
              </span>
              <span className="book-imb-cell book-imb-ask-cell">
                <i className="label">продажи {share(imb.ask)}</i>
                <b className="num muted">{ladder.asks.length} ур. · {fmtUsdCompact(ladder.askQuote)}</b>
              </span>
            </div>
          )}

          <div className="table-scroll book-scroll">
            <table className="data-table book-table">
              <thead>
                <tr>
                  <th>Цена</th>
                  <th className="right">Размер</th>
                  <th className="right">Всего</th>
                </tr>
              </thead>
              {/* Одна сторона может отсутствовать целиком — это состояние рынка,
                  и оно обязано быть названо строкой, а не пустым местом: без
                  неё лестница выглядит обрезанной. */}
              <tbody>
                {ladder.asks.length > 0 ? (
                  rows(ladder.asks)
                ) : (
                  <tr className="book-side-empty"><td colSpan={3}>Продавцов нет</td></tr>
                )}
              </tbody>
              <tbody>
                {ladder.bids.length > 0 ? (
                  rows(ladder.bids)
                ) : (
                  <tr className="book-side-empty"><td colSpan={3}>Покупателей нет</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
