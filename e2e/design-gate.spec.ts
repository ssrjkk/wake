// Суровые проверки дизайна: они считаются по computed-стилям живого дерева, а не
// глазами по скриншоту. Методика — в ./design-audit.ts.
import { test, expect, type Page } from "@playwright/test";
import { FULL_FIXTURE } from "./fixtures";
import {
  TABS,
  auditDesign,
  auditTabFocus,
  openWithData,
  reportOffenders,
  visitTab,
  type Offender,
} from "./design-audit";

test.describe("дизайн-инварианты на живом объёме данных", () => {
  test.beforeEach(async ({ page }) => {
    // Проверки ищут обрезанный текст, контраст, фокус и размеры целей; большой
    // список им не мешает, поэтому фикстура умеренная, а не «полный букет».
    await openWithData(page, { leaders: 12, predictMarkets: 24, mirrorLog: 60 });
  });

  for (const tab of TABS) {
    test(`${tab}: обрезка, контраст, документ`, async ({ page }) => {
      await visitTab(page, tab);
      const audit = await auditDesign(page);
      reportOffenders(`${tab} clipping`, audit.clipping);
      reportOffenders(`${tab} contrast`, audit.contrast);
      reportOffenders(`${tab} placeholder`, audit.placeholders);
      expect(audit.clipping, "текст не должен исчезать без скролла и без многоточия").toEqual([]);
      expect(audit.contrast, "4.5:1 для обычного текста, 3:1 для крупного").toEqual([]);
      expect(audit.placeholders, "подсказка поля читается и отличается от введённого значения").toEqual([]);
      expect(audit.documentOverflow, "документ не переполняется по горизонтали").toBeLessThanOrEqual(0);
      expect(audit.documentPan, "страница не ездит боком").toBe(0);
    });
  }

  test("фокус виден при навигации с клавиатуры", async ({ page }) => {
    for (const tab of TABS) {
      await visitTab(page, tab);
      const offenders = await auditTabFocus(page);
      reportOffenders(`${tab} focus`, offenders);
      expect(offenders, "у каждого элемента в tab-order есть заметное кольцо фокуса").toEqual([]);
    }
  });

  test("мобильный 390: цели касания", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page);
      offenders.push(...audit.touch.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
    }
    reportOffenders("touch@390", offenders, 20);
    expect(offenders, "на телефоне цель касания не меньше 44×44").toEqual([]);
  });

  test("узкий 320: ничего не вылезает за край", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page);
      offenders.push(...audit.clipping.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
      expect(audit.documentOverflow, `${tab}: документ на 320 px не переполняется`).toBeLessThanOrEqual(0);
      expect(audit.documentPan, `${tab}: на 320 px страница не ездит боком`).toBe(0);
    }
    reportOffenders("clipping@320", offenders, 20);
    expect(offenders, "на 320 px текст не за правым краем и не обрезан").toEqual([]);
  });

  // Нижняя граница для указателя — 24×24 (WCAG 2.5.8 AA). На 390 px её проверяет
  // случай выше, но десктопный прибор мелкими чипами и иконками живёт именно под
  // мышью, и до этой правки в постоянном гейте такого замера не было: 24 px
  // ловились только в разовом прогоне.
  test("1440 px: цели под указателем не меньше 24×24", async ({ page }) => {
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page, 24);
      offenders.push(...audit.touch.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
    }
    reportOffenders("pointer targets @1440", offenders, 20);
    expect(offenders, "под указателем цель не меньше 24×24").toEqual([]);
  });

  // Поле ввода в Терминале видно сразу, поле окна рынка — только в оверлее;
  // ::placeholder — единственный текст интерфейса, которого обход дерева не
  // встречает вовсе.
  test("подсказки полей читаются и отличаются от значения", async ({ page }) => {
    await openWithData(page);
    await visitTab(page, "Терминал");
    let offenders = (await auditDesign(page)).placeholders;
    reportOffenders("terminal placeholder", offenders);
    expect(offenders, "поле поиска в Терминале").toEqual([]);

    await page.getByRole("button", { name: "Выбрать рынок" }).click();
    offenders = (await auditDesign(page)).placeholders;
    reportOffenders("picker placeholder", offenders);
    expect(offenders, "окно выбора рынка").toEqual([]);
  });

  // WCAG 1.4.10 (reflow): то, что обязано помещаться в 320 px, не имеет права
  // расплющиваться, когда человек крупнее читает. Заодно это ловит разницу
  // шрифтовых метрик: CI на Linux'овских шрифтах нашёл переполнение чипа на
  // 14 px там, где на машине автора строка влезала, — и локальный прогон был
  // зелёным. Удваиваются токены шкалы, а не zoom: шкала в теме задана числами,
  // и именно её обязаны выдерживать раскладка и nowrap-элементы.
  test("крупный текст: 320 px переживает удвоение шкалы", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addStyleTag({
      content: ":root{--fs-label:21px;--fs-data:24px;--fs-ui:26px;--fs-title:30px;--fs-price:clamp(52px,5.2vw,72px)}",
    });
    await expect(page.locator("html")).toHaveCSS("--fs-ui", "26px");
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page);
      offenders.push(...audit.clipping.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
      expect.soft(audit.documentPan, `${tab}: на 320 px при крупном тексте страница не ездит боком`).toBe(0);
    }
    reportOffenders("clipping@200%", offenders, 20);
    expect(offenders, "при удвоенной шкале текст не за правым краем и не обрезан").toEqual([]);
  });
});

