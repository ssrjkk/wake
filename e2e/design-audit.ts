// Измерения дизайна: переполнение текста, контраст, видимый фокус, размеры целей
// касания и горизонтальное переполнение документа. Считаются в браузере по
// computed-стилям живого дерева — «на глаз» эти проверки не проходятся.
//
// Два правила, на которых держится точность:
//
// 1. Помощники объявлены ВНУТРИ функции, которая уходит в page.evaluate.
//    Playwright сериализует только её тело, и ссылка на внешнюю `contrastOf`
//    падает ReferenceError'ом в браузере: первая версия молча не находила ни
//    одного нарушения ровно там, где они были.
// 2. Фокус проверяется настоящей Tab-навигацией, а не element.focus(): после
//    клика программный focus не включает :focus-visible, и кольцо фокуса
//    выглядело бы отсутствующим на всех элементах сразу.
import { expect, type Page } from "@playwright/test";
import { installFixtures, type RequestLog } from "./fixtures";

export const TABS = ["Обзор", "Терминал", "Discover", "Портфель", "Earn", "Predict", "Агент", "Risk", "Funding"];

export type Offender = { what: string; where: string; value: string };

export type DesignAudit = {
  clipping: Offender[];
  contrast: Offender[];
  touch: Offender[];
  /** Насколько область прокрутки корня шире вьюпорта (px). */
  documentOverflow: number;
  /** До какого scrollX реально доезжает страница после попытки прокрутить (px). */
  documentPan: number;
};

