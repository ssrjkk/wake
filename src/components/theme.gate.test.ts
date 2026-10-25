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

// Зеркало :root из index.css.
const TOKENS = new Set(
  `#0b0b0c #101011 #161618 #1c1c1f #232326 #303035 #e6e6e8 #a0a0a7 #75757d
   #ff6b35 #0a0a0a #ff8c5a #10b981 #ef4444 #3b82f6 #fbbf24`.split(/\s+/),
);

// Наследие: поверхности и тексты, которые панели до сих пор печатают числом.
// Заменять на var(...) — по одному файлу за раз, с проверкой снимком.
const LEGACY = new Set(
  `#04100b #0a1a2a #0a2a1a #111 #1a1500 #1a1a1a #1a3050 #1a3d2a #1e1e1e
   #2563eb #2a0a0a #2a1a0a #2a2000 #2a2a2a #333 #3a3a3a #3d1a1a #3d3000 #4d3310
   #5c1a1a #5c3a1a #60a5fa #666 #7f1d1d #888 #a0a0a0 #aaa #ccc #fafafa #f59e0b
   #fff`.split(/\s+/),
);

const BANNED: [RegExp, string][] = [
  [/linear-gradient|radial-gradient|conic-gradient/, "градиент фона"],
  [/boxShadow|textShadow/, "тень"],
  [/backdrop-filter|backdropFilter/, "блюр под слоем"],
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
