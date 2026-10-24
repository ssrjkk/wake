// Фирменные растровые ассеты Wake: public/og.png (превью ссылки в Telegram,
// 1200×630) и public/apple-touch-icon.png (180×180, иконка «на домашний экран»
// iOS — SVG там не принимается).
//
// Запуск:  node scripts/brand-assets.mjs
//
// Playwright уже в dev-зависимостях (его гоняет e2e), отдельных инструментов для
// рендера нет. Чисел на карточке нет намеренно: превью ссылки не должно выдавать
// выдуманный график за живые данные.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = (name) => path.join(root, "public", name);

const MARK = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="12" fill="#ff6b35"/>
  <path transform="translate(9.5 9.5) scale(1.875)" fill="#0a0a0a" d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>
</svg>`;

const STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Azeret+Mono:wght@900&display=block');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #0b0b0c; }
  body { font-family: Inter, system-ui, sans-serif; color: #e6e6e8; -webkit-font-smoothing: antialiased; }
  .plate { position: relative; overflow: hidden; background:
      radial-gradient(120% 140% at 100% 0%, rgba(255,107,53,0.10) 0%, rgba(11,11,12,0) 55%), #0b0b0c; }
  .mark { display: flex; align-items: center; gap: 26px; }
  .mark svg { width: 88px; height: 88px; }
  .wordmark { font-family: 'Azeret Mono', monospace; font-weight: 900; letter-spacing: -0.06em;
              text-transform: uppercase; color: #f4f4f5; font-size: 92px; line-height: 1; }
  .lede { font-size: 38px; line-height: 1.35; color: #a0a0a7; max-width: 30ch; font-weight: 400; }
  .accent { color: #ff6b35; }
  .rule { width: 100%; height: 1px; background: #232326; }
  .sections { display: flex; flex-wrap: wrap; gap: 12px 10px; font-family: 'JetBrains Mono', monospace;
              font-size: 20px; color: #75757d; }
  .sections span { border: 1px solid #232326; border-radius: 4px; padding: 8px 14px; background: #101011; }
  .foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
  .foot .src { font-size: 23px; color: #75757d; }
  .foot .src b { color: #a0a0a7; font-weight: 500; }
  .foot .url { font-family: 'JetBrains Mono', monospace; font-size: 23px; color: #e6e6e8; white-space: nowrap; }
  .grid { position: absolute; inset: 0; opacity: 0.5; background-image:
      linear-gradient(#141416 1px, transparent 1px), linear-gradient(90deg, #141416 1px, transparent 1px);
      background-size: 96px 96px; mask-image: radial-gradient(80% 60% at 90% 100%, #000 0%, transparent 70%); }
`;

const OG = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>${STYLE}
  .plate { width: 1200px; height: 630px; padding: 64px 72px 56px; display: flex; flex-direction: column; gap: 38px; }
</style></head><body><div class="plate">
  <div class="grid"></div>
  <div class="mark"><span>${MARK}</span><span class="wordmark">Wake</span></div>
  <div class="lede">Терминал Lighter: <span class="accent">перпы, копи-трейдинг</span> и бинарные Predict-рынки</div>
  <div class="rule"></div>
  <div class="sections">
    <span>Обзор</span><span>Терминал</span><span>Discover</span><span>Портфель</span><span>Earn</span>
    <span>Predict</span><span>Агент</span><span>Risk</span><span>Funding</span>
  </div>
  <div class="foot">
    <span class="src">Числа — <b>публичный REST Lighter</b>, без посредников</span>
    <span class="url">wake-7k6.pages.dev</span>
  </div>
</div></body></html>`;

const ICON = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{width:180px;height:180px;background:#0b0b0c}
  svg{display:block;width:180px;height:180px}</style></head><body>${MARK}</body></html>`;

const browser = await chromium.launch();
try {
  const shots = [
    { html: OG, file: out("og.png"), width: 1200, height: 630 },
    { html: ICON, file: out("apple-touch-icon.png"), width: 180, height: 180 },
  ];
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
    await page.setContent(shot.html, { waitUntil: "networkidle" });
    // Ждём отдачу Google Fonts: без этого снимок уходит с системным шрифтом, и
    // кириллица в слове «терминал» на картинке будет набрана Arial.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: shot.file });
    await page.close();
    console.log(path.relative(root, shot.file));
  }
} finally {
  await browser.close();
}
