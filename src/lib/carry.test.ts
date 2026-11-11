// Запуск: npx vitest run src/lib/carry.test.ts
//
// Таблица написаний в этом файле — единственная. Её же читает
// backend/test_carry_parity.py и прогоняет через `pairable_carry_markets`:
// правило живёт на бэкенде, панель обязана отвечать так же, и сверять два
// независимых пересказа одних и тех же строк надёжнее, чем держать по таблице
// на языке.
//
// Что здесь проверяется на самом деле:
//
//  * `status` на ОБЕИХ ногах. Это воспроизведённый дефект: панель фильтровала
//    книги по `market_type` и не смотрела на статус, поэтому неактивный рынок
//    (Lighter отдаёт их в /orderBooks) показывался как открытая возможность, а
//    `/funding-arb/size` предлагал размер позиции по рынку, где ордер не
//    поставить. Строки с `pair: false` и неактивной ногой краснеют ровно тогда,
//    когда проверка статуса снова исчезнет.
//  * котировка — это то, что стоит ПОСЛЕ ПЕРВОГО слэша, а не суффикс строки.
//    Суффиксная проверка (`endsWith("/USDC")` + отрезание 5 символов) на
//    сегодняшних символах Lighter даёт тот же результат, поэтому отдельно
//    прикреплена к `spotBase`: там расхождение видно на самих написаниях.

import { describe, expect, it } from "vitest";
import type { OrderBook } from "./lighter";
import { pairableCarryMarkets, spotBase, CARRY_QUOTE } from "./carry";

type Status = "active" | "inactive";

type Row = {
  perp: string;
  spot: string;
  perpStatus: Status;
  spotStatus: Status;
  pair: boolean;
};

