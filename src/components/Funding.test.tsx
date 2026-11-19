import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Funding from "./Funding";
import type { FundingRateRow, OrderBook } from "../lib/lighter";

/* Ответ /funding-arb/check — это два разных ответа, и панель обязана различать
   их, потому что оба выходят на одну и ту же строку про деньги:
     1. `{opportunity: {...}}` — ноги посчитаны, показываем направление и APR;
     2. `{opportunity: null}` — бэкенд посмотрел те же числа и сказал «нет»;
     3. запрос не прошёл — чисел бэкенд не видел вовсе.
   Прежний код в ветке 3 писал тот же `check = null`, что и в ветке 2, и панель
   на неудачном запросе печатала «APR 3416.4% ниже порога 5%» про строку
   таблицы, где APR был выше порога в сотни раз. */

const PERP_ID = 1;

function book(
  symbol: string,
  type: "perp" | "spot",
  marketId: number,
  over: Partial<OrderBook> = {},
): OrderBook {
  return {
    symbol,
    market_id: marketId,
    market_type: type,
    status: "active",
    taker_fee: "0.0",
    maker_fee: "0.0",
    min_base_amount: "0.001",
    min_quote_amount: "10",
    supported_price_decimals: 2,
    supported_size_decimals: 4,
    open_interest: "0",
    ...over,
  };
}

// Перп и спот одного актива и одного стейбла — иначе pairableCarryMarkets не
// отдаёт вторую ногу, и кнопка «Разложить по ногам» остаётся выключенной.
const MARKETS: OrderBook[] = [
  book("ETH", "perp", PERP_ID),
  book("ETH/USDC", "spot", 2),
];

function rateRow(rate: number): FundingRateRow[] {
  return [
    { market_id: PERP_ID, exchange: "lighter", symbol: "ETH", rate },
    { market_id: PERP_ID, exchange: "binance", symbol: "ETHUSDT", rate: rate / 2 },
  ];
}

function mount(responses: Record<string, unknown | ((body: unknown) => unknown)>) {
  const respond = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) {
      return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    }
    const value = responses[key];
    const body = typeof value === "function" ? (value as (b: unknown) => unknown)(safeJson(init?.body)) : value;
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  });
  vi.stubGlobal("fetch", respond);
  return render(<Funding markets={MARKETS} setToast={() => {}} />);
}

function safeJson(raw: BodyInit | null | undefined) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openCheck(responses: Record<string, unknown | ((body: unknown) => unknown)>) {
  mount({
    "/funding-rates": { funding_rates: rateRow(0.0002) },
    "/candles": { c: [{ c: 2000 }] },
    ...responses,
  });
  // Таблица строится из ответа Lighter, поэтому ждать надо именно строки, а не
  // таймера: ставка 0.0002/час — это +175.2% годовых, она проходит порог 5%.
  await waitFor(() => expect(screen.getByText("+175.2%")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /проверить/ }));
}

describe("ответ проверки на funding-арбитраж", () => {
  it("возможность показана ногами и годовой", async () => {
    await openCheck({
      "/funding-arb/check": {
        opportunity: {
          symbol: "ETH",
          market_id: PERP_ID,
          annualized_yield: 1.752,
          perp_side: "short",
          spot_needed: true,
          hourly_rate: 0.0002,
        },
      },
    });
    expect(await screen.findByText("short")).toBeTruthy();
    expect(screen.getByText("buy")).toBeTruthy();
    expect(screen.getByText("175.2%")).toBeTruthy();
    expect(screen.getByText("0.0200%")).toBeTruthy();
    expect(screen.queryByText(/ниже порога/)).toBeNull();
  });

  it("запрос не прошёл — панель не выдумывает причину", async () => {
    await openCheck({ "/funding-arb/check": new Error("бэкенд не ответил") });
    expect(await screen.findByText(/Проверка не прошла/)).toBeTruthy();
    expect(screen.queryByText(/ниже порога/)).toBeNull();
    expect(screen.queryByText(/Отрицательный funding/)).toBeNull();
  });

  it("ответ «нет возможности» объясняется порогом, а не сбоем", async () => {
    await openCheck({ "/funding-arb/check": { opportunity: null } });
    expect(await screen.findByText(/ниже порога 5%/)).toBeTruthy();
    expect(screen.queryByText(/Проверка не прошла/)).toBeNull();
  });
});

describe("расчёт ног", () => {
  it("notional обеих печатается из ответа size", async () => {
    await openCheck({
      "/funding-arb/check": {
        opportunity: {
          symbol: "ETH",
          market_id: PERP_ID,
          annualized_yield: 1.752,
          perp_side: "short",
          spot_needed: true,
          hourly_rate: 0.0002,
        },
      },
      "/funding-arb/size": {
        position: {
          perp_notional_usd: 1000,
          spot_notional_usd: 1000,
          perp_base_amount: 0.5,
          spot_base_amount: 0.5,
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Разложить по ногам" }));
    expect((await screen.findAllByText(/\$1,000\.00/)).length).toBe(2);
    expect(screen.getAllByText("0.5").length).toBe(2);
    expect(screen.queryByText(/капитала недостаточно/)).toBeNull();
  });

  it("не хватило капитала — панель печатает причину бэкенда", async () => {
    await openCheck({
      "/funding-arb/check": {
        opportunity: {
          symbol: "ETH",
          market_id: PERP_ID,
          annualized_yield: 1.752,
          perp_side: "short",
          spot_needed: true,
          hourly_rate: 0.0002,
        },
      },
      "/funding-arb/size": {
        position: null,
        reason: "капитала недостаточно на минимальный размер обеих ног, либо неверные входные данные",
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Разложить по ногам" }));
    expect(await screen.findByText(/капитала недостаточно/)).toBeTruthy();
  });
});
