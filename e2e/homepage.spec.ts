// E2E-проверки гоняются без бэкенда и без доступа к Lighter: внешний трафик глушится
// в beforeEach, поэтому ассерты только по тому, что страница обязана показать своими
// силами — навигация, окно входа, честное состояние «данных нет». Проверять здесь
// курсы или PnL было бы самообманом: в CI эти числа неоткуда взять.
import { test, expect, type Page } from "@playwright/test";

const TABS = ["Обзор", "Терминал", "Discover", "Портфель", "Earn", "Predict", "Агент", "Risk", "Funding"];

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
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort()));
});

test.describe("Оболочка приложения", () => {
  test("загружается и показывает всю навигацию", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/Wake/i);
    for (const label of TABS) {
      await expect(nav(page).getByRole("button", { name: label, exact: true })).toBeVisible();
    }
  });

  test("активная вкладка помечена как текущая и переключается", async ({ page }) => {
    await page.goto("/");
    await expect(nav(page).getByRole("button", { name: "Обзор" })).toHaveAttribute("aria-current", "page");

    await nav(page).getByRole("button", { name: "Predict" }).click();
    await expect(nav(page).getByRole("button", { name: "Predict" })).toHaveAttribute("aria-current", "page");
    await expect(nav(page).getByRole("button", { name: "Обзор" })).not.toHaveAttribute("aria-current");
  });

  test("ссылка с tab и asset открывает раздел и рынок, мусор — нет", async ({ page }) => {
    await page.goto("/?tab=funding&asset=ETH");
    await expect(nav(page).getByRole("button", { name: "Funding" })).toHaveAttribute("aria-current", "page");

    await page.goto("/?tab=terminal&asset=eth");
    await expect(nav(page).getByRole("button", { name: "Терминал" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".desk-symbol-name")).toHaveText("ETH");

    await page.goto("/?tab=..%2Fadmin&asset=%3Cscript%3E");
    await expect(nav(page).getByRole("button", { name: "Обзор" })).toHaveAttribute("aria-current", "page");

    await page.goto("/?tab=terminal&asset=%3Cscript%3E");
    await expect(nav(page).getByRole("button", { name: "Терминал" })).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".desk-symbol-name")).toHaveText("BTC");
  });

  test("переключатель сети меняет и публичный API Arcus", async ({ page }) => {
    await page.route("**/v1/markets", (route) => route.fulfill({ json: { markets: [] } }));
    await page.route("**/v1/mids", (route) => route.fulfill({ json: { mids: {}, globalSequenceId: 1 } }));
    const mainnet = page.waitForRequest("https://api.arcus.xyz/v1/markets");
    await page.goto("/");
    await mainnet;
    const testnet = page.waitForRequest("https://api.testnet.arcus.xyz/v1/markets");
    await page.getByRole("button", { name: /^testnet$/i }).click();
    await testnet;
  });

  test("все вкладки открываются без ошибки рендера", async ({ page }) => {
    await page.goto("/");
    for (const label of TABS) {
      await nav(page).getByRole("button", { name: label }).click();
      await expect(nav(page).getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
      await expect(page.getByText(/Ошибка загрузки|Что-то пошло не так/)).toHaveCount(0);
    }
  });

  test("настройка reduced motion отключает анимацию индикаторов", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const indicator = nav(page).getByRole("button", { name: "Обзор" }).locator('span[title="Данные обновляются без бэкенда Wake"]');
    const duration = await indicator.evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
    expect(duration).toBeLessThan(0.001);
  });

  test("мобильный экран не переполняется на каждой вкладке", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    for (const label of TABS) {
      await nav(page).getByRole("button", { name: label }).click();
      await expect(nav(page).getByRole("button", { name: label })).toHaveAttribute("aria-current", "page");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
  });

  test("Терминал рисует свечи и блокирует повторную отправку до ответа signing service", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [{
      symbol: "BTC", market_id: 0, market_type: "perp", status: "active", taker_fee: "0", maker_fee: "0",
      min_base_amount: "0.00001", min_quote_amount: "10", supported_price_decimals: 1,
      supported_size_decimals: 5, open_interest: "370.84",
    }] } }));
    const candles = Array.from({ length: 48 }, (_, index) => ({
      t: Date.now() - (47 - index) * 3600000, o: 88000, h: 88050, l: 87950, c: 88000, v: 1, V: 88000,
    }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: candles } }));
    await page.route("**/api/v1/recentTrades?*", (route) => route.fulfill({ json: { trades: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/place-order", async (route) => {
      await pending;
      await route.fulfill({ json: { dry_run: true, tx_hash: null } });
    });
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();
    await expect(page.locator("svg.recharts-surface")).toBeVisible();
    await expect(page.locator(".recharts-xAxis .recharts-cartesian-axis-tick")).not.toHaveCount(0);
    await expect(page.locator(".recharts-yAxis .recharts-cartesian-axis-tick")).not.toHaveCount(0);
    await page.getByRole("button", { name: /^Открыть long/ }).click();
    await page.getByRole("dialog", { name: "Подтверждение ордера" }).getByRole("button", { name: "Подтвердить", exact: true }).click();
    await expect(page.getByRole("button", { name: "Отправка…", exact: true })).toBeDisabled();
    release?.();
    await expect(page.getByRole("status")).toContainText("ордер в Lighter не ушёл");
    await expect(page.getByRole("button", { name: /^Открыть long/ })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("переключатель публикации пишет в базу и выключает зеркалирование", async ({ page }) => {
    // Публикация лидера — единственная кнопка в Терминале, у которой есть
    // денежное последствие для чужих счетов: mirror_engine читает подписки по
    // строке leaders. Проверка фиксирует и что контрол существует, и что он
    // ходит на PATCH /leaders/{id}/active, а не просто меняет надпись.
    await page.addInitScript(() => {
      localStorage.setItem("wake.session.v1", JSON.stringify({
        token: "test-only-session", userId: "0xwallet", expiresAt: Date.now() / 1000 + 3600,
        lighterAccountIndex: 7, label: "@vega", via: "wallet",
      }));
    });
    await page.route("**/health", (route) => route.fulfill({ json: { status: "ok", network: "mainnet", dry_run: true } }));
    await page.route("**/ready", (route) => route.fulfill({ json: { status: "ready" } }));
    await page.route("**/follows", (route) => route.fulfill({ json: [] }));
    await page.route("**/subscription", (route) => route.fulfill({ json: { tier: "free", has_ai_agent: false, has_copy_trading: true, has_predict_markets: true } }));
    await page.route("**/api/v1/account?*", (route) => route.fulfill({ json: { sub_accounts: [] } }));
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [{
      symbol: "BTC", market_id: 0, market_type: "perp", status: "active", taker_fee: "0", maker_fee: "0",
      min_base_amount: "0.00001", min_quote_amount: "10", supported_price_decimals: 1,
      supported_size_decimals: 5, open_interest: "370.84",
    }] } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));

    const seen: string[] = [];
    await page.route("**/leaders/mine", (route) => {
      seen.push("mine");
      return route.fulfill({ json: { leader: null } });
    });
    await page.route("**/leaders", (route) => {
      seen.push("register");
      return route.fulfill({ json: { leader_id: "leader-1", active: true } });
    });
    await page.route("**/leaders/leader-1/active", (route) => {
      seen.push(`patch:${route.request().postDataJSON()?.active}`);
      return route.fulfill({ json: { leader_id: "leader-1", active: false } });
    });

    const switcher = page.getByRole("button", { name: "Публиковать мои сделки" });
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();

    await expect(switcher).toHaveAttribute("aria-pressed", "false");
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("status")).toContainText("Публикация включена");

    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-pressed", "false");
    // StrictMode в dev-сборке вызывает эффект дважды, поэтому подряд идущие
    // повторы сворачиваем: важен порядок обращений, а не их число в dev.
    expect(seen.filter((entry, i) => entry !== seen[i - 1])).toEqual([
      "mine",
      "register",
      "patch:false",
    ]);
  });

  test("чип подписания показывает состояние локального signing service", async ({ page }) => {
    // Ордер из браузера подписывает не сайт, а локальный процесс, и без этой
    // строки человек тыкал бы «Открыть long» вслепую, получая «Failed to fetch».
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [{
      symbol: "BTC", market_id: 0, market_type: "perp", status: "active", taker_fee: "0", maker_fee: "0",
      min_base_amount: "0.00001", min_quote_amount: "10", supported_price_decimals: 1,
      supported_size_decimals: 5, open_interest: "370.84",
    }] } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    await page.route("http://localhost:8787/health", (route) => route.fulfill({ status: 200, json: { status: "ok" } }));
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();
    await expect(page.getByText("подписание: отвечает")).toBeVisible();
  });

  test("без ответа Lighter в Терминале — сообщение об отсутствии данных, а не пустые цифры", async ({ page }) => {
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();
    await expect(page.getByText("Lighter API не отвечает")).toBeVisible();
    await expect(page.getByText(/\.zklighter\.elliot\.ai —/)).toBeVisible();
  });
});

