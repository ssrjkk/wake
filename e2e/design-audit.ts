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
  /** Подсказки полей ввода: их нет в дереве, и обычный обход текста их не видит. */
  placeholders: Offender[];
  touch: Offender[];
  /** Поле без имени: с клавиатуры и с диктором оно неотличимо от соседнего. */
  names: Offender[];
  /** Кликабельная строка/карточка, до которой нельзя дотянуться Tab. */
  keyboard: Offender[];
  /** Насколько область прокрутки корня шире вьюпорта (px). */
  documentOverflow: number;
  /** До какого scrollX реально доезжает страница после попытки прокрутить (px). */
  documentPan: number;
};

function auditInBrowser(opts: { minTarget: number; root: string | null }): DesignAudit {
  const { minTarget } = opts;
  // Открытый диалог проверяется сам: панель за ним инертна, и её размеры — не
  // то, что человек в этот момент обязан прочитать или нажать.
  const scope: ParentNode =
    (opts.root ? document.querySelector(opts.root) : null) ?? document;
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
  // opacity родителя — не украшение: слой с opacity 0.5 гасит и букву, и её
  // подложку, поэтому контраст считается после применения всей цепочки.
  const opacityChain = (el: Element) => {
    let factor = 1;
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      factor *= Number(getComputedStyle(node).opacity || "1");
      node = node.parentElement;
    }
    return factor;
  };
  // Element с opacity ≈ 0 не нарисован, а значит ничего не обязан читать:
  // мерить его контраст — это ловить не нарушение, а момент анимации.
  const NOT_DRAWN = 0.02;
  const inkOn = (el: Element) => {
    const bgRaw = behind(el);
    const fg = parseColor(getComputedStyle(el).color);
    const alpha = fg ? fg.a * opacityChain(el) : 1;
    if (alpha < NOT_DRAWN) return null;
    if (!fg || alpha >= 0.999) return { fg: getComputedStyle(el).color, bg: bgRaw };
    const bg = parseColor(bgRaw)!;
    const m = over({ ...fg, a: alpha }, bg);
    return { fg: `rgb(${m.r}, ${m.g}, ${m.b})`, bg: bgRaw };
  };
  // Подсказка поля — отдельный текст, которого у проверки раньше не было
  // вовсе: ::placeholder не лежит в дереве, а именно он обязан отличаться от
  // введённого значения и читаться.
  const placeholders: Offender[] = [];
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

  for (const el of [...scope.querySelectorAll("*")]) {
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
    if (!ink) continue;
    const value = contrastOf(ink.fg, ink.bg);
    if (value < need) {
      contrast.push({
        what: `контраст ${value.toFixed(2)} < ${need}`,
        where: describe(el),
        value: `${ink.fg} на ${ink.bg} @${fontSize}px`,
      });
    }
  }

  for (const el of [...scope.querySelectorAll("input, textarea")] as (HTMLInputElement | HTMLTextAreaElement)[]) {
    if (!el.placeholder || !onScreen(el)) continue;
    const ph = getComputedStyle(el, "::placeholder");
    const fontSize = parseFloat(ph.fontSize || getComputedStyle(el).fontSize);
    const need = fontSize >= 24 ? 3 : 4.5;
    const bg = behind(el);
    const raw = parseColor(ph.color);
    const alpha = raw ? raw.a * opacityChain(el) * Number(ph.opacity || "1") : 1;
    if (alpha < NOT_DRAWN) continue;
    const bgRgb = parseColor(bg)!;
    const ink = raw ? over({ ...raw, a: alpha }, bgRgb) : null;
    const value = ink ? contrastOf(`rgb(${ink.r}, ${ink.g}, ${ink.b})`, bg) : 0;
    if (value < need) {
      placeholders.push({
        what: `контраст подсказки ${value.toFixed(2)} < ${need}`,
        where: describe(el),
        value: `${ph.color} на ${bg} @${fontSize}px`,
      });
    }
    // Подсказка, совпадающая с цветом значения, — это не подсказка: поле выглядит
    // заполненным там, где человек ещё ничего не ввёл.
    const own = getComputedStyle(el).color;
    if (own === ph.color) {
      placeholders.push({
        what: "подсказка печатается цветом значения",
        where: describe(el),
        value: `${ph.color} == ${own}`,
      });
    }
  }

  const touch: Offender[] = [];
  for (const el of [...scope.querySelectorAll("button, a[href], input, select, [role='button'], [role='tab']")]) {
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

  // Имя контрола. Плейсхолдер именем не считается: он исчезает, как только
  // человек начал вводить, и диктор читает «редактирование» вместо «Капитал на
  // обе ноги, USD». Проверка живёт здесь, а не в «ну пусть подписано», потому
  // что панель с двумя десятками полей неизбежно теряет одно.
  const names: Offender[] = [];
  for (const el of [...scope.querySelectorAll("input, select, textarea")] as (
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
  )[]) {
    if (!onScreen(el)) continue;
    // Чекбокс и радиометка живут внутри <label> — это валидное имя.
    if (el.closest("label")) continue;
    const id = el.getAttribute("id");
    const labelled =
      (id && scope.querySelector(`label[for="${CSS.escape(id)}"]`) != null) ||
      el.getAttribute("aria-label") != null ||
      el.getAttribute("aria-labelledby") != null ||
      (el.getAttribute("title") ?? "") !== "";
    if (!labelled) {
      names.push({
        what: "у поля нет доступного имени",
        where: `${el.tagName.toLowerCase()}.${((el.getAttribute("class") ?? "") as string).split(" ")[0]}${id ? `#${id}` : ""}`,
        value: `placeholder=${el.getAttribute("placeholder") ?? "нет"}`,
      });
    }
  }

  // Кликабельность без мыши. data-action даёт строке курсор и обработчик
  // onClick, но <tr> и <div> с обработчиком не являются фокусируемыми: с
  // клавиатуры и диктором такое действие не существует вообще. Требование
  // измеримое: внутри строки-действия обязан быть настоящий контрол.
  const keyboard: Offender[] = [];
  for (const el of [...scope.querySelectorAll("[data-action]")]) {
    if (!onScreen(el)) continue;
    const focusable = el.querySelector(
      "button:not([disabled]), a[href], input:not([type=hidden]), select, [tabindex]:not([tabindex='-1'])"
    );
    if (!focusable) {
      keyboard.push({
        what: "действие строки недоступно с клавиатуры",
        where: describe(el),
        value: "внутри нет ни кнопки, ни ссылки, ни поля",
      });
    }
  }

  return {
    clipping,
    contrast,
    placeholders,
    touch,
    names,
    keyboard,
    documentOverflow:
      scope === document
        ? document.documentElement.scrollWidth - document.documentElement.clientWidth
        : 0,
    documentPan,
  };
}

