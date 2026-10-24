// Мини-апп и телефон. Отдельно от homepage.spec.ts потому, что здесь проверяется
// поведение, которое появляется только внутри Telegram-вебвью: двойник SDK
// подставляется до первого рендера, а настоящий window.Telegram в обычном
// браузере не появляется никогда.
//
// Внешний трафик глушится, как и в остальном e2e: ассерты только по тому, что
// страница обязана сделать сама.
import { test, expect } from "@playwright/test";

const TG_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Telegram/iPhone 11.2.5";

function devOrigin(): string {
  return new URL(test.info().project.use?.baseURL ?? "http://127.0.0.1:5173").origin;
}

// Двойник window.Telegram.WebApp. Реестр вызовов лежит на window.__tg — тестам
// важно увидеть не только «кнопку нарисовали», но и порядок: без ready()
// Telegram не показывает страницу, а без expand() она остаётся половиной экрана.
const FAKE_SDK = `
  window.__tg = { calls: [], back: null };
  const rec = (name) => (...args) => window.__tg.calls.push([name, ...args]);
  window.__tg.pressBack = () => window.__tg.back && window.__tg.back();
  window.Telegram = {
    WebApp: {
      initData: '',
      initDataUnsafe: {},
      ready: rec('ready'),
      expand: rec('expand'),
      setColorScheme: rec('setColorScheme'),
      setHeaderColor: rec('setHeaderColor'),
      setBackgroundColor: rec('setBackgroundColor'),
      safeAreaInset: { top: 47, bottom: 34, left: 0, right: 0 },
      HapticFeedback: { notificationOccurred: rec('haptic'), impactOccurred: rec('impact') },
      BackButton: {
        show: rec('back.show'),
        hide: rec('back.hide'),
        onPress: (handler) => { window.__tg.back = handler; },
        offPress: () => { window.__tg.back = null; },
      },
    },
  };
`;

test.beforeEach(async ({ page }) => {
  const origin = devOrigin();
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
});

test.describe("окно мини-аппа", () => {
  test.use({ userAgent: TG_UA, viewport: { width: 390, height: 844 } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(FAKE_SDK);
  });

  test("страница сама говорит Telegram, что готова, и разворачивается", async ({ page }) => {
    await page.goto("/");
    const calls = await page.evaluate(() => (window as unknown as { __tg: { calls: unknown[] } }).__tg.calls);
    const names = (calls as [string, ...unknown[]][]).map((c) => c[0]);
    // Порядок внутри обвязки, а не «первые три вызова»: состояние оверлеев
    // настраивается синхронно на первом рендере и успевает дёрнуть «назад»
    // раньше, чем дойдёт промис SDK. В dev-сборке эффект вызывается дважды,
    // поэтому меряем первые вхождения.
    const first = (name: string) => names.indexOf(name);
    expect(first("ready")).toBeGreaterThanOrEqual(0);
    expect(first("ready")).toBeLessThan(first("expand"));
    expect(first("expand")).toBeLessThan(first("setColorScheme"));
    expect(first("setColorScheme")).toBeLessThan(first("setHeaderColor"));
    expect(first("setHeaderColor")).toBeLessThan(first("setBackgroundColor"));
    expect(calls).toContainEqual(["setColorScheme", "dark"]);
  });

  test("цвет шапки окна берётся из токена темы, а не из белого по умолчанию", async ({ page }) => {
    await page.goto("/");
    const calls = await page.evaluate(() => (window as unknown as { __tg: { calls: [string, ...unknown[]][] } }).__tg.calls);
    const header = calls.find((c) => c[0] === "setHeaderColor");
    expect(header?.[1]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(header?.[1]).not.toBe("#ffffff");
  });

  test("выемки экрана доезжают до стилей", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveCSS("--tg-safe-bottom", "34px");
    // Нижняя панель обязана поднять содержимое над жестом возврата.
    await expect(page.locator("nav")).toHaveCSS("padding-bottom", "34px");
  });

  test("стрелка «назад» закрывает открытую панель, а не убивает мини-апп", async ({ page }) => {
    await page.goto("/?tab=terminal");
    const dialog = page.getByRole("dialog", { name: "Выбор рынка" });
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Выбрать рынок" }).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator("html")).toHaveCSS("--tg-safe-bottom", "34px");

    const shown = await page.evaluate(() =>
      (window as unknown as { __tg: { calls: [string, ...unknown[]][] } }).__tg.calls.some((c) => c[0] === "back.show"),
    );
    expect(shown, "пока открыта панель — «назад» обязана быть видна").toBe(true);

    await page.evaluate(() => (window as unknown as { __tg: { pressBack: () => void } }).__tg.pressBack());
    await expect(dialog).toHaveCount(0);

    const hidden = await page.evaluate(() =>
      (window as unknown as { __tg: { calls: [string, ...unknown[]][] } }).__tg.calls.some((c) => c[0] === "back.hide"),
    );
    expect(hidden, "закрывать нечего — кнопка обязана уйти").toBe(true);
  });

  test("итог действия приходит вибрацией, а не только строкой", async ({ page }) => {
    await page.goto("/");
    // На 390 px кнопка подписана коротко («Войти»), полная формулировка остаётся
    // на широком экране — поэтому поиск по началу строки, а не по ней целиком.
    await page.getByRole("button", { name: /^Войти/ }).click();
    // Injected-кошелька в этом контексте нет — запрос на подключение падает, и
    // приложение обязано сообщить об этом ощутимо.
    await page.getByRole("button", { name: "Injected" }).click();
    await expect(page.getByRole("status")).toContainText(/Кошелёк не подключился/);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __tg: { calls: [string, ...unknown[]][] } }).__tg.calls.some(
            (c) => c[0] === "haptic" && c[1] === "error",
          ),
        ),
      )
      .toBe(true);
  });
});

test.describe("навигация на телефоне", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("девять разделов живут внизу экрана и переключаются", async ({ page }) => {
    await page.goto("/?tab=terminal");
    const nav = page.getByRole("navigation");
    await expect(nav).toHaveCSS("position", "fixed");

    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeGreaterThan(844 - 100);

    await nav.getByRole("button", { name: "Predict" }).click();
    await expect(nav.getByRole("button", { name: "Predict" })).toHaveAttribute("aria-current", "page");
  });

  test("контент не прячется под панелью", async ({ page }) => {
    await page.goto("/");
    const shell = page.locator(".app-shell");
    const padding = await shell.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom));
    const nav = await page.getByRole("navigation").boundingBox();
    expect(padding).toBeGreaterThanOrEqual((nav?.height ?? 0) - 1);
  });
});