function auditInBrowser(minTarget: number): DesignAudit {
  type Rgba = { r: number; g: number; b: number; a: number };
  const parseColor = (v: string | undefined | null): Rgba | null => {
    if (!v) return null;
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg: Rgba, bg: Rgba): Rgba => ({
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1,
  });
  const describe = (el: Element): string => {
    const own = el.textContent?.trim().slice(0, 36) ?? "";
    const cls = ((el.getAttribute("class") ?? "") as string).split(" ")[0] ?? "";
    const tag = el.tagName.toLowerCase();
    return own ? `${tag}.${cls} «${own}»` : `${tag}.${cls}`;
  };
  const hasText = (el: Element) => el.children.length === 0 && (el.textContent ?? "").trim().length > 0;
  const onScreen = (el: Element) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && el.getClientRects().length > 0;
  };
  const union = (a: DOMRect, b: DOMRect) => {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    const right = Math.max(a.right, b.right);
    const bottom = Math.max(a.bottom, b.bottom);
    return { width: right - left, height: bottom - top };
  };
  const luminance = (v: string) => {
    const c = parseColor(v);
    if (!c) return 0;
    const ch = [c.r, c.g, c.b].map((x) => {
      const x2 = x / 255;
      return x2 <= 0.03928 ? x2 / 12.92 : ((x2 + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const contrastOf = (fg: string, bg: string) => {
    const a = luminance(fg);
    const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  // Фон — не «первый непрозрачный предок», а вся стопка полупрозрачных слоёв
  // поверх него. Чип статуса печатает rgba(--down, 0.08) на собственной
  // подложке, и прошлая версия пропускала её к --bg-1: красные буквы давали
  // 5.05:1 там, где глаз видит 4.73:1. Разница в 0.3 — ровно то расстояние,
  // на котором нарушение выглядит нормальным.
  const behind = (el: Element) => {
    const layers: Rgba[] = [];
    let node: Element | null = el;
    let base: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    while (node) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) {
          base = c;
          break;
        }
      }
      node = node.parentElement;
    }
    let out = base;
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return `rgb(${out.r}, ${out.g}, ${out.b})`;
  };
  // Полупрозрачный текст (disabled, tint) тоже смешивается со своим фоном, а
  // не игнорируется: иначе серый «выключенный» контрол считался бы сплошным.
  const inkOn = (el: Element) => {
    const fg = parseColor(getComputedStyle(el).color);
    const bgRaw = behind(el);
    if (!fg || fg.a >= 0.999) return { fg: getComputedStyle(el).color, bg: bgRaw };
    const bg = parseColor(bgRaw)!;
    const m = over(fg, bg);
    return { fg: `rgb(${m.r}, ${m.g}, ${m.b})`, bg: bgRaw };
  };
  // Строка широкой таблицы «за правым краем» — не дефект, если её контейнер
  // скроллится: проверка обязана отличать обрезанное от досматриваемого.
  // overflow-x: hidden сюда сознательно НЕ входит — он и есть обрезка.
  const scrolls = (el: Element) => {
    let node: Element | null = el.parentElement;
    while (node && node !== document.body) {
      const s = getComputedStyle(node);
      if (s.overflowX === "auto" || s.overflowX === "scroll") return true;
      node = node.parentElement;
    }
    return false;
  };

  // Два числа про одно и то же, но отвечают на разные вопросы. scrollWidth
  // считает область прокрутки корня; scrollX после попытки прокрутить — то, что
  // человек действительно видит: страница едет боком или нет. На 320 px таблица
  // Обзора давала 771 и 451 соответственно, оставаясь внутри своего скроллера, —
  // одно без другого читается как «широкое содержимое» вместо «сломанная
  // вёрстка».
  const docWidth = document.documentElement.clientWidth;
  window.scrollTo(9_999, 0);
  const documentPan = window.scrollX;
  window.scrollTo(0, 0);
  const clipping: Offender[] = [];
  const contrast: Offender[] = [];

  for (const el of [...document.querySelectorAll("*")]) {
    if (!hasText(el) || !onScreen(el)) continue;
    const style = getComputedStyle(el);
    const scrollable = ["auto", "scroll"].includes(style.overflowX) || ["auto", "scroll"].includes(style.overflowY);
    const ellipsis = style.textOverflow === "ellipsis";
    const inScroller = scrolls(el);
    if (!scrollable && !ellipsis && !inScroller) {
      if (el.scrollWidth > el.clientWidth + 1) {
        clipping.push({ what: "обрезан по ширине", where: describe(el), value: `${el.scrollWidth}>${el.clientWidth}` });
      } else if (el.scrollHeight > el.clientHeight + 1 && style.overflowY === "hidden") {
        clipping.push({ what: "обрезан по высоте", where: describe(el), value: `${el.scrollHeight}>${el.clientHeight}` });
      }
    }
    const box = el.getBoundingClientRect();
    if (box.right > docWidth + 1 && box.left > 0 && !inScroller) {
      clipping.push({ what: "за правым краем экрана", where: describe(el), value: `right=${Math.round(box.right)}>${docWidth}` });
    }
    const fontSize = parseFloat(style.fontSize);
    const bold = parseFloat(style.fontWeight) >= 700;
    // WCAG 1.4.3: крупный текст (≥24 px, либо ≥18.66 px и жирный) — 3:1, остальной — 4.5:1.
    const need = fontSize >= 24 || (fontSize >= 18.66 && bold) ? 3 : 4.5;
    const ink = inkOn(el);
    const value = contrastOf(ink.fg, ink.bg);
    if (value < need) {
      contrast.push({
        what: `контраст ${value.toFixed(2)} < ${need}`,
        where: describe(el),
        value: `${ink.fg} на ${ink.bg} @${fontSize}px`,
      });
    }
  }

  const touch: Offender[] = [];
  for (const el of [...document.querySelectorAll("button, a[href], input, select, [role='button'], [role='tab']")]) {
    if (!onScreen(el)) continue;
    const box = el.getBoundingClientRect();
    // Зона нажатия флагова — метка: клик по подписи переключает его, и
    // измерять сам квадратик 24×24 значило бы искать нарушение там, где его
    // нет. Объединяем с <label>, если контрол внутри него.
    const label = el.closest("label");
    const area = label ? union(box, label.getBoundingClientRect()) : box;
    // Нижняя граница попадания: 44×44 на пальце (Apple HIG, Material), 24×24 на
    // указателе (WCAG 2.5.8 AA). Одно число на все ширины либо завалило бы
    // десктопный прибор, либо пропускало бы мелкие кнопки на телефоне.
    if (area.height < minTarget || area.width < minTarget) {
      touch.push({
        what: `цель касания меньше ${minTarget}×${minTarget}`,
        where: describe(el),
        value: `${Math.round(area.width)}×${Math.round(area.height)}`,
      });
    }
  }

  return {
    clipping,
    contrast,
    touch,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    documentPan,
  };
}

/** minTarget — нижняя граница цели касания для текущей ширины экрана. */
export async function auditDesign(page: Page, minTarget = 24): Promise<DesignAudit> {
  return page.evaluate(auditInBrowser, minTarget);
}

/** Кольцо фокуса на реальной Tab-навигации. */
export async function auditTabFocus(page: Page, steps = 45): Promise<Offender[]> {
  const out: Offender[] = [];
  const seen = new Set<string>();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  for (let i = 0; i < steps; i++) {
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: ((el.getAttribute("class") ?? "") as string).split(" ")[0] ?? "",
        text: (el.textContent ?? "").trim().slice(0, 24),
        outlineWidth: s.outlineWidth,
        outlineStyle: s.outlineStyle,
        boxShadow: s.boxShadow.slice(0, 40),
        visible: box.width > 0 && box.height > 0,
        wrapped: el === document.scrollingElement ? 1 : 0,
      };
    });
    if (!info) break;
    const key = `${info.tag}.${info.cls}.${info.text}`;
    if (!seen.has(key) && info.visible) {
      seen.add(key);
      const ring = (parseFloat(info.outlineWidth) > 0 && info.outlineStyle !== "none") || info.boxShadow !== "none";
      if (!ring) {
        out.push({
          what: "нет кольца фокуса на Tab",
          where: `${info.tag}.${info.cls} «${info.text}»`,
          value: `outline=${info.outlineWidth} ${info.outlineStyle}; shadow=${info.boxShadow}`,
        });
      }
    }
    await page.keyboard.press("Tab");
  }
  return out;
}

export function reportOffenders(name: string, offenders: Offender[], limit = 10) {
  if (!offenders.length) {
    console.log(`OK   ${name}`);
    return;
  }
  console.log(`FAIL ${name}: ${offenders.length}`);
  for (const o of offenders.slice(0, limit)) console.log(`     ${o.what} | ${o.where} | ${o.value}`);
}

export async function visitTab(page: Page, tab: string) {
  await page.getByRole("navigation").getByRole("button", { name: tab, exact: true }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(900);
}

/** Вход сессией + фикстуры + первая загрузка: общий preamble всех проверок. */
export async function openWithData(
  page: Page,
  options?: Parameters<typeof installFixtures>[1],
): Promise<RequestLog> {
  const requests = await installFixtures(page, options);
  await page.addInitScript(() => {
    localStorage.setItem(
      "wake.session.v1",
      JSON.stringify({
        token: "wk1.test.test",
        userId: "0x" + "11".repeat(20),
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        lighterAccountIndex: 4242,
        label: "test",
        via: "wallet",
      }),
    );
  });
  await page.goto("/");
  return requests;
}
