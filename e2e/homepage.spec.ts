// E2E-проверки гоняются без бэкенда и без доступа к Lighter: внешний трафик глушится
// в beforeEach, поэтому ассерты только по тому, что страница обязана показать своими
// силами — навигация, окно входа, честное состояние «данных нет». Проверять здесь
// курсы или PnL было бы самообманом: в CI эти числа неоткуда взять.
import { test, expect, type Page } from "@playwright/test";
import { TABS } from "./design-audit";

// Лента вкладок ищется по роли tablist: это и есть тот элемент, который
// скроллится, подсвечивает край и несёт выбранную вкладку. Landmark `navigation`
// остаётся на обёртке без собственной коробки — его проверяет отдельный гейт в
// design-gate.spec.ts, здесь бы он только мешал: у display: contents нет
// boundingBox, а ассерты ниже меряют scrollLeft и псевдоэлементы.
function nav(page: Page) {
  return page.getByRole("tablist");
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
      await expect(nav(page).getByRole("tab", { name: label, exact: true })).toBeVisible();
    }
  });

  // Разметка страницы — единственная проверка, которую axe читал как ошибку
  // landmark'ов и которая молчала, пока её никто не считал: без banner и main
  // всё содержимое живёт вне регионов, а без единственного заголовка первого
  // уровня у обхода нет точку входа. Гейт сверяет роли числом, а не
  // скриншотом, и требует, чтобы панель лежала внутри main: иначе лента
  // возвращает содержимое за разметку, и проверка остаётся зелёной.
  test("разметка: banner, main и один заголовок первого уровня", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main [role=tabpanel]")).toHaveCount(1);
  });

  test("активная вкладка помечена как выбранная и переключается", async ({ page }) => {
    await page.goto("/");
    await expect(nav(page).getByRole("tab", { name: "Обзор" })).toHaveAttribute("aria-selected", "true");

    await nav(page).getByRole("tab", { name: "Predict" }).click();
    await expect(nav(page).getByRole("tab", { name: "Predict" })).toHaveAttribute("aria-selected", "true");
    await expect(nav(page).getByRole("tab", { name: "Обзор" })).toHaveAttribute("aria-selected", "false");
  });

  test("ссылка с tab и asset открывает раздел и рынок, мусор — нет", async ({ page }) => {
    await page.goto("/?tab=funding&asset=ETH");
    await expect(nav(page).getByRole("tab", { name: "Funding" })).toHaveAttribute("aria-selected", "true");

    await page.goto("/?tab=terminal&asset=eth");
    await expect(nav(page).getByRole("tab", { name: "Терминал" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".desk-symbol-name")).toHaveText("ETH");

    await page.goto("/?tab=..%2Fadmin&asset=%3Cscript%3E");
    await expect(nav(page).getByRole("tab", { name: "Обзор" })).toHaveAttribute("aria-selected", "true");

    await page.goto("/?tab=terminal&asset=%3Cscript%3E");
    await expect(nav(page).getByRole("tab", { name: "Терминал" })).toHaveAttribute("aria-selected", "true");
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
      await nav(page).getByRole("tab", { name: label }).click();
      await expect(nav(page).getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText(/Ошибка загрузки|Что-то пошло не так/)).toHaveCount(0);
    }
  });

  test("настройка reduced motion отключает анимацию индикаторов", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const indicator = nav(page).getByRole("tab", { name: "Обзор" }).locator('span[title="Данные обновляются без бэкенда Wake"]');
    const duration = await indicator.evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));
    expect(duration).toBeLessThan(0.001);
  });

  test("мобильный экран не переполняется на каждой вкладке", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    for (const label of TABS) {
      await nav(page).getByRole("tab", { name: label }).click();
      await expect(nav(page).getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
  });

  // Девять панелей не влезают в 390 px: без затемнения края правый конец ленты
  // выглядит концом списка, и три вкладки остаются ненайденными. Подсказка
  // обязана исчезать там, где лента влезает целиком, иначе она врёт про скролл —
  // и по тому краю, за который лента уже не уезжает: на левом конце подсказка
  // слева обещает начало, которое и так видно, а на правом затемнение ложится
  // поверх последнего раздела и закрывает его.
  test("край ленты вкладок подсказывает про скролл только когда он есть", async ({ page }) => {
    const opacity = (edge: "before" | "after") =>
      nav(page).evaluate(
        (element, edge) => getComputedStyle(element, `::${edge}`).opacity,
        edge,
      );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(nav(page)).toHaveClass(/tabbar-overflow/);
    await expect.poll(() => opacity("before")).toBe("0");
    await expect.poll(() => opacity("after")).toBe("1");

    await nav(page).evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect.poll(() => opacity("before")).toBe("1");
    await expect.poll(() => opacity("after")).toBe("0");

    // Переход по хоткею на последнюю панель обязан дать ту же картину, что и
    // ручная прокрутка: активная вкладка центрируется, и до правого края
    // оставшийся зазор не должен подсвечиваться подсказкой.
    await page.keyboard.press("Alt+9");
    await expect(nav(page).getByRole("tab", { name: TABS[TABS.length - 1], exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(() => opacity("before")).toBe("1");
    await expect.poll(() => opacity("after")).toBe("0");

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(nav(page)).not.toHaveClass(/tabbar-overflow/);
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
    // Ответ /health обязан нести network: Терминал сверяет сеть книги с сетью
    // сервиса подписи перед тем как открыть подтверждение (см. тест ниже).
    await page.route("http://localhost:8787/health", (route) =>
      route.fulfill({ json: { status: "ok", network: "mainnet", base_url: "https://mainnet.zklighter.elliot.ai", dry_run: true } })
    );
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/place-order", async (route) => {
      await pending;
      await route.fulfill({ json: { dry_run: true, tx_hash: null } });
    });
    await page.goto("/");
    await nav(page).getByRole("tab", { name: "Терминал" }).click();
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
    await nav(page).getByRole("tab", { name: "Терминал" }).click();

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

  test("чип подписания проверяется по клику, а не при загрузке вкладки", async ({ page }) => {
    // Ордер из браузера подписывает не сайт, а локальный процесс. Спрашивать его
    // при каждом монтировании нельзя: запрос с публичного адреса на localhost
    // режет ещё и браузер, а в консоли остаётся красный ERR_CONNECTION_REFUSED
    // там, где человек ничего не делал.
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [{
      symbol: "BTC", market_id: 0, market_type: "perp", status: "active", taker_fee: "0", maker_fee: "0",
      min_base_amount: "0.00001", min_quote_amount: "10", supported_price_decimals: 1,
      supported_size_decimals: 5, open_interest: "370.84",
    }] } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    let healthChecks = 0;
    await page.route("http://localhost:8787/health", (route) => {
      healthChecks++;
      return route.fulfill({
        status: 200,
        json: { status: "ok", network: "mainnet", base_url: "https://mainnet.zklighter.elliot.ai", dry_run: true },
      });
    });
    await page.goto("/");
    await nav(page).getByRole("tab", { name: "Терминал" }).click();

    const chip = page.getByRole("button", { name: /подписание:/ });
    await expect(chip).toHaveText("подписание: не проверялось");
    expect(healthChecks).toBe(0);

    await chip.click();
    // Чип обязан назвать и сеть, и режим: «отвечает» молчит о том, уйдёт ли
    // ордер в Lighter или сервис остановит его на себе.
    await expect(chip).toHaveText("подписание: mainnet, сухой ход");
    expect(healthChecks).toBe(1);
  });

  test("ордер не уходит, если сервис подписи в другой сети", async ({ page }) => {
    // Данные книги и параметры рынка браузер берёт из сети переключателя, а
    // подписывает сервис из своего WAKE_LIGHTER_NETWORK. Без сверки клик по
    // testnet-рынку №0 с testnet-децималами ушёл бы боевым ордером в mainnet —
    // и подпись «Соло-режим: mainnet» под кнопкой ничего бы не выдавала,
    // потому что печаталась из состояния страницы, а не из ответа сервиса.
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [{
      symbol: "BTC", market_id: 0, market_type: "perp", status: "active", taker_fee: "0", maker_fee: "0",
      min_base_amount: "0.00001", min_quote_amount: "10", supported_price_decimals: 2,
      supported_size_decimals: 5, open_interest: "370.84",
    }] } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: Array.from({ length: 48 }, (_, i) => ({
      t: Date.now() - (47 - i) * 3600000, o: 88000, h: 88050, l: 87950, c: 88000, v: 1, V: 88000,
    })) } }));
    await page.route("**/api/v1/recentTrades?*", (route) => route.fulfill({ json: { trades: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    await page.route("http://localhost:8787/health", (route) =>
      route.fulfill({ json: { status: "ok", network: "testnet", base_url: "https://testnet.zklighter.elliot.ai", dry_run: false } })
    );
    let submitted = 0;
    await page.route("**/place-order", async (route) => {
      submitted++;
      await route.fulfill({ json: { dry_run: false, tx_hash: "0x" + "ab".repeat(32) } });
    });

    await page.goto("/");
    await nav(page).getByRole("tab", { name: "Терминал" }).click();
    await expect(page.locator("svg.recharts-surface")).toBeVisible();

    await page.getByRole("button", { name: /^Открыть long/ }).click();
    await expect(page.getByRole("dialog", { name: "Подтверждение ордера" })).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText(/Несовпадение сети/);
    await expect(page.getByRole("button", { name: /подписание: сеть testnet/ })).toBeVisible();
    expect(submitted).toBe(0);
  });

  test("рельс рынков не перетасовывается и держит выбранный рынок в поле зрения", async ({ page }) => {
    // Порядок /orderBooks у Lighter не стабилен между запросами (замер mainnet
    // 2026-10-24: те же 214 перпов в трёх ответах, BTC на 14, 207 и 58 месте).
    // Без сортировки рельс переставлялся на каждом опросе, и строка, за которой
    // следят, уезжала из-под курсора.
    const ids = [11, 3, 15, 7, 1, 9, 5, 13, 2, 8, 14, 4, 10, 6, 12];
    const rows = () => ids.map((id) => ({
      symbol: `M${id}`, market_id: id, market_type: "perp", status: "active",
      taker_fee: "0", maker_fee: "0", min_base_amount: "0.001", min_quote_amount: "10",
      supported_price_decimals: 2, supported_size_decimals: 4, open_interest: "10",
    }));
    const expected = ["M15", "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11"];
    const rail = page.locator(".desk-row b.num");
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: rows() } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    await page.goto("/?tab=terminal&asset=M15");

    // 15 рынков при 12 видимых строках: выбранный M15 вне среза и обязан
    // встать первым, а не исчезнуть из списка.
    await expect(rail).toHaveText(expected);
    await expect(page.locator('.desk-row[aria-current="true"]')).toContainText("M15");

    // Следующий ответ книги — в обратном порядке: рельс обязан остаться прежним.
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: rows().reverse() } }));
    await page.reload();
    await expect(rail).toHaveText(expected);
  });

  test("без ответа Lighter в Терминале — сообщение об отсутствии данных, а не пустые цифры", async ({ page }) => {
    await page.goto("/");
    await nav(page).getByRole("tab", { name: "Терминал" }).click();
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
    await nav(page).getByRole("tab", { name: "Predict" }).click();
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
    await nav(page).getByRole("tab", { name: "Терминал" }).click();
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

// Меню кошелька — единственное раскрытие в шапке: у него нет диалога, поэтому
// вся его проверка — в связке атрибутов с живым деревом. Панель монтируется
// только открытой, поэтому `id` существует ровно тогда, когда на него ссылаются;
// сверять `aria-controls` с литералом было бы самообманом — проверка берёт `id`
// отрисованного элемента и сравнивает с атрибутом триггера. Тогда разъехавшиеся
// ссылки краснеют, а две буквы, продублированные в двух местах, — нет.
test.describe("меню кошелька — раскрытие", () => {
  async function signInAsWallet(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem(
        "wake.session.v1",
        JSON.stringify({
          token: "wk1.probe.probe",
          userId: "0x" + "11".repeat(20),
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          lighterAccountIndex: 4242,
          label: "test",
          via: "wallet",
        }),
      );
    });
    await page.route("**/health", (route) => route.fulfill({ json: { status: "ok", network: "testnet", dry_run: true } }));
    await page.route("**/ready", (route) => route.fulfill({ json: { status: "ready" } }));
    await page.route("**/follows", (route) => route.fulfill({ json: [] }));
    await page.route("**/subscription", (route) =>
      route.fulfill({ json: { tier: "free", has_ai_agent: false, has_copy_trading: true, has_predict_markets: true } }),
    );
    await page.route("**/api/v1/account?*", (route) => route.fulfill({ json: { sub_accounts: [] } }));
    await page.route("**/api/v1/orderBooks?*", (route) => route.fulfill({ json: { order_books: [] } }));
    await page.route("**/api/v1/candles?*", (route) => route.fulfill({ json: { c: [] } }));
    await page.route("**/api/v1/funding-rates", (route) => route.fulfill({ json: { funding_rates: [] } }));
    await page.route("**/leaders*", (route) => route.fulfill({ json: { leader_id: null, active: false } }));
  }

  const trigger = (page: Page) => page.locator('button[aria-controls="wallet-menu"]');
  const panel = (page: Page) => page.getByRole("group", { name: "Меню кошелька" });

  test("триггер, панель и Escape сходятся", async ({ page }) => {
    await signInAsWallet(page);
    await page.goto("/");
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toHaveCount(0);

    await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    await expect(trigger(page)).toHaveAttribute(
      "aria-controls",
      await panel(page).evaluate((node) => node.id),
    );

    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("клик по затемнению закрывает меню, а не только выглядит фоном", async ({ page }) => {
    await signInAsWallet(page);
    await page.goto("/");
    await trigger(page).click();
    await expect(panel(page)).toBeVisible();
    await page.locator("div.fixed.inset-0").click({ position: { x: 8, y: 300 } });
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  });
});
