// Суровые проверки дизайна: они считаются по computed-стилям живого дерева, а не
// глазами по скриншоту. Методика — в ./design-audit.ts.
import { test, expect } from "@playwright/test";
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
      expect(audit.clipping, "текст не должен исчезать без скролла и без многоточия").toEqual([]);
      expect(audit.contrast, "4.5:1 для обычного текста, 3:1 для крупного").toEqual([]);
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

  // WCAG 1.4.10 (reflow): то, что обязано помещаться в 320 px, не имеет права
  // расплющиваться, когда человек крупнее читает. Заодно это ловит разницу
  // шрифтовых метрик: CI на Linux'овских шрифтах нашёл переполнение чипа на
  // 14 px там, где на машине автора строка влезала, — и локальный прогон был
  // зелёным. Удваиваются токены шкалы, а не zoom: шкала в теме задана числами,
  // и именно её обязаны выдерживать раскладка и nowrap-элементы.
  test("крупный текст: 320 px переживает удвоение шкалы", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent =
        ":root{--fs-label:21px;--fs-data:24px;--fs-ui:26px;--fs-title:30px;--fs-price:clamp(40px,6vw,60px)}";
      document.documentElement.appendChild(style);
    });
    const offenders: Offender[] = [];
    for (const tab of TABS) {
      await visitTab(page, tab);
      const audit = await auditDesign(page);
      offenders.push(...audit.clipping.map((o) => ({ ...o, where: `${tab} → ${o.where}` })));
      expect(audit.documentPan, `${tab}: на 320 px при крупном тексте страница не ездит боком`).toBe(0);
    }
    reportOffenders("clipping@200%", offenders, 20);
    expect(offenders, "при удвоенной шкале текст не за правым краем и не обрезан").toEqual([]);
  });
});
