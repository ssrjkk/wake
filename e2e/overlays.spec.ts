// Оверлеи панелей: модалка обязана быть `<dialog>`, а не «fixed div с onClose».
//
// Пикер риска таким был:Escape его не закрывал (свой window-слушатель ловил
// клавишу только пока панель открыта, но не возвращал фокус), фокус в него не
// попадал, а стрелка «назад» мини-аппа про него не знала — стек слоёв в
// lib/layers.ts регистрирует только Modal. Проверка держит ровно то, что
// терялось при рукописном оверлее.
import { expect, test } from "@playwright/test";
import { openWithData, visitTab } from "./design-audit";
import { FULL_FIXTURE, MEASURED, symbolAt } from "./fixtures";

test.describe("оверлеи панелей", () => {
  test("окно рынка: клавиатура доходит от поиска до последней строки", async ({ page }) => {
    await openWithData(page, FULL_FIXTURE);
    await visitTab(page, "Терминал");
    await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Выбор рынка" });
    const search = dialog.getByRole("textbox", { name: "Поиск рынка" });

    await search.press("ArrowDown");
    await expect(dialog.locator(".picker-row").first()).toBeFocused();
    await page.keyboard.press("End");

    const last = symbolAt(Math.min(MEASURED.pickerCeiling, MEASURED.orderBookRows) - 1);
    const lastRow = dialog.locator(".picker-row").filter({ hasText: last });
    await expect(lastRow).toBeFocused();
    await expect(lastRow).toBeInViewport();
    await page.keyboard.press("ArrowDown");
    await expect(lastRow).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(dialog.locator('.picker-row[data-market-index="198"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(dialog.locator('.picker-row[data-market-index="0"]')).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(dialog.locator('.picker-row[data-market-index="0"]')).toBeFocused();

    const pageSize = await dialog.locator(".picker-list").evaluate((el) => Math.floor(el.clientHeight / 50));
    await page.keyboard.press("PageDown");
    await expect(dialog.locator(`.picker-row[data-market-index="${pageSize}"]`)).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect(dialog.locator('.picker-row[data-market-index="0"]')).toBeFocused();
    await page.keyboard.press("End");
    await expect(lastRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Выбрать рынок", exact: true })).toContainText(last);
  });

  test("пикер риска — диалог: фокус внутри, Escape наружу", async ({ page }) => {
    await openWithData(page);
    await visitTab(page, "Risk");

    const opener = page.getByRole("button", { name: "+ Добавить" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Добавить позицию" });
    await expect(dialog).toBeVisible();

    // Стартовый фокус — внутри окна, а не на кнопке, которая его открыла:
    // иначе первый же Tab уйдёт в панель за спиной диалога.
    const search = dialog.getByRole("textbox", { name: "Поиск рынка для добавления" });
    await expect(search).toBeFocused();

    // Строки списка приходят из книги Lighter (фикстуры), а не из воздуха:
    // без них проверка на «Escape закрывает» отличала бы пустой оверлей от
    // рабочего.
    await expect(dialog.getByRole("button", { name: /^Long/ }).first()).toBeVisible();

    await search.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("пикер риска ищет по совпадению, а не по первым 60 строкам", async ({ page }) => {
    await openWithData(page);
    await visitTab(page, "Risk");
    await page.getByRole("button", { name: "+ Добавить" }).click();
    const dialog = page.getByRole("dialog", { name: "Добавить позицию" });
    const search = dialog.getByRole("textbox", { name: "Поиск рынка для добавления" });

    await search.fill("ETH");
    const rows = dialog.getByRole("button", { name: /^Long/ });
    await expect(rows.first()).toBeVisible();
    const symbols = await dialog.locator(".picker-row").allTextContents();
    // Без фильтра список — первые 60 рынков в порядке книги, и «SOL» там нет.
    for (const text of symbols) expect(text.toUpperCase()).toContain("ETH");

    await search.fill("ZZZZZ");
    await expect(dialog.locator(".picker-empty")).toContainText("совпадений нет");
  });
});