test.describe("открытые оверлеи на узком экране и крупном тексте", () => {
  const cases: { name: string; tab: string; open: (page: Page) => Promise<void> }[] = [
    {
      name: "вход",
      tab: "Обзор",
      open: async (page) => {
        await page.getByRole("button", { name: "T test", exact: true }).click();
        await page.getByRole("button", { name: "Выйти", exact: true }).click();
        await page.getByRole("button", { name: "Войти", exact: true }).click();
      },
    },
    {
      name: "выбор рынка",
      tab: "Терминал",
      open: async (page) => page.getByRole("button", { name: "Выбрать рынок", exact: true }).click(),
    },
    {
      name: "подтверждение ордера",
      tab: "Терминал",
      open: async (page) => {
        await page.locator(".desk-row").first().click();
        await page.getByRole("spinbutton", { name: "Размер, USD" }).fill("100000000");
        await page.getByRole("button", { name: /^Открыть long/ }).click();
      },
    },
    {
      name: "копирование лидера",
      tab: "Discover",
      open: async (page) => page.getByRole("button", { name: "Copy", exact: true }).first().click(),
    },
    {
      name: "сделка Predict",
      tab: "Predict",
      open: async (page) => page.getByRole("button", { name: /^Купить YES/ }).first().click(),
    },
    {
      name: "добавление позиции",
      tab: "Risk",
      open: async (page) => page.getByRole("button", { name: "+ Добавить", exact: true }).click(),
    },
  ];

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openWithData(page, { ...FULL_FIXTURE, stress: true });
    await page.addStyleTag({
      content: ":root{--fs-label:21px;--fs-data:24px;--fs-ui:26px;--fs-title:30px;--fs-price:clamp(52px,5.2vw,72px)}",
    });
  });

  for (const item of cases) {
    test(`${item.name}: обрезка, контраст, цели касания`, async ({ page }) => {
      await visitTab(page, item.tab);
      await item.open(page);
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.locator("html")).toHaveCSS("--fs-ui", "26px");
      const shell = page.locator(".wake-modal .overlay-shell");
      const overflow = await shell.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect.soft(overflow, "диалог не требует горизонтальной прокрутки").toBeLessThanOrEqual(1);
      const audit = await auditDesign(page, 44, ".wake-modal .overlay-shell");
      reportOffenders(`${item.name} clipping@320/200%`, audit.clipping);
      reportOffenders(`${item.name} contrast@320/200%`, audit.contrast);
      reportOffenders(`${item.name} touch@320/200%`, audit.touch);
      expect(audit.clipping).toEqual([]);
      expect(audit.contrast).toEqual([]);
      expect(audit.touch).toEqual([]);
      expect(audit.documentPan).toBe(0);
    });
  }
});

// Второй контур — не «много данных», а «данные с краёв диапазона»: тикер в 24
// символа, цена 1 234 567.891011, funding 42 % в час, PnL −999 999 999. Правдо-
// подобное значение колонка выдерживает молча, и переполнение видно только когда
// в неё приходит то, что человек не придумает сам. Строки с фиксированной
// высотой (окно списка, журнал) под таким текстом либо режут себя, либо ломают
// шаг — и то, и другое здесь красное.
test.describe("дизайн-инварианты на худших данных", () => {
  // Проверка обязана сама доказывать, что крайнее значение дошло до экрана:
  // иначе рефакторинг, который перестанет кормить панель фикстурой, оставит этот
  // контур зелёным и пустым. Что реально напечатано (замер): Обзор — «1 234 567…»
  // + тикер с «PERP-20…» + funding 42 %; Терминал и Funding — широкий тикер;
  // Discover и Портфель — длинный handle; Predict — и цена, и тикер.
  const MARKERS: Record<string, RegExp[]> = {
    // Как крайнее значение напечатано на самом деле (замер computed-текста):
    // обзор форматирует по en-US → «1,234,567», годовой funding из 0.42/ч →
    // «367920.0%», вопрос Predict несёт «1234567890» без разделителей, потому
    // что это часть строки, а не отформатированное число.
    "Обзор": [/1,234,567/, /PERP-20/, /367920\.0%/],
    "Терминал": [/PERP-20/],
    Discover: [/zeus-of-the-perp-vault/],
    "Портфель": [/zeus-of-the-perp-vault/, /PERP-20/],
    Earn: [],
    Predict: [/1234567890/, /PERP-20/],
    Агент: [],
    Risk: [],
    Funding: [/PERP-20/],
  };

  test.beforeEach(async ({ page }) => {
    await openWithData(page, { ...FULL_FIXTURE, stress: true });
  });

  for (const tab of TABS) {
    test(`${tab}: обрезка и контраст на крайних значениях`, async ({ page }) => {
      await visitTab(page, tab);
      const text = await page.evaluate(() => document.body.innerText);
      for (const marker of MARKERS[tab]) {
        expect(text, `${tab}: фикстура с крайним значением не дошла до экрана (${marker})`).toMatch(marker);
      }
      const audit = await auditDesign(page);
      reportOffenders(`${tab} clipping@stress`, audit.clipping);
      reportOffenders(`${tab} contrast@stress`, audit.contrast);
      expect(audit.clipping, `${tab}: крайнее значение не обрезается без скролла и многоточия`).toEqual([]);
      expect(audit.contrast, `${tab}: крайнее значение не теряет AA`).toEqual([]);
    });
  }

  test("390 px: худшие данные не ломают цели касания и не растят документ", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page, 44);
      offenders.push(...audit.touch.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
      expect(audit.documentPan, `${tab}: на 390 px с крайними числами страница не ездит боком`).toBe(0);
    }
    reportOffenders("touch@390-stress", offenders, 20);
    expect(offenders, "крайние числа не уменьшают цели касания").toEqual([]);
  });
});
