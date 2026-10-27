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
import { MEASURED, FULL_FIXTURE, symbolAt, type RequestLog } from "./fixtures";
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

/**
 * Сколько кадров пришлось дождаться между действием и отрисовкой его результата.
 *
 * Кадры, а не миллисекунды. Одна и та же сборка на этой машине давала 295 →
 * 369 → 386 → 547 → 1 079 мс при неизменном дереве: кадр стоит и 16 мс, и
 * 500 мс, если раннер загружен, и порог в миллисекундах краснел от
 * планировщика Windows, а не от приложения. По кадрам распределение устойчиво:
 * 10 из 10 открытий окна рынка — ровно 2 кадра (клик → commit React в том же
 * кадре → отрисовка в следующем).
 *
 * Действие применяется здесь же, синхронно перед первым кадром счётчика: click
 * через Playwright — это отдельный CDP-раунд, и пока он идёт, счётчик успевает
 * исчерпать свои 40 кадров на условии, которое наступило бы через один кадр.
 * Настоящий клик мышью проверяют другие тесты (homepage, overlays), здесь
 * предмет — стоимость отрисовки.
 */
type Stimulus = { click?: string; typeInto?: { selector: string; value: string } };
type FrameCondition = { atLeast?: number; atMost?: number; text?: string };