/** minTarget — нижняя граница цели касания для текущей ширины экрана.
 *  root — селект области (открытый диалог); без него меряется весь документ. */
export async function auditDesign(page: Page, minTarget = 24, root?: string): Promise<DesignAudit> {
  // Контраст и геометрия — свойства устойчивого состояния. Мигание тика,
  // fade-in строки ленты и переход цвета длятся 160–500 мс, и замер внутри
  // них даёт то «60 нарушений контраста» в Терминале, которых человек никогда
  // не видел: строка на полутаине. Анимации выключаются на время промера и
  // включаются обратно — проверка меряет то, что остаётся на экране.
  const tag = await page.addStyleTag({
    content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
  });
  try {
    return await page.evaluate(auditInBrowser, { minTarget, root: root ?? null });
  } finally {
    await tag.evaluate((el) => el.remove());
  }
}

/** Шкала темы: имена токенов размера из :root (index.css).
 *
 *  Список зеркалит тему нарочно: ?raw над CSS в этом проекте отдаёт пустое, а
 *  новый токен, не названный здесь, проявит себя как «размер вне шкалы» на
 *  любом его использовании — то есть расхождение видно, а не молчит. */
export const FS_TOKENS = [
  "--fs-label",
  "--fs-data",
  "--fs-ui",
  "--fs-body",
  "--fs-title",
  "--fs-heading",
  "--fs-metric",
  "--fs-figure",
  "--fs-wordmark",
  "--fs-price",
];

/** Каждый текстовый узел обязан печататься размером со шкалы темы.
 *
 *  Смысл: проверка «крупного текста» удваивает значения `--fs-*`, а элемент с
 *  `fontSize: "13px"` внутри панели удвоение не видит вообще. Пока это не
 *  измерялось, тест оставался зелёным при интерфейсе, который не масштабируется
 *  вовсе. Зеркалим не «до и после» (живая лента меняет число узлов между
 *  проходами), а «размер ∈ шкала»: допустимые значения измеряются теми же
 *  токенами в том же вьюпорте, включая fluid clamp-цены. */
export async function auditTypeScale(
  page: Page,
  tokens: string[] = FS_TOKENS,
  root?: string
): Promise<Offender[]> {
  return page.evaluate(
    ({ names, sel }) => {
      const scope: ParentNode = (sel ? document.querySelector(sel) : null) ?? document;
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;left:-9999px;top:0;";
      document.body.appendChild(probe);
      const allowed: number[] = [];
      for (const name of names) {
        probe.style.fontSize = `var(${name})`;
        const px = parseFloat(getComputedStyle(probe).fontSize);
        if (Number.isFinite(px)) allowed.push(px);
      }
      probe.remove();

      const out: Offender[] = [];
      for (const el of [...scope.querySelectorAll("*")]) {
        if (el.children.length !== 0) continue;
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        const box = el.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) continue;
        const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100;
        if (allowed.some((a) => Math.abs(a - px) < 0.02)) continue;
        out.push({
          what: `размер ${px}px вне шкалы (допустимо: ${allowed.sort((a, b) => a - b).join(", ")})`,
          where: `${el.tagName.toLowerCase()}.${((el.getAttribute("class") ?? "") as string).split(" ")[0]} «${text.slice(0, 28)}»`,
          value: "панель печатает размер числом — возьмите var(--fs-*)",
        });
      }
      return out;
    },
    { names: tokens, sel: root ?? null }
  );
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
  // Все замеры — после того, как приехали шрифты проекта. Без этого ожидания
  // гейт мерял метрики системного фолбэка: на машине автора Segoe UI, на
  // раннере DejaVu Sans, и одна и та же строка была зелёной локально и обрезанной
  // на 3 px в CI. Шрифты лежат в бандле, поэтому ожидание конечно и офлайново.
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('400 16px "Inter Variable"'),
      document.fonts.load('600 16px "Inter Variable"'),
      document.fonts.load('400 16px "JetBrains Mono Variable"'),
      document.fonts.load('900 40px "Azeret Mono Variable"'),
    ]);
    await document.fonts.ready;
  });
  return requests;
}
