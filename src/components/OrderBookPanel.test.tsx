import { cleanup, render, screen, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import OrderBookPanel from "./OrderBookPanel";
import {
  bookKey,
  buildLadder,
  imbalance,
  sizeChanges,
  type BookLadder,
} from "./orderBook";
import type { OrderBookDepth } from "../lib/lighter";

/* Стакан. Три вещи здесь пересчитываются на каждом витке опроса, и все три
   можно испортить молча: накопленный notional (от него колонка «Всего» и полоса
   глубины), баланс сторон (от него доля в процентах) и вспышка (от неё видно,
   какая строка изменилась). Проверки поэтому берут не «красивый» стакан, а
   такой, где то же число нельзя получить двумя способами: одна толстая покупка
   против трёх тонких продаж, и одна цена, лежащая на обеих сторонах книги.
   Порядок уровней в фикстурах — тот, который отдаёт depthLevels: продажи от
   дешёвой, покупки от дорогой, то есть лучшая цена всегда первая. */

afterEach(() => cleanup());

const book = (asks: [number, number][], bids: [number, number][]): OrderBookDepth => ({
  asks: asks.map(([price, size]) => ({ price, size })),
  bids: bids.map(([price, size]) => ({ price, size })),
});

const EMPTY: OrderBookDepth = { asks: [], bids: [] };

const jsx = (
  depth: OrderBookDepth,
  over: Partial<{ decimals: number; sizeDecimals: number; loading: boolean; error: string | null; unavailable: string | null }> = {}
) => (
  <OrderBookPanel
    depth={depth}
    decimals={over.decimals ?? 1}
    sizeDecimals={over.sizeDecimals ?? 4}
    loading={over.loading ?? false}
    error={over.error ?? null}
    unavailable={over.unavailable ?? null}
    updated={null}
  />
);

const panel = (depth: OrderBookDepth, over?: Parameters<typeof jsx>[1]): RenderResult =>
  render(jsx(depth, over));

const cells = (side: "ask" | "bid") =>
  [...document.querySelectorAll(`.book-row.${side}`)].map((row) =>
    [...row.querySelectorAll("td")].map((td) => td.textContent)
  );

describe("buildLadder", () => {
  it("копит notional от лучшей цены и показывает продажи перевёрнутыми", () => {
    // 0,75 по 100 и 1 по 101: накопление идёт 75 → 176, а не 176 → 75. В порядке
    // показа это обратный порядок: к середине книги примыкает лучшая цена, и её
    // строка лежит нижней из продаж.
    const ladder = buildLadder(book([[100, 0.75], [101, 1]], [[99, 2]]));
    expect(ladder.asks.map((r) => r.price)).toEqual([101, 100]);
    expect(ladder.asks.map((r) => r.cumQuote)).toEqual([176, 75]);
    expect(ladder.bids.map((r) => r.price)).toEqual([99]);
    expect(ladder.bids[0]?.cumQuote).toBe(198);
    expect(ladder.askQuote).toBe(176);
    expect(ladder.bidQuote).toBe(198);
  });

  it("мерит полосу от глубокой стороны, а не от своей", () => {
    // Одна покупка на 990 против одной продажи на 100: если бы fraction считался
    // по максимуму своей стороны, обе полосы были бы полными и «кто толще» было
    // бы не прочитать.
    const ladder = buildLadder(book([[100, 1]], [[99, 10]]));
    expect(ladder.askQuote).toBe(100);
    expect(ladder.bidQuote).toBe(990);
    expect(ladder.asks[0]?.fraction).toBeCloseTo(100 / 990, 10);
    expect(ladder.bids[0]?.fraction).toBe(1);
  });

  it("пустая книга даёт пустые списки без нулевого деления", () => {
    // edge = 0 → fraction обязан быть нулём, а не NaN: браузер отбрасывает
    // невалидную ширину полосы, и лестница рисуется без глубины вообще.
    expect(buildLadder(EMPTY)).toEqual({ asks: [], bids: [], bidQuote: 0, askQuote: 0 });
  });
});

describe("imbalance", () => {
  it("считает баланс по деньгам, а не по числу уровней", () => {
    // Три уровня продаж (306) против одного уровня покупки (1000): по строкам
    // продажи выглядели бы «больше», по накопленному USDC — меньше в 3,3 раза.
    const ladder: BookLadder = buildLadder(book([[101, 1], [102, 1], [103, 1]], [[100, 10]]));
    const imb = imbalance(ladder);
    expect(imb?.bid).toBeCloseTo(1000 / 1306, 10);
    expect(imb?.ask).toBeCloseTo(306 / 1306, 10);
    expect(imb && imb.bid + imb.ask).toBeCloseTo(1, 10);
  });

  it("не даёт «пятьдесят на пятидесяти» там, где книги нет", () => {
    expect(imbalance(buildLadder(EMPTY))).toBeNull();
    // Одна сторона при живой другой — это не null: доля второй равна единице.
    expect(imbalance(buildLadder(book([], [[99, 1]])))).toEqual({ bid: 1, ask: 0 });
  });
});

describe("sizeChanges", () => {
  it("первый виток не вспышивает никогда", () => {
    // Сравнивать не с чем, а загрузка рынка — не изменение заявок. Иначе каждое
    // открытие вкладки подсветило бы весь стакан, и человек не увидел бы, что
    // правда изменилось.
    expect(sizeChanges(null, book([[100, 1]], [[99, 1]])).size).toBe(0);
  });

  it("различает рост и сжатие размера и молчит, когда размер тот же", () => {
    const changes = sizeChanges(book([[100, 1], [101, 2]], [[99, 5]]), book([[100, 1.5], [101, 2]], [[99, 4]]));
    expect(changes.get(bookKey("ask", 100))).toBe("up");
    expect(changes.get(bookKey("bid", 99))).toBe("down");
    expect(changes.has(bookKey("ask", 101))).toBe(false);
    expect(changes.size).toBe(2);
  });

  it("исчезнувший и новый уровни не вспышивают", () => {
    // Строки исчезнувшего уровня на экране уже нет — подсветить нечего; новый
    // уровень мигнул бы сразу при появлении, что читается как отмена чужой
    // заявки.
    expect([...sizeChanges(book([[100, 1]], [[98, 1]]), book([[101, 1]], [[98, 1]])).keys()]).toEqual([]);
  });

  it("держит покупку и продажу на одной цене в разных ключах", () => {
    // Нулевой спред на живом рынке случается. Если бы ключ был одной ценой,
    // рост покупки перезаписал бы сжатие продажи на той же цене, и одна из двух
    // строк осталась бы без подсветки.
    const changes = sizeChanges(book([[100, 2]], [[100, 1]]), book([[100, 1]], [[100, 2]]));
    expect(changes.get(bookKey("ask", 100))).toBe("down");
    expect(changes.get(bookKey("bid", 100))).toBe("up");
    expect(bookKey("ask", 100)).not.toBe(bookKey("bid", 100));
  });
});

describe("OrderBookPanel: середина книги", () => {
  it("печатает лучшую покупку, середину, лучшую продажу и спред", () => {
    panel(book([[100, 0.75], [101, 1]], [[99, 2]]));
    const strip = document.querySelector(".book-mid")?.textContent ?? "";
    expect(strip).toContain("99.0");
    expect(strip).toContain("99.5");
    expect(strip).toContain("100.0");
    // gap 1,0 при mid 99,5 → 100.50 bps: те же числа, что считает depthSpread.
    expect(strip).toContain("1.0 · 100.50 bps");
  });

  it("не прячет середину под прокрутку", () => {
    // Смысл выноса: на сорока строках лестницы best bid и best ask уехали бы за
    // верх панели, а следят именно за ними.
    panel(book([[100, 0.75], [101, 1]], [[99, 2]]));
    expect(document.querySelector(".book-scroll .book-mid")).toBeNull();
    expect(document.querySelectorAll(".book-scroll .book-row")).toHaveLength(3);
  });

  it("без одной стороны ставит прочерк, а не число от нуля", () => {
    panel(book([[100, 1]], []));
    const strip = document.querySelector(".book-mid")?.textContent ?? "";
    expect(strip).toContain("—");
    expect(strip).not.toContain("bps");
    expect(screen.getByText("Покупателей нет")).toBeTruthy();
  });
});

describe("OrderBookPanel: колонки и точность", () => {
  it("«Всего» — накопленный USDC, а не базовый размер", () => {
    panel(book([[100, 0.75], [101, 1]], [[99, 2]]));
    // Порядок строк биржевой: 101 (176), 100 (75), затем покупка 99 (198).
    expect(cells("ask").map((row) => row[2])).toEqual(["$176.00", "$75.00"]);
    expect(cells("bid").map((row) => row[2])).toEqual(["$198.00"]);
  });

  it("знаков у размера столько, сколько объявила площадка", () => {
    // supported_size_decimals рынка против константы панели: Lighter объявляет
    // для разных рынков от одного до восьми знаков, и «0.8» вместо «0.80000»
    // в колонке размеров читается как другой объём.
    panel(book([[100, 0.8]], [[99, 0.125]]), { sizeDecimals: 5, decimals: 2 });
    expect(cells("ask")[0]?.[1]).toBe("0.80000");
    expect(cells("bid")[0]?.[1]).toBe("0.12500");
    expect(document.querySelector(".book-price")?.textContent).toContain("100.00");
  });

  it("баланс сторон называет и доли, и глубину каждой стороны", () => {
    panel(book([[101, 1], [102, 1], [103, 1]], [[100, 10]]));
    const imb = document.querySelector(".book-imb")?.textContent ?? "";
    expect(imb).toContain("покупки 77%");
    expect(imb).toContain("продажи 23%");
    expect(imb).toContain("1 ур. · $1K");
    expect(imb).toContain("3 ур. · $306.00");
  });

  it("без книги баланса нет — полоса 0% на 0% ничего не говорит", () => {
    panel(EMPTY, { loading: true });
    expect(document.querySelector(".book-imb")).toBeNull();
    expect(screen.getByText("загрузка…")).toBeTruthy();
  });
});

describe("OrderBookPanel: вспышка размера", () => {
  const sizeSpan = (price: string): HTMLSpanElement | undefined => {
    const row = [...document.querySelectorAll(".book-row")].find((r) =>
      r.querySelector(".book-price")?.textContent?.includes(price)
    );
    return row?.querySelector("td:nth-child(2) span") ?? undefined;
  };

  it("раскрашивает только изменившуюся строку", () => {
    const { rerender } = panel(book([[100, 1], [101, 1]], [[99, 1]]));
    expect(sizeSpan("100.0")?.className).toBe("");
    rerender(jsx(book([[100, 1.5], [101, 1]], [[99, 0.5]])));
    expect(sizeSpan("100.0")?.className).toBe("book-flash-up");
    expect(sizeSpan("99.0")?.className).toBe("book-flash-down");
    expect(sizeSpan("101.0")?.className).toBe("");
  });

  it("повторное изменение той же цены проигрывается заново", () => {
    // Без serial в ключе анимация не перезапустилась бы: браузер не видит
    // изменения, если элемент и его класс остались теми же самыми.
    const { rerender } = panel(book([[100, 1]], [[99, 1]]));
    rerender(jsx(book([[100, 2]], [[99, 1]])));
    const first = sizeSpan("100.0");
    expect(first?.className).toBe("book-flash-up");
    rerender(jsx(book([[100, 1]], [[99, 1]])));
    rerender(jsx(book([[100, 2]], [[99, 1]])));
    expect(sizeSpan("100.0")?.className).toBe("book-flash-up");
    expect(sizeSpan("100.0")).not.toBe(first);
  });
});

describe("OrderBookPanel: состояния книги", () => {
  it("отказ перечитать книгу не стирает то, что уже на экране", () => {
    // Устаревший стакан лучше пустой панели: человек видит цены и отметку
    // «обновлено», и по ней понимает, что данные старые.
    const { rerender } = panel(book([[100, 1]], [[99, 1]]));
    rerender(jsx(book([[100, 1]], [[99, 1]]), { error: "Lighter API 403" }));
    expect(document.querySelectorAll(".book-row")).toHaveLength(2);
    expect(screen.queryByText("Lighter API 403")).toBeNull();
  });

  it("пустая книга при отказе называет причину", () => {
    panel(EMPTY, { error: "Lighter API 403" });
    expect(screen.getByText("Lighter API 403")).toBeTruthy();
  });

  it("пустая книга без ответа площадки отличается от пустой книги биржи", () => {
    panel(EMPTY, { unavailable: "Lighter не ответил" });
    expect(screen.getByText("Заявок нет: Lighter не ответил.")).toBeTruthy();
  });

  it("пустая книга, которая реально пуста, говорит про заявки", () => {
    panel(EMPTY);
    expect(screen.getByText("Заявок в книге нет.")).toBeTruthy();
  });
});