async function framesAfter(page: Page, stimulus: Stimulus, watch: { selector: string; condition: FrameCondition }, limit = 40): Promise<number> {
  return page.evaluate(
    ({ stimulus, watch, limit }) => {
      const matches = (node: Element) => !watch.condition.text || (node.textContent ?? "").includes(watch.condition.text);
      const count = () => [...document.querySelectorAll(watch.selector)].filter(matches).length;
      const met = () => {
        const n = count();
        if (watch.condition.atLeast !== undefined && n < watch.condition.atLeast) return false;
        if (watch.condition.atMost !== undefined && n > watch.condition.atMost) return false;
        return true;
      };
      return new Promise<number>((resolve, reject) => {
        if (stimulus.click) {
          const button = document.querySelector(stimulus.click) as HTMLElement | null;
          if (!button) return reject(new Error(`нет кнопки ${stimulus.click}`));
          button.click();
        }
        if (stimulus.typeInto) {
          const input = document.querySelector(stimulus.typeInto.selector) as HTMLInputElement | null;
          if (!input) return reject(new Error(`нет поля ${stimulus.typeInto.selector}`));
          // Контролируемый React input: .value напрямую он не заметит, нужен
          // нативный сеттер — иначе событие придёт, а состояние нет.
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(input, stimulus.typeInto.value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        let frame = 0;
        const tick = () => {
          frame++;
          if (met()) return resolve(frame);
          if (frame >= limit) return reject(new Error(`${watch.selector}: ${JSON.stringify(watch.condition)} не наступило за ${limit} кадров`));
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    },
    { stimulus, watch, limit },
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

    const openedIn = await framesAfter(
      page,
      { click: 'button[aria-label="Выбрать рынок"]' },
      { selector: ".picker-row", condition: { atLeast: 1 } },
    );

    const mounted = await rowCount(page, ".picker-list .picker-row");
    const total = MEASURED.orderBookRows;

    // 246 кнопок в DOM — это и 615 мс первого кадра, и пересборка всего списка
    // на каждый символ поиска. Окно держит mounted в разы меньше списка.
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(total / 3);
    // Первый же кадр после клика обязан нести строки. Порог в кадрах, а не в
    // миллисекундах: замер одной и той же сборки давал 295 / 369 / 547 / 1 079 мс
    // в зависимости от того, чем ещё занят раннер, при неизменном дереве (10 из
    // 10 открытий — ровно 2 кадра). Миллисекунды тут краснели бы от планировщика
    // Windows, а не от приложения, и тест был бы шумом, а не проверкой.
    expect(openedIn, "окно рынка обязано быть отрисовано на втором кадре").toBeLessThanOrEqual(3);
    const after = await metrics(page);
    expect(after.nodes - before.nodes).toBeLessThan(700);
  });

  test("поиск по рынку не пересобирает весь список", async ({ page }) => {
    await visitTab(page, "Терминал");
    await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    const search = page.getByLabel("Поиск рынка");

    // Ищется XAUUSD — строка, которой в первом окне нет (в книге она 33-я, а в
    // окне лежит ~17). Условие «появилась строка с этим текстом» до ввода
    // ложно, поэтому счётчик кадров мерит именно перерисовку на фильтр, а не
    // уже нарисованное. «ET» для этого не годился: ETH стоит в начале окна.
    const typedIn = await framesAfter(
      page,
      { typeInto: { selector: 'input[aria-label="Поиск рынка"]', value: "XAUUSD" } },
      { selector: ".picker-row", condition: { text: "XAUUSD", atLeast: 1 } },
    );
    expect(await rowCount(page, ".picker-list .picker-row")).toBeLessThan(30);
    expect(typedIn, "фильтр обязан отрисоваться на следующем кадре").toBeLessThanOrEqual(3);

    // Проверка настоящим вводом, а не синтетическим событием: тот же фильтр по
    // пути, которым пользуется человек.
    await search.fill("NG");
    expect(await rowCount(page, ".picker-list .picker-row")).toBeLessThan(30);

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

  // Виртуализация живёт арифметикой: шаг строки задан числом, а пустоты над и
  // под окном — заглушками. Если число расходится с тем, что отрисовал браузер,
  // список либо врёт о длине скролла, либо теряет строки. Первый же замер это и
  // показал: в flex-колонке заглушка сжалась (flex-shrink по умолчанию),
  // scrollHeight окна стал 804 px вместо ~10 000, и 180 из 200 рынков нельзя
  // было открыть мышью — их находил только поиск.
  type WindowGeometry = {
    rows: number;
    pitch: { min: number; max: number };
    scrollHeight: number;
    clientHeight: number;
    firstVisible: string;
    tailSymbol: string;
    tailVisible: boolean;
    coveredWhileScrolling: boolean;
  };

  async function windowGeometry(page: Page, listSelector: string, rowSelector: string): Promise<WindowGeometry> {
    await page.waitForSelector(listSelector);
    const pitchAndRange = await page.evaluate(
      ({ listSelector, rowSelector }) => {
        const list = document.querySelector(listSelector) as HTMLElement;
        const rows = [...list.querySelectorAll(rowSelector)] as HTMLElement[];
        const tops = rows.map((r) => r.getBoundingClientRect().top);
        const deltas = tops.slice(1).map((t, i) => t - tops[i]);
        return {
          rows: rows.length,
          pitch: {
            min: deltas.length ? Math.min(...deltas) : 0,
            max: deltas.length ? Math.max(...deltas) : 0,
          },
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          firstSymbol: rows[0]?.textContent?.slice(0, 12) ?? "",
        };
      },
      { listSelector, rowSelector },
    );

    // Хвост: прокручиваем до конца и требуем увидеть именно последнюю строку
    // списка, а не «какую-то из середины окна».
    const tail = await page.evaluate(
      async ({ listSelector, rowSelector }) => {
        const list = document.querySelector(listSelector) as HTMLElement;
        for (let i = 0; i < 30; i++) {
          list.scrollTop = list.scrollHeight;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
        const rows = [...list.querySelectorAll(rowSelector)] as HTMLElement[];
        const last = rows[rows.length - 1] as HTMLElement;
        const lrect = list.getBoundingClientRect();
        const rrect = last.getBoundingClientRect();
        return {
          tailSymbol: last.textContent?.slice(0, 12) ?? "",
          tailVisible: rrect.bottom <= lrect.bottom + 1 && rrect.top >= lrect.top - 1,
        };
      },
      { listSelector, rowSelector },
    );

    // Ни одной дыры: на середине скролла отрисованные строки обязаны накрывать
    // видимую область целиком, иначе окно считает не по clientHeight.
    const covered = await page.evaluate(
      async ({ listSelector, rowSelector }) => {
        const list = document.querySelector(listSelector) as HTMLElement;
        list.scrollTop = Math.round((list.scrollHeight - list.clientHeight) / 2);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rows = [...list.querySelectorAll(rowSelector)] as HTMLElement[];
        const lrect = list.getBoundingClientRect();
        const top = rows[0].getBoundingClientRect().top - lrect.top;
        const bottom = rows[rows.length - 1].getBoundingClientRect().bottom - lrect.top;
        return top <= 1 && bottom >= lrect.height - 1;
      },
      { listSelector, rowSelector },
    );

    return {
      rows: pitchAndRange.rows,
      pitch: pitchAndRange.pitch,
      scrollHeight: pitchAndRange.scrollHeight,
      clientHeight: pitchAndRange.clientHeight,
      firstVisible: pitchAndRange.firstSymbol,
      tailSymbol: tail.tailSymbol,
      tailVisible: tail.tailVisible,
      coveredWhileScrolling: covered,
    };
  }

  test("окно рынка: шаг строк, длина скролла и последняя строка", async ({ page }) => {
    await visitTab(page, "Терминал");
    await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    const total = Math.min(MEASURED.pickerCeiling, MEASURED.orderBookRows);
    const g = await windowGeometry(page, ".picker-list", ".picker-row");

    expect(g.rows).toBeLessThan(total, "в DOM обязано жить окно, а не список");
    expect(g.pitch.max - g.pitch.min).toBeLessThan(0.5, `шаг строки гуляет: ${JSON.stringify(g.pitch)}`);
    const pitch = g.pitch.min;
    // Диапазон скролла = count × шаг, с запасом на заголовок и заглушки. Если
    // заглушка снова сожмётся — этот assert красный, а не «ну чуть короче».
    expect(g.scrollHeight).toBeGreaterThanOrEqual(total * pitch * 0.98);
    expect(g.coveredWhileScrolling, "на середине скролла строки обязаны накрывать область").toBe(true);
    expect(g.tailVisible, "последняя строка обязана доезжать до видимой области").toBe(true);
    expect(g.tailSymbol).toContain(symbolAt(total - 1));
  });

  test("окно рынка: resize и сокращение данных не оставляют дыр", async ({ page }) => {
    await visitTab(page, "Терминал");
    await page.getByRole("button", { name: "Выбрать рынок", exact: true }).click();
    const list = page.locator(".picker-list");
    await list.evaluate((el) => { el.scrollTop = 100 * 50; });

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      const g = await windowGeometry(page, ".picker-list", ".picker-row");
      expect(g.coveredWhileScrolling, `${viewport.width}: строки накрывают viewport`).toBe(true);
      expect(g.tailVisible, `${viewport.width}: последняя строка доступна`).toBe(true);
      expect(g.pitch.max - g.pitch.min).toBeLessThan(0.5);
    }

    const expected = Array.from({ length: MEASURED.orderBookRows }, (_, i) => symbolAt(i))
      .filter((symbol) => symbol.includes("XAUUSD"));
    await page.getByRole("textbox", { name: "Поиск рынка" }).fill("XAUUSD");
    await expect(page.locator(".picker-row")).toHaveCount(expected.length);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
    for (const [index, symbol] of expected.entries()) {
      await expect(page.locator(".picker-row").nth(index)).toContainText(symbol);
    }
  });

  test("журнал копи-движка: те же инварианты геометрии", async ({ page }) => {
    await visitTab(page, "Портфель");
    const total = MEASURED.mirrorLogCeiling;
    const g = await windowGeometry(page, ".log-scroll", ".log-row");

    expect(g.rows).toBeLessThan(total, "журнал обязан рендериться окном");
    expect(g.pitch.max - g.pitch.min).toBeLessThan(0.5, `шаг строки гуляет: ${JSON.stringify(g.pitch)}`);
    expect(g.scrollHeight).toBeGreaterThanOrEqual(total * g.pitch.min * 0.98);
    expect(g.tailVisible, "последняя строка журнала досматривается").toBe(true);
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

  async function waitForStableMetrics(page: Page): Promise<Metrics> {
    let previous: Metrics | null = null;
    let stable = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.waitForTimeout(200);
      const current = await metrics(page);
      if (previous && current.nodes === previous.nodes && current.svgNodes === previous.svgNodes) {
        stable++;
        if (stable >= 3) return current;
      } else {
        stable = 0;
      }
      previous = current;
    }
    throw new Error("Первичная загрузка Терминала не успокоилась: узлы продолжают расти");
  }

  test("опрос не оставляет узлов за собой", async ({ page }) => {
    await visitTab(page, "Терминал");
    // Базой может быть только устойчивое дерево: первые ответы подгружают свечи,
    // ленту и тикеры, и сравнивать «до загрузки» с «после» — это мерить старт,
    // а не опрос.
    const first = await waitForStableMetrics(page);
    await page.waitForTimeout(2000);
    const second = await metrics(page);
    expect(second.nodes).toBeLessThanOrEqual(first.nodes + 50);
    const audit = await auditDesign(page, 24);
    expect(audit.documentOverflow, "ни один ответ не должен расширять документ").toBeLessThanOrEqual(0);
  });
});
