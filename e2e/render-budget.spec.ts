// Бюджеты рендера: сколько узлов, строк, запросов и миллисекунд стоит каждая
// панель, когда данные живые.
//
// Числа ниже — не «разумные на глаз», а замер этой же сборки: e2e/runs с
// фикстурами из ./fixtures.ts, объёмы которых сняты с живых ответов
// (Lighter /orderBooks = 246 строк, /funding-rates = 733, Arcus /markets = 70,
// MAJOR_PERPS = 18, потолок /mirror-log = 200). Порог поставлен на фактическом
// значении с запасом на один ряд: он ловит возврат к «рендерим весь список»,
// но не краснеет от того, что кто-то добавил в таблицу одну колонку.
//
// До виртуализации те же замеры давали: окно выбора рынка — 1 018 узлов и
// 615 мс на открытие; Портфель — 2 348 узлов и страницу в 10 317 px; Discover
// — 80 запросов на 40 лидеров; Predict — 1 369 узлов на 60 рынков.
import { test, expect, type Page } from "@playwright/test";
import { MEASURED, FULL_FIXTURE, type RequestLog } from "./fixtures";
import { TABS, auditDesign, openWithData, visitTab } from "./design-audit";

type Metrics = {
  nodes: number;
  buttons: number;
  tableRows: number;
  svgNodes: number;
  pageHeight: number;
};

function measureInBrowser(): Metrics {
  return {
    nodes: document.getElementsByTagName("*").length,
    buttons: document.querySelectorAll("button").length,
    tableRows: document.querySelectorAll("tbody tr").length,
    svgNodes: document.querySelectorAll("svg *").length,
    pageHeight: document.body.scrollHeight,
  };
}

async function metrics(page: Page): Promise<Metrics> {
  return page.evaluate(measureInBrowser);
}

/** Сколько кадров пришлось дождаться после действия — «сколько экран висит». */
async function frameAfter(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    (window as unknown as { __t0: number }).__t0 = performance.now();
  });
  await action();
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const w = window as unknown as { __t0: number };
            resolve(Math.round(performance.now() - w.__t0));
          }),
        );
      }),
  );
}

async function rowCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count();
}

test.describe("бюджеты рендера на живом объёме данных", () => {
  let requests: RequestLog;

  test.beforeEach(async ({ page }) => {
    requests = await openWithData(page, FULL_FIXTURE);
  });

  test("окно рынка: список из 246 строк живёт в DOM окном", async ({ page }) => {
    await visitTab(page, "Терминал");
    const before = await metrics(page);

    const openedIn = await frameAfter(page, async () => {
      await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    });

    const mounted = await rowCount(page, ".picker-list .picker-row");
    const total = MEASURED.orderBookRows;

    // 246 кнопок в DOM — это и 615 мс первого кадра, и пересборка всего списка
    // на каждый символ поиска. Окно держит mounted в разы меньше списка.
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(total / 3);
    // Замер после виртуализации — 295 мс. Дороже, чем хотелось бы, и не из-за
    // списка: вместе с модалкой перерисовывается панель за ней (график и лента
    // на ~500 узлов). Порог публикуется как потолок: открывать стало медленнее
    // не может, а когда панель за модалкой перестанет перерисовываться, цифру
    // надо опустить — этот тест обязан покраснеть и в такую сторону.
    expect(openedIn).toBeLessThan(350);
    const after = await metrics(page);
    expect(after.nodes - before.nodes).toBeLessThan(700);
  });

  test("поиск по рынку не пересобирает весь список", async ({ page }) => {
    await visitTab(page, "Терминал");
    await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    const search = page.getByLabel("Поиск рынка");

    const typedIn = await frameAfter(page, async () => {
      await search.fill("ET");
    });
    expect(await rowCount(page, ".picker-list .picker-row")).toBeLessThan(30);
    expect(typedIn).toBeLessThan(150);

    // «Ничего не найдено» обязано оставаться правдой про весь список, а не про
    // отрисованное окно: фильтр идёт до окна.
    await search.fill("нет-такого");
    expect(await rowCount(page, ".picker-list .picker-row")).toBe(0);
    await expect(page.getByText("Ничего не найдено")).toBeVisible();
  });

  test("журнал копи-движка скроллится внутри панели, а не растит страницу", async ({ page }) => {
    await visitTab(page, "Портфель");
    const m = await metrics(page);
    // 200 строк журнала + подписки: раньше — 2 25 строк в DOM и 10 317 px
    // высоты страницы.
    expect(m.tableRows).toBeLessThanOrEqual(60);
    expect(m.pageHeight).toBeLessThan(4000);

    const log = page.locator(".log-scroll");
    const scrolls = await log.evaluate(
      (el) => el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY === "auto",
    );
    expect(scrolls, "журнал обязан досматриваться внутри своей области").toBe(true);

    const before = await log.evaluate((el) => el.scrollTop);
    await log.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const after = await log.evaluate((el) => el.scrollTop);
    expect(after).toBeGreaterThan(before);
    // после прокрутки окно показало другие строки, а не перерисовало те же
    expect(await rowCount(page, ".log-row")).toBeGreaterThan(0);
  });

  test("витрина лидеров стоит одного запроса, а не двух на карточку", async ({ page }) => {
    await visitTab(page, "Discover");
    const m = await metrics(page);
    const byPath = requests.byPath();

    // Карточка лидера раньше стоила двух round-trip'ов (статистика подписки +
    // счёт Lighter): на 40 лидерах — 80 запросов, и это при том, что StrictMode
    // в dev удваивает эффект. Теперь один адрес, Lighter читает сервер.
    expect(byPath["wake/leaders-hydrated"] ?? 0).toBeGreaterThan(0);
    expect(byPath["wake/leaders-hydrated"]).toBeLessThanOrEqual(2);
    expect(byPath["wake/leader-stats"] ?? 0).toBe(0);
    expect(byPath["lighter/account"] ?? 0).toBe(0);
    expect(m.nodes).toBeLessThan(3000);
  });

  test("каждая панель удерживается в своём бюджете узлов", async ({ page }) => {
    const budgets: Record<string, number> = {
      Обзор: 2600,
      Терминал: 1800,
      Discover: 2800,
      Портфель: 2200,
      Earn: 1800,
      Predict: 2600,
      Агент: 1800,
      Risk: 1800,
      Funding: 2400,
    };
    for (const tab of TABS) {
      await visitTab(page, tab);
      const m = await metrics(page);
      expect(m.nodes, `${tab}: узлов в DOM`).toBeLessThan(budgets[tab]);
      expect(m.pageHeight, `${tab}: высота страницы`).toBeLessThan(6000);
      expect(m.svgNodes, `${tab}: узлов графика`).toBeLessThan(1200);
    }
  });

  test("опрос не оставляет узлов за собой", async ({ page }) => {
    await visitTab(page, "Терминал");
    const first = await metrics(page);
    // Рыночная книга обновляется каждые 15 с; если окно мёртвое, узлы растут от
    // ответа к ответу, и через час вкладка стоит дороже, чем в первый кадр.
    await page.waitForTimeout(2000);
    const second = await metrics(page);
    expect(second.nodes).toBeLessThanOrEqual(first.nodes + 50);
    const audit = await auditDesign(page, 24);
    expect(audit.documentOverflow, "ни один ответ не должен расширять документ").toBeLessThanOrEqual(0);
  });
});
