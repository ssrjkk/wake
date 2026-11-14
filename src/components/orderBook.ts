import type { DepthLevel, OrderBookDepth } from "../lib/lighter";

/* Модель стакана отделена от панели: лестница пересобирается на каждом витке
   опроса, и эти четыре функции — весь расчёт, за который можно получить
   неправдивый экран (накопленный notional, баланс сторон, ключ и направление
   вспышки). Проверки на них лежат в OrderBookPanel.test.tsx.

   Накопление считается здесь, а не в клиенте Lighter: полосе и колонке «Всего»
   нужен накопленный USDC (size × price), базовое накопление из depthLevels для
   этого не подходит, и держать оба означало бы два ответа на вопрос «сколько
   стоит пройти книгу до этой цены». */

export type BookSide = "ask" | "bid";

export type BookRow = {
  side: BookSide;
  price: number;
  size: number;
  /** Накопленный USDC от лучшей цены этой стороны до этого уровня включительно. */
  cumQuote: number;
  /** Долю строки, которую закрывает полоса глубины: 0..1 от края обеих сторон. */
  fraction: number;
};

export type BookLadder = {
  /** Продажи в порядке показа: худшая цена первой, лучшая — у середины. */
  asks: BookRow[];
  /** Покупки в порядке показа: лучшая цена первой. */
  bids: BookRow[];
  /** Глубина каждой стороны в USDC — по ней считается баланс. */
  bidQuote: number;
  askQuote: number;
};

/** Уровни → строки лестницы с накопленным notional и долей полосы. */
export function buildLadder(depth: OrderBookDepth): BookLadder {
  const run = (levels: DepthLevel[], side: BookSide): BookRow[] => {
    let quote = 0;
    return levels.map((level) => {
      quote += level.size * level.price;
      return { side, price: level.price, size: level.size, cumQuote: quote, fraction: 0 };
    });
  };
  const asks = run(depth.asks, "ask");
  const bids = run(depth.bids, "bid");
  const askQuote = asks[asks.length - 1]?.cumQuote ?? 0;
  const bidQuote = bids[bids.length - 1]?.cumQuote ?? 0;
  /* Край — глубокое из двух накоплений, а не максимум по своей стороне:
     иначе толстая продажа и тонкая покупка рисовали бы одинаковую длину, и
     сравнить стороны между собой было бы нельзя. */
  const edge = Math.max(askQuote, bidQuote);
  const scaled = (rows: BookRow[]): BookRow[] =>
    rows.map((row) => ({ ...row, fraction: edge > 0 ? row.cumQuote / edge : 0 }));
  return { asks: scaled(asks).reverse(), bids: scaled(bids), bidQuote, askQuote };
}

/** Доли сторон по накопленному USDC. null, когда книги нет: 0 на 0 — это не
 *  «пятьдесят на пятидесяти», а отсутствие данных, и полоса на него рисовать
 *  нечего. */
export function imbalance(ladder: BookLadder): { bid: number; ask: number } | null {
  const total = ladder.bidQuote + ladder.askQuote;
  if (!(total > 0)) return null;
  return { bid: ladder.bidQuote / total, ask: ladder.askQuote / total };
}

export type BookChange = "up" | "down";

/** Ключ уровня для вспышки: сторона обязательна, потому что покупка и продажа
 *  стоят на разных ценах, но нулевой спред — случай живого рынка. */
export function bookKey(side: BookSide, price: number): string {
  return `${side}:${price}`;
}

/** Что изменилось в размерах между двумя витками книги. Первый виток не
 *  вспыхивает никогда: сравнивать не с чем, и загрузка рынка не является
 *  изменением заявок. Исчезнувший уровень тоже не считается — его строка уже
 *  не на экране. */
export function sizeChanges(
  prev: OrderBookDepth | null,
  next: OrderBookDepth
): Map<string, BookChange> {
  const out = new Map<string, BookChange>();
  if (!prev) return out;
  const side = (before: DepthLevel[], after: DepthLevel[], name: BookSide) => {
    const old = new Map(before.map((level) => [level.price, level.size]));
    for (const level of after) {
      const was = old.get(level.price);
      if (was === undefined || level.size === was) continue;
      out.set(bookKey(name, level.price), level.size > was ? "up" : "down");
    }
  };
  side(prev.asks, next.asks, "ask");
  side(prev.bids, next.bids, "bid");
  return out;
}
