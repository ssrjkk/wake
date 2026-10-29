import { describe, expect, it } from "vitest";

// Гейт темы. В index.css записано правило, которое легко нарушить молча:
// «Градиентов и блюра нет намеренно: это приборная панель». Пока за соблюдением
// следил только ревьюер, панели однажды вернулись к linear-gradient и boxShadow
// (так и случилось в Predict и Dashboard), и экран перестал выглядеть одним
// прибором. Здесь то же самое проверяет машина.
//
// Второе правило — про палитру: значения вне токенов темы не запрещены
// исторически, но каждый новый литерал обязывает смотреть на все девять панелей,
// чтобы понять, где ещё «#a0a0a0» против «--fg-2». LEGACY — список того, что
// осталось от старых правок; он умеет только сохнуть, и последняя проверка следит
// за этим в обе стороны.
//
// Источники читаются glob'ом Vite, а не с диска: тест живёт в src/ и входит в
// проект tsconfig, где узловых типов нет (включать их нельзя — setTimeout
// переезжает на нодовую сигнатуру и половина панелей перестаёт типизироваться).
// index.css так прочитать не выходит (Vite отдаёт ?raw над CSS пустым), поэтому
// TOKENS ниже — зеркало :root. Расхождение стоит читать так: гейт пропустит
// литерал, равный старому значению токена, но нового цвета мимо списка он не
// пропустит никогда.