// Ключи в одном порядке и строка в одном виде — это формат таблицы, который
// читает python-зеркало; свободное форматирование внутри строк ломает сверку.
export const CARRY_TABLE: Row[] = [
  { perp: "ETH", spot: "ETH/USDC", perpStatus: "active", spotStatus: "active", pair: true },
  { perp: "BTC", spot: "BTC/USDT", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "SOL", spot: "SOL/USDC", perpStatus: "inactive", spotStatus: "active", pair: false },
  { perp: "LINK", spot: "LINK/USDC", perpStatus: "active", spotStatus: "inactive", pair: false },
  { perp: "DOGE", spot: "DOGE/USDC", perpStatus: "inactive", spotStatus: "inactive", pair: false },
  { perp: "ETH", spot: "ETH", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "ETH/USDC/2", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "USDC/ETH", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "eth/usdc", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "/USDC", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "1000BONK", spot: "1000BONK/USDC", perpStatus: "active", spotStatus: "active", pair: true },
  { perp: "ETH", spot: "ETH/WETH/USDC", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "ETH/USDC ", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ETH", spot: "ETH/USDC:1", perpStatus: "active", spotStatus: "active", pair: false },
  { perp: "ARB", spot: "ARB/USDC:1", perpStatus: "active", spotStatus: "active", pair: false },
];

// Написания спота и база, которую обязан вернуть разбор. Суффиксное сравнение
// здесь расходится с правилом напрямую, без оглядки на то, что есть в книге
// перпов.
export const SPOT_BASE_TABLE: { spot: string; base: string | null }[] = [
  { spot: "ETH/USDC", base: "ETH" },
  { spot: "1000BONK/USDC", base: "1000BONK" },
  { spot: "BTC/USDT", base: null },
  { spot: "ETH", base: null },
  { spot: "ETH/USDC/2", base: null },
  { spot: "USDC/ETH", base: null },
  { spot: "/USDC", base: null },
  { spot: "eth/usdc", base: null },
  { spot: "ETH/USDC:1", base: null },
  { spot: "ETH/USDC ", base: null },
];

function book(symbol: string, type: "perp" | "spot", status: Status, marketId: number): OrderBook {
  return {
    symbol,
    market_id: marketId,
    market_type: type,
    status,
    taker_fee: "0.0",
    maker_fee: "0.0",
    min_base_amount: "0.001",
    min_quote_amount: "10",
    supported_price_decimals: 2,
    supported_size_decimals: 4,
    open_interest: "0",
  };
}

/** Как пару искали до разбора: суффикс "/USDC" и никаких проверок статуса. */
function pairedBySuffix(rows: Row[]): boolean[] {
  return rows.map((row) => {
    const perps = new Map([[row.perp, book(row.perp, "perp", row.perpStatus, 1)]]);
    const base = row.spot.endsWith(`/${CARRY_QUOTE}`)
      ? row.spot.slice(0, -`/${CARRY_QUOTE}`.length)
      : null;
    return base !== null && perps.has(base);
  });
}

describe("pairableCarryMarkets", () => {
  for (const row of CARRY_TABLE) {
    it(`${row.perp} + ${row.spot} (${row.perpStatus}/${row.spotStatus}) → пара: ${row.pair}`, () => {
      const markets = [
        book(row.perp, "perp", row.perpStatus, 1),
        book(row.spot, "spot", row.spotStatus, 2),
      ];
      const pairs = pairableCarryMarkets(markets);
      expect(pairs.has(row.perp)).toBe(row.pair);
      if (!row.pair) return;
      const legs = pairs.get(row.perp);
      expect(legs?.perp.symbol).toBe(row.perp);
      expect(legs?.spot.symbol).toBe(row.spot);
    });
  }

  it("строки таблицы отличают правило от суффиксной проверки", () => {
    // Иначе набор вырождается в пересказ одного случая: проверка, которая
    // одинаково проходит и с правилом, и с его догадкой, ничего не проверяет.
    const naive = pairedBySuffix(CARRY_TABLE);
    const disagree = CARRY_TABLE.map((row, i) =>
      naive[i] !== row.pair ? `${row.perp} + ${row.spot}` : null,
    ).filter((label): label is string => label !== null);
    expect(disagree).toEqual(["SOL + SOL/USDC", "LINK + LINK/USDC", "DOGE + DOGE/USDC"]);
  });

  it("неактивная нога не становится парой ни с какой другой строкой книги", () => {
    const markets = [
      book("SOL", "perp", "inactive", 1),
      book("SOL/USDC", "spot", "active", 2),
      book("SOL/USDC", "spot", "inactive", 3),
    ];
    expect(pairableCarryMarkets(markets).size).toBe(0);
  });

  it("несколько пар живут в одном ответе", () => {
    const markets = [
      book("ETH", "perp", "active", 1),
      book("ETH/USDC", "spot", "active", 2),
      book("BTC", "perp", "active", 3),
      book("BTC/USDT", "spot", "active", 4),
      book("1000BONK", "perp", "active", 5),
      book("1000BONK/USDC", "spot", "active", 6),
    ];
    expect([...pairableCarryMarkets(markets).keys()]).toEqual(["ETH", "1000BONK"]);
  });

  it("пустая книга не даёт пар", () => {
    expect(pairableCarryMarkets([]).size).toBe(0);
  });
});

describe("spotBase", () => {
  for (const row of SPOT_BASE_TABLE) {
    it(`"${row.spot}" → ${row.base ?? "null"}`, () => {
      expect(spotBase(row.spot)).toBe(row.base);
    });
  }

  it("котировка отличается от суффикса именно разбором", () => {
    // На этих написаниях два правила дают РАЗНЫЕ базы, а не разный ответ:
    // срезанный суффикс возвращает «ETH/WETH», чего в книге перпов нет и быть не
    // может, поэтому пара либо теряется, либо строится по чужому инструменту.
    expect(spotBase("ETH/WETH/USDC")).toBeNull();
    expect("ETH/WETH/USDC".endsWith("/USDC") ? "ETH/WETH/USDC".slice(0, -"/USDC".length) : null).toBe(
      "ETH/WETH",
    );
    // Написание с каталогом котировки суффикс не ловит вовсе, а разбор отвергает
    // его по тому же правилу — здесь оба ответа «нет базы», и это совпадение, а
    // не эквивалентность: следующий символ после стейбла для суффикса ничего не
    // значит.
    expect(spotBase("ETH/USDC:1")).toBeNull();
    expect(spotBase("ETH/USDC ")).toBeNull();
  });

  it("другой стейбл разбирается по имени котировки", () => {
    expect(spotBase("ETH/USDT", "USDT")).toBe("ETH");
    expect(spotBase("ETH/USDT", "USDC")).toBeNull();
  });
});
