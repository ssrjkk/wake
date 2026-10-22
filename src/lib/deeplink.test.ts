import { describe, expect, it } from "vitest";
import { readEntryFromSearch, type Entry } from "./deeplink";

const FB: Entry = { tab: "dashboard", asset: "BTC" };

describe("readEntryFromSearch", () => {
  it("открывает раздел и рынок из ссылки бота", () => {
    expect(readEntryFromSearch("?tab=terminal&asset=eth", FB)).toEqual({
      tab: "terminal",
      asset: "ETH",
    });
  });

  it("не верит ни любому табу, ни любому символу", () => {
    expect(readEntryFromSearch("?tab=../../admin&asset=%3Cscript%3E", FB)).toEqual(FB);
    expect(readEntryFromSearch("?tab=terminal&asset=", FB).asset).toBe("BTC");
    expect(readEntryFromSearch("?tab=terminal&asset=" + "X".repeat(30), FB).asset).toBe("BTC");
  });

  it("без параметров оставляет дефолты", () => {
    const fallback: Entry = { tab: "funding", asset: "SOL" };
    expect(readEntryFromSearch("", fallback)).toEqual(fallback);
  });

  it("принимает все вкладки, которые есть в оболочке", () => {
    for (const tab of [
      "dashboard",
      "terminal",
      "discover",
      "portfolio",
      "earn",
      "predict",
      "agent",
      "risk",
      "funding",
    ] as const) {
      expect(readEntryFromSearch(`?tab=${tab}`, FB).tab).toBe(tab);
    }
  });

  it("рынок без активного перпа всё равно остаётся валидным символом", () => {
    // Проверка профиля — синтаксическая: «NOPE» выглядит тикером и уйдёт в
    // заголовок рынка, а панель сама скажет, что такого рынка нет.
    expect(readEntryFromSearch("?tab=terminal&asset=NOPE", FB)).toEqual({
      tab: "terminal",
      asset: "NOPE",
    });
  });
});