test.describe("Predict", () => {
  test("изменение shares сбрасывает котировку и подтверждение", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("wake.session.v1", JSON.stringify({
        token: "test-only-session", userId: "tg_123", expiresAt: Date.now() / 1000 + 3600,
        lighterAccountIndex: null, label: "Trader", via: "telegram",
      }));
    });
    await page.route("**/predict/markets?status=*", (route) => route.fulfill({ json: [{
      id: "test-market", kind: "event", question: "Тестовый исход", lighter_market_id: null,
      threshold: null, comparator: null, resolve_at: Date.now() / 1000 + 3600,
      b: 100, status: "open", outcome: null, resolved_by: null, evidence_url: null,
      price_yes: 0.5, price_no: 0.5, volume_usd: 0, trade_count: 0,
    }] }));
    await page.route("**/predict/positions", (route) => route.fulfill({ json: [] }));
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/predict/markets/test-market/preview?*", async (route) => {
      const shares = Number(new URL(route.request().url()).searchParams.get("shares"));
      if (shares === 20) await pending;
      await route.fulfill({ json: { cost_usd: shares / 2 } });
    });
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Predict" }).click();
    await page.getByRole("button", { name: /^Купить YES/ }).click();
    const dialog = page.getByRole("dialog", { name: /Купить YES/ });
    await dialog.getByRole("button", { name: /Купить 10 за/ }).click();
    await expect(dialog.getByRole("button", { name: "Подтвердить", exact: true })).toBeEnabled();
    await dialog.getByRole("spinbutton", { name: "Количество shares" }).fill("20");
    await expect(dialog.getByRole("button", { name: "Цена недоступна", exact: true })).toBeDisabled();
    release?.();
    await expect(dialog.getByRole("button", { name: /Купить 20 за/ })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Подтвердить", exact: true })).toHaveCount(0);
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
    await openPicker(page);
    await expect(page.getByText(/Вход через Telegram выключен/)).toBeVisible();
  });

  test("фокус остаётся в окне входа и возвращается после Escape", async ({ page }) => {
    await openPicker(page);
    const dialog = page.getByRole("dialog", { name: "Войти в Wake" });
    const close = dialog.getByRole("button", { name: "Закрыть", exact: true });
    const wallet = dialog.getByRole("button", { name: "Injected" });
    // Стартовый фокус задаёт сам Modal: панель модалки — прокручиваемый
    // контейнер, а Chrome отдаёт таким контейнерам фокус по умолчанию, поэтому
    // «первая кнопка» здесь — намерение, а не совпадение.
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(wallet).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Войти через TG или кошелёк" })).toBeFocused();
  });

  test("Escape закрывает выбор рынка прямо из поля поиска", async ({ page }) => {
    await page.goto("/");
    await nav(page).getByRole("button", { name: "Терминал" }).click();
    const picker = page.getByRole("button", { name: "Выбрать рынок" });
    await picker.click();
    const dialog = page.getByRole("dialog", { name: "Выбор рынка" });
    const search = dialog.getByRole("textbox", { name: "Поиск рынка" });
    await expect(search).toBeFocused();
    await search.fill("BTC");
    await search.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(picker).toBeFocused();
  });

  test("клик по кошельку без установленного провайдера даёт причину, а не молчание", async ({ page }) => {
    await openPicker(page);
    await page.getByRole("button", { name: "Injected" }).click();
    await expect(page.getByRole("dialog", { name: "Войти в Wake" }).getByRole("status")).toContainText(/Кошелёк не подключился/);
  });
});
