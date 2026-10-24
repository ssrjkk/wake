import { describe, expect, it } from "vitest";
import { readEntryFromSearch, type Entry } from "./deeplink";
import { TAB_IDS } from "./tabs";

const FB: Entry = { tab: "dashboard", asset: "BTC", market: null };

describe("readEntryFromSearch", () => {
  it("открывает раздел и рынок из ссылки бота", () => {
    expect(readEntryFromSearch("?tab=terminal&asset=eth", FB)).toEqual({
      tab: "terminal",
      asset: "ETH",
      market: null,
    });
  });

  it("не верит ни любому табу, ни любому символу", () => {
    expect(readEntryFromSearch("?tab=../../admin&asset=%3Cscript%3E", FB)).toEqual(FB);
    expect(readEntryFromSearch("?tab=terminal&asset=", FB).asset).toBe("BTC");
    expect(readEntryFromSearch("?tab=terminal&asset=" + "X".repeat(30), FB).asset).toBe("BTC");
  });

  it("без параметров оставляет дефолты", () => {
    const fallback: Entry = { tab: "funding", asset: "SOL", market: null };
    expect(readEntryFromSearch("", fallback)).toEqual(fallback);
  });

  it("принимает все вкладки, которые есть в оболочке", () => {
    // Список берётся из того же TABS, что рисует навигацию: проверка «ссылка на
    // раздел, которого оболочка не знает» иначе тестировала бы вымышленный набор.
    for (const tab of TAB_IDS) {
      expect(readEntryFromSearch(`?tab=${tab}`, FB).tab).toBe(tab);
    }
  });

  it("рынок без активного перпа всё равно остаётся валидным символом", () => {
    // Проверка профиля — синтаксическая: «NOPE» выглядит тикером и уйдёт в
    // заголовок рынка, а панель сама скажет, что такого рынка нет.
    expect(readEntryFromSearch("?tab=terminal&asset=NOPE", FB)).toEqual({
      tab: "terminal",
      asset: "NOPE",
      market: null,
    });
  });

  describe("market — Predict-рынок из ссылки бота", () => {
    const UUID = "3f0a6d2c-9b1e-4c7a-8d5f-2e6b1a0c9d44";

    it("берёт id целиком", () => {
      expect(readEntryFromSearch(`?tab=predict&market=${UUID}`, FB).market).toBe(UUID);
    });

    it("не берёт ничего, кроме uuid", () => {
      for (const junk of ["", "..%2F..%2Fetc", "1", "здравствуй", UUID + "/trade", "x".repeat(80)]) {
        expect(readEntryFromSearch(`?tab=predict&market=${junk}`, FB).market).toBeNull();
      }
    });

    it("без predict-раздела id всё равно остаётся разбором, а не запросом", () => {
      // Значение никуда не подставляется: им ищется карточка среди уже
      // полученных рынков, поэтому профиль у него синтаксический.
      expect(readEntryFromSearch(`?tab=terminal&market=${UUID}`, FB)).toEqual({
        tab: "terminal",
        asset: "BTC",
        market: UUID,
      });
    });
  });
});
