// E2E-проверки гоняются без бэкенда и без доступа к Lighter: внешний трафик глушится
// в beforeEach, поэтому ассерты только по тому, что страница обязана показать своими
// силами — навигация, окно входа, честное состояние «данных нет». Проверять здесь
// курсы или PnL было бы самообманом: в CI эти числа неоткуда взять.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

const TABS = ["Обзор", "Терминал", "Discover", "Портфель", "Earn", "Predict", "Агент", "Risk", "Funding"];

// VITE_TELEGRAM_BOT_NAME читает dev-сервер, а не процесс тестов, поэтому значение
// достаётся из .env напрямую: проверка «вход через Telegram выключен» имеет смысл
// только когда бота не задавали. В CI файла .env нет (он в .gitignore) и проверка
// прогоняется целиком; локально с именем бота в .env страница показывает виджет
// Telegram, а не заглушку, и требовать от неё текста про выключенный вход нельзя.
function telegramBotConfigured(): boolean {
  if (!existsSync(".env")) return false;
  const value = readFileSync(".env", "utf8").match(/^VITE_TELEGRAM_BOT_NAME=(.*)$/m)?.[1];
  return Boolean(value?.trim());
}

function nav(page: Page) {
  return page.getByRole("navigation");
}

// Dev-сервер Playwright поднимает сам (см. baseURL в playwright.config.ts), поэтому
// со своего адреса ему пустить можно, всё остальное — обрезать.
function devOrigin(): string {
  return new URL(test.info().project.use?.baseURL ?? "http://127.0.0.1:5173").origin;
}

test.beforeEach(async ({ page }) => {
  const origin = devOrigin();
  await page.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
});

test.describe("Оболочка приложения", () => {
  test("загружается и показывает всю навигацию", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Wake/i);
    for (const label of TABS) {
      await expect(nav(page).getByRole("button", { name: label })).toBeVisible();
    }
  });

  test("активная вкладка помечена как текущая и переключается", async ({ page }) => {
    await page.goto("/");
    await expect(nav(page).getByRole("button", { name: "Обзор" })).toHaveAttribute("aria-current", "page");

    await nav(page).getByRole("button", { name: "Predict" }).click();
    await expect(nav(page).getByRole("button", { name: "Predict" })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("button", { name: "Обзор" })).not.toHaveAttribute("aria-current");
  });

  test("без ответа Lighter в Терминале — сообщение об отсутствии данных, а не пустые цифры", async ({ page }) => {
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();
    await expect(page.getByText("Lighter API не отвечает")).toBeVisible();
    await expect(page.getByText(/\.zklighter\.elliot\.ai —/)).toBeVisible();
  });
});

test.describe("Вход", () => {
  async function openPicker(page: Page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Войти через TG или кошелёк" }).click();
  }

  test("пикер открывается с обоими способами входа", async ({ page }) => {
    await openPicker(page);
    await expect(page.getByText("Войти в Wake")).toBeVisible();
    await expect(page.getByText("Через Telegram", { exact: true })).toBeVisible();
    await expect(page.getByText("Через кошелёк", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Injected" })).toBeVisible();
  });

  test("без VITE_TELEGRAM_BOT_NAME кнопки Telegram нет — вместо неё объяснение", async ({ page }) => {
    test.skip(telegramBotConfigured(), "VITE_TELEGRAM_BOT_NAME задан локально — страница показывает виджет, а не заглушку");
    await openPicker(page);
    await expect(page.getByText(/Вход через Telegram выключен/)).toBeVisible();
  });

  test("клик по кошельку без установленного провайдера даёт причину, а не молчание", async ({ page }) => {
    await openPicker(page);
    await page.getByRole("button", { name: "Injected" }).click();
    await expect(page.getByText(/Кошелёк не подключился/)).toBeVisible();
  });
});