const sources = {
  ...import.meta.glob("/src/App.tsx", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("/src/components/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
};

const files = Object.entries(sources).map(([file, text]) => ({
  file: file.replace(/^\/src\//, ""),
  text,
}));

// Зеркало :root из index.css: имя токена → значение. TOKENS выводится отсюда,
// поэтому токен, добавленный в тему и забытый здесь, перестаёт быть разрешённым
// цветом в панелях — разойтись молча он не может.
const TOKEN_VALUES: Record<string, string> = {
  "--bg-0": "#0b0b0c",
  "--bg-1": "#101011",
  "--bg-2": "#161618",
  "--bg-3": "#1c1c1f",
  "--line": "#232326",
  "--line-strong": "#303035",
  "--fg": "#e6e6e8",
  "--fg-2": "#a0a0a7",
  "--fg-3": "#8f8f97",
  "--accent": "#ff6b35",
  "--accent-hi": "#ff8c5a",
  "--on-accent": "#0a0a0a",
  "--up": "#10b981",
  "--down": "#ef4444",
  "--down-hi": "#f87171",
  "--info": "#60a5fa",
  "--warn": "#fbbf24",
};

const TOKENS = new Set(Object.values(TOKEN_VALUES));

// Наследие: поверхности и тексты, которые панели до сих пор печатают числом.
// Пустой список — не формальность: панели переводились на var(--...) до последней
// литеры, и с этого места любая новая литера вне токенов красная сразу. Возвращать
// сюда значение можно только вместе с причиной (например палитра категорий,
// которой в токенах места нет).
const LEGACY = new Set<string>([]);

const BANNED: [RegExp, string][] = [
  [/linear-gradient|radial-gradient|conic-gradient/, "градиент фона"],
  [/boxShadow|textShadow/, "тень"],
  [/backdrop-filter|backdropFilter/, "блюр под слоем"],
  // Кольцо фокуса рисует index.css: `:focus-visible { outline: 2px solid
  // var(--accent) !important }`. Отказ от outline в панели поэтому не ломает
  // клавиатуру сегодня — он ломает её в тот день, когда правило правят, и
  // молча: проверить это может только браузер. Плюс `outline: none` в JSX
  // означает «здесь фокус не нужен», что для поля ввода неправда. Кавычки и
  // хвостовая форма (`outline-none`) обязательны: прошлая версия вида
  // /outline:\s*none/ не совпадала ни с `outline: "none"` в Risk, ни с
  // Tailwind-классом в App.tsx, и три поля печатали отказ от фокуса инлайном.
  [/outline:\s*["']?(none|0)\b|outline-(none|0)\b/, "снятый outline вне правил темы"],
  // rgba(...) числом — второй способ нарисовать цвет вне темы: hex-проверка его
  // не видит, а именно так в панелях завели четыре разных «красный статус».
  // Прозрачные слои темы живут в TINT_VALUES и вызываются как var(--...).
  [/rgba?\s*\(/, "цвет числом через rgb()/rgba() — возьмите токен темы"],
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

describe("тема: ни градиентов, ни теней, ни новых цветов вне токенов", () => {
  it("читает все панели", () => {
    // Гейт проверяет себя: пустой список источников сделал бы его зелёным
    // навсегда.
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  for (const { file, text } of files) {
    it(`${file}: без эффектов, которых нет в теме`, () => {
      const hits = BANNED.filter(([re]) => re.test(text)).map(([, label]) => label);
      expect(hits, `${file}: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("каждый цвет в панелях — либо токен темы, либо наследие из списка", () => {
    const allowed = new Set([...TOKENS, ...LEGACY]);
    const off: string[] = [];
    for (const { file, text } of files) {
      for (const hex of text.match(HEX) ?? []) {
        if (!allowed.has(hex.toLowerCase())) off.push(`${file}: ${hex}`);
      }
    }
    expect(off, "новых значений нет в токенах — возьмите var(--...)").toEqual([]);
  });

  it("список наследия не держит то, чего уже нет", () => {
    // Рычаг и в другую сторону: починили панель — уберите значение из LEGACY,
    // иначе тест перестанет замечать, что оно вернулось.
    const used = new Set(
      files.flatMap(({ text }) => (text.match(HEX) ?? []).map((hex) => hex.toLowerCase())),
    );
    const stale = [...LEGACY].filter((hex) => !used.has(hex) && !TOKENS.has(hex));
    expect(stale, `устаревшие значения всё ещё в списке: ${stale.join(" ")}`).toEqual([]);
  });
});

// ── Контраст токенов: числа, а не вкус ──────────────────────────────────────
//
// Пороги взяты не «на глаз»: они равняются на WCAG 2.1 (1.4.3 — 4.5:1 для
// обычного текста, 1.4.11 — 3:1 для нефоровых частей интерфейса), а фактические
// отношения считаются из тех же hex'ов, что лежат в зеркале темы выше. Это и
// есть причина, по которой тема существует как значения, а не как имена:
// #75757d на #1c1c1f давал 3.72:1 — «серый подписьный текст» выглядел нормально
// на мониторе автора и был нечитаем в таблице.

const PANELS = ["--bg-0", "--bg-1", "--bg-2", "--bg-3"] as const;

/** Токены, которые тема использует как цвет текста или цифр. */
const TEXTS = ["--fg", "--fg-2", "--fg-3", "--accent", "--accent-hi", "--up", "--down", "--down-hi", "--info", "--warn"] as const;

/** Заполненные поверхности, на которые тема кладёт тёмные чернила. */
const FILLS = ["--accent", "--up", "--down"] as const;

// Зеркало прозрачных слоёв темы — подложек статусов. Отдельно от TOKEN_VALUES
// нарочно: TOKEN_VALUES удваивается как список разрешённых литералов в панелях,
// а rgba(...) панели печатать не имеют права (см. BANNED ниже) — только токен.
const TINT_VALUES: Record<string, string> = {
  "--up-faint": "rgba(16, 185, 129, 0.14)",
  "--down-faint": "rgba(239, 68, 68, 0.14)",
  "--info-faint": "rgba(96, 165, 250, 0.12)",
  "--warn-faint": "rgba(251, 191, 36, 0.12)",
  "--accent-dim": "rgba(255, 107, 53, 0.12)",
};

// Подпись статуса печатается цветом, который лежит и в её собственной подложке.
// Это единственная пара в теме, где контраст считается не «буквы против слоя», а
// «буквы против слоя, в который те же буквы уже подмешаны»: красным по красной
// подложке журнал копи-движка давал 4.44:1, и ни одна проверка «текст на панели»
// этого не видела, потому что подложка была прозрачной.
const TINTED: [text: string, tint: string][] = [
  ["--up", "--up-faint"],
  ["--down-hi", "--down-faint"],
  ["--info", "--info-faint"],
  ["--warn", "--warn-faint"],
  ["--accent", "--accent-dim"],
];

function channel(hex: string, from: number): number {
  const value = parseInt(hex.slice(from, from + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return (
    0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
  );
}

function contrast(a: string, b: string): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function asHex(channels: [number, number, number]): string {
  return `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/** Смешать прозрачный слой с непрозрачной подложкой так, как это делает браузер. */
function over(tint: string, surface: string): string {
  const m = tint.match(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/);
  if (!m) throw new Error(`не-rgba токен подложки: ${tint}`);
  const [r, g, b] = [+m[1], +m[2], +m[3]];
  const a = +m[4];
  const base = rgb(surface);
  return asHex([r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)]);
}

describe("тема: контраст считается из значений токенов", () => {
  it("каждый текстовый токен читается на каждой поверхности панели (4.5:1)", () => {
    const weak: string[] = [];
    for (const text of TEXTS) {
      for (const surface of PANELS) {
        const ratio = contrast(TOKEN_VALUES[text], TOKEN_VALUES[surface]);
        if (ratio < 4.5) weak.push(`${text} на ${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(weak, "подписи и числа темы обязаны давать WCAG AA на всех слоях панели").toEqual([]);
  });

  it("тёмные чернила на заполненном статусе читаются (4.5:1)", () => {
    const weak: string[] = [];
    for (const fill of FILLS) {
      const ratio = contrast(TOKEN_VALUES["--on-accent"], TOKEN_VALUES[fill]);
      if (ratio < 4.5) weak.push(`--on-accent на ${fill}: ${ratio.toFixed(2)}`);
    }
    expect(weak, "текст кнопки и чипа статуса — тёмным по цвету-заполнению").toEqual([]);
  });

  it("подпись статуса читается на своей подложке (4.5:1)", () => {
    // Именно здесь тема ломалась молча: красный текст на красной подложке
    // оставался «красным на тёмном» для проверки глазами и давал 4.44:1 в
    // живом дереве. Подложка смешивается с каждой поверхностью панели, потому
    // что чип одинаково живёт и на --bg-0, и на --bg-3.
    const weak: string[] = [];
    for (const [text, tint] of TINTED) {
      for (const surface of PANELS) {
        const ratio = contrast(TOKEN_VALUES[text], over(TINT_VALUES[tint], TOKEN_VALUES[surface]));
        if (ratio < 4.5) weak.push(`${text} на ${tint}+${surface}: ${ratio.toFixed(2)}`);
      }
    }
    expect(weak, "прозрачный слой под текстом обязан входить в его фон").toEqual([]);
  });

  it("кольцо фокуса заметно на любой поверхности (3:1)", () => {
    // 1.4.11 про нефоровые части: кольцо :focus-visible рисуется токеном marca,
    // и оно обязано быть видно на любом из слоёв панели. Границы (--line,
    // --line-strong) под проверку не попадают нарочно: это hairline между
    // панелями, а не идентификатор компонента — контрол различается ещё и
    // подложкой, а поднять его до 3:1 означало бы белую сетку вместо прибора.
    const weak: string[] = [];
    for (const surface of PANELS) {
      const ratio = contrast(TOKEN_VALUES["--accent"], TOKEN_VALUES[surface]);
      if (ratio < 3) weak.push(`--accent на ${surface}: ${ratio.toFixed(2)}`);
    }
    expect(weak).toEqual([]);
  });

  it("ни один токен текста не совпадает со своим фоном", () => {
    // Отдельная ловушка: #fff на #fff проходит любую «равен ли цвет фону»
    // проверку только если сравнивать отношения, а не строки.
    for (const text of TEXTS) {
      for (const surface of PANELS) {
        expect(TOKEN_VALUES[text]).not.toBe(TOKEN_VALUES[surface]);
      }
    }
  });
});

// ── Типографика и поведение мыши: размер буквы обязан жить в шкале ──────────
//
// Повод: проверка «крупного текста» (e2e/design-gate.spec.ts) удваивает значения
// `--fs-*` и смотрит, выдержит ли вёрстка. Панель с `fontSize: "13px"` внутри
// удвоение не видит в принципе — то есть тест оставался зелёным при половине
// интерфейса, нечувствительной к масштабу: 219 таких мест в десяти файлах.
// Причина, по которой размер печатается токеном, не в стиле, а в том, что
// только токен переживает правку шкалы и пользовательское масштабирование текста.

/** Шкала из :root (index.css). Зеркало нарочно: ?raw над CSS в этом проекте
 *  отдаёт пустое, поэтому расхождение «токен добавлен в тему, но не назван
 *  здесь» читается как лишняя строка в списке, а не как пропущенное нарушение. */
const FS_TOKENS = [
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
] as const;

const TYPO_BANNED: [RegExp, string][] = [
  [/fontSize:\s*["'`][0-9.]+\s*px/, "размер шрифта числом — возьмите var(--fs-*)"],
  [/fontSize:\s*[0-9.]+\s*px/, "размер шрифта числом — возьмите var(--fs-*)"],
  [/fontFamily:\s*["'`](?!var\()/, "шрифт числом — возьмите var(--font-mono) или var(--font-display)"],
  // Наведение мышью рисует CSS: обработчик на строку это слушатель на каждую
  // строку списка, цвет, который панель держит строкой, и состояние, которое
  // молчит на Tab (фокус ≠ hover).
  [/onMouseEnter=|onMouseLeave=/, "наведение через JS — правило :hover в index.css"],
  // В Telegram-мини-аппе нативных диалогов нет: кнопка с window.confirm не
  // делает ничего, и проверить это можно только живым вебвью.
  [/window\.(confirm|alert|prompt)\s*\(/, "нативный диалог — вместо него Modal из ui.tsx"],
];

describe("панели: шкала текста и поведение мыши", () => {
  for (const { file, text } of files) {
    it(`${file}: размеры и шрифты берутся из токенов, hover живёт в CSS`, () => {
      const hits = [
        ...new Set(
          TYPO_BANNED.filter(([re]) => re.test(text)).map(([, label]) => label)
        ),
      ];
      expect(hits, `${file}: ${hits.join("; ")}`).toEqual([]);
    });
  }

  it("панели печатают только объявленные токены шкалы", () => {
    const used = new Set(
      files.flatMap(({ text }) => [...text.matchAll(/var\((--fs-[a-z]+)\)/g)].map((m) => m[1]))
    );
    const unknown = [...used].filter((name) => !(FS_TOKENS as readonly string[]).includes(name));
    expect(unknown, "токена нет в :root — браузер вернёт невалидное значение и размер уедет в наследуемый").toEqual([]);
  });

  it("гейт видит файлы панелей", () => {
    // Пустой список источников сделал бы обе проверки зелёными навсегда.
    expect(files.length).toBeGreaterThanOrEqual(12);
  });
});
