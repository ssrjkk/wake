// Единственный владелец правила «у инструмента есть обе ноги cash-and-carry».
//
// Правило живёт на бэкенде: `pairable_carry_markets` (backend/funding_arb.py)
// решает, по каким инструментам дельта-нейтральная позиция вообще строится, и
// именно его ответ стоит за `/funding-arb/size`. Панель показывает список,
// поэтому обязана применять то же правило, а не пересказывать его удобным
// сравнением строк.
//
// До появления этого файла пересказ отличался в двух местах, и оба молчали:
//
//  * спот резался по суффиксу `"/USDC"`. Суффикс — не котировка: бэкенд берёт
//    базу до ПЕРВОГО слэша (`partition("/")`) и требует, чтобы всё остальное было
//    ровно стейблом. У написания `ETH/WETH/USDC` срез суффикса даёт базу
//    `ETH/WETH`, а разбор по первому слэшу видит котировку `WETH/USDC` и строку
//    отвергает; панель же искала бы пару по тому и другому как по одному правилу,
//    а с приходом на площадку написания с каталогом (`ETH/USDC:1`) приняла бы её,
//    тогда как `/funding-arb/size` честно ответил бы «нет спот-двойника»;
//  * `status` не читался ни на одной ноге. Неактивная книга не принимает
//    ордера, и показать её как открытую возможность — значит соврать про
//    ликвидность: пользователь получит размер позиции по рынку, где ордер не
//    поставить.
//
// Написания символов, на которых эти два правила расходятся, лежат одной
// таблицей в `src/lib/carry.test.ts`; `backend/test_carry_parity.py` прогоняет
// по той же таблице бэкенд. Правило, записанное дважды без общей таблицы,
// расходится в тот день, когда его поправят в одном месте.

import type { OrderBook } from "./lighter";

/** Стейбл, в котором маржируется перп: спот за другой котировкой — не вторая нога. */
export const CARRY_QUOTE = "USDC";

export type CarryPair = {
  perp: OrderBook;
  spot: OrderBook;
};

/**
 * База спот-пары по правилам бэкенда или null, если строка не котировка в `quote`.
 *
 * Разбор — `partition("/")`, то есть база всё до ПЕРВОГО слэша, а котировка всё
 * после него: `ETH/USDC` → `ETH`, `ETH/USDT` → null, `ETH/USDC/2` → null,
 * `ETH` → null (слэша нет — это не спот-пары написания, а дубликат перпа).
 */
export function spotBase(symbol: string, quote: string = CARRY_QUOTE): string | null {
  const at = symbol.indexOf("/");
  if (at < 0) return null;
  return symbol.slice(at + 1) === quote && at > 0 ? symbol.slice(0, at) : null;
}

/**
 * Активные пары «перп + спот за одним стейблом», ключ — база инструмента.
 *
 * Обе ноги должны быть `active`: бэкенд исключает неактивные книги и с той и с
 * другой стороны. Перп берётся последний в книге при повторяющемся символе —
 * ровно как dict-компрессия на бэкенде, где позднее значение перетирает раннее.
 */
export function pairableCarryMarkets(
  markets: OrderBook[],
  quote: string = CARRY_QUOTE,
): Map<string, CarryPair> {
  const perps = new Map<string, OrderBook>();
  for (const m of markets) {
    if (m.market_type === "perp" && m.status === "active" && m.symbol) perps.set(m.symbol, m);
  }
  const pairs = new Map<string, CarryPair>();
  for (const m of markets) {
    if (m.market_type !== "spot" || m.status !== "active") continue;
    const base = spotBase(m.symbol, quote);
    if (base === null) continue;
    const perp = perps.get(base);
    if (perp) pairs.set(base, { perp, spot: m });
  }
  return pairs;
}
