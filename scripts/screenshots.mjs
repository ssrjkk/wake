// Снимки панелей для README. Живые данные площадок, production-сборка, никакого
// мока и никаких фикстур: `e2e/fixtures.ts` кормит гейты синтетикой, а здесь
// ровно то, что видит посетитель сайта.
//
// Запуск: npm run build && node scripts/screenshots.mjs
//
// Скрипт существует потому, что снимки расходились со сборкой молча: к 2026-11-17
// на диске лежали картинка с линией вместо свечей (свечи — 969c781) и стакан из
// шести уровней (сейчас двадцать), а README про эти же панели утверждал обратное.
// Панель открывается кликом по роли, как в `e2e/design-audit.ts`, и ждётся по
// состоянию, а не по таймеру: скелетон и вчерашняя панель на глаз похожи.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SHOT_PORT ?? 4179);
const BASE = `http://${HOST}:${PORT}`;
const OUT = resolve(import.meta.dirname, "..", "docs", "screenshots");

// name — то, что написано на вкладке; file — имя в README; wait — чем доказать,
// что данные приехали, а не просто панель смонтировалась.
const PANELS = [
  { tab: "Обзор", file: "overview-1440.png" },
  { tab: "Терминал", file: "terminal-1440.png", fullPage: true, book: true },
  { tab: "Discover", file: "discover-1440.png" },
  { tab: "Портфель", file: "portfolio-1440.png" },
  { tab: "Earn", file: "earn-1440.png" },
  { tab: "Predict", file: "predict-1440.png" },
  { tab: "Агент", file: "agent-1440.png" },
  { tab: "Risk", file: "risk-1440.png" },
  { tab: "Funding", file: "funding-1440.png" },
];

const log = (...args) => console.log(...args);

async function waitForServer(serverDied, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Порт мог достаться чужому процессу: поверить, что он отвечает, значит
    // снять кадр с чужой сборки и подписать его этой. Поэтому ждём и свой exit.
    const reason = serverDied();
    if (reason) throw new Error(`preview завершился, не поднявшись: ${reason}`);
    try {
      const resp = await fetch(BASE, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) return;
    } catch {
      // сервер ещё не поднялся
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`preview не ответил на ${BASE} за ${timeoutMs} мс`);
}

/** Клик по вкладке + ожидание именно той панели, чей id она называет. */
async function openTab(page, tab) {
  const item = page.getByRole("tablist").getByRole("tab", { name: tab, exact: true });
  await item.click();
  await item.evaluate((node) => {
    if (node.getAttribute("aria-selected") !== "true") throw new Error(`вкладка «${node.textContent}» не выбрана`);
  });
  const tabId = await item.evaluate((node) => node.id);
  const panel = page.locator(`[role="tabpanel"][aria-labelledby="${tabId}"]`);
  await panel.waitFor({ state: "visible", timeout: 20_000 });
  await panel.locator(".skeleton").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {
    // Панель без скелетонов — значит данные либо приехали, либо их не будет
    // (бэкенд поднят и отвечает деградацией). Это тоже снимок, а не ошибка.
  });
  return panel;
}

/** Часы «обновлено HH:MM:SS» — единственное доказательство, что ответ площадки
 * доехал до экрана: без него кадр мог быть снят по пустой панели. */
async function waitForLiveClock(page) {
  await page
    .getByText(/обновлено \d{2}:\d{2}/)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function shoot(page, panel, { fullPage = false, book = false } = {}) {
  if (book) {
    await waitForLiveClock(page);
    // Свечи пишутся на canvas после ответа, а строки стакана — из того же
    // опроса: ждём обе таблицы уровней, иначе кадр мог застать линию-предка.
    await page.locator("table.book-table").first().waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(1_500);
  } else {
    await page.waitForTimeout(700);
  }
  const file = resolve(OUT, panel.file);
  await page.screenshot({ path: file, fullPage });
  return file;
}

/** Сколько уровней на сторону реально на экране — цифра для подписи в README. */
async function measureBook(page) {
  return page.evaluate(() => {
    const book = document.querySelector("table.book-table");
    const bodies = book ? [...book.querySelectorAll("tbody")] : [];
    const levels = bodies.map((tb) => tb.querySelectorAll("tr").length);
    const counts = [...document.querySelectorAll(".book-imb-cell b")].map((n) => n.textContent.trim());
    return {
      levels: { asks: levels[0] ?? 0, bids: levels[1] ?? 0 },
      printed: counts,
      canvas: Boolean(document.querySelector("canvas")),
    };
  });
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(OUT, { recursive: true });
  const server = spawn(
    process.execPath,
    [resolve(root, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", HOST, "--port", String(PORT), "--strictPort"],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (b) => process.stdout.write(`[preview] ${b}`));
  server.stderr.on("data", (b) => process.stderr.write(`[preview] ${b}`));
  let serverExit = null;
  server.once("exit", (code, signal) => {
    serverExit = `код ${code ?? "—"}${signal ? `/сигнал ${signal}` : ""}`;
  });

  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  try {
    await waitForServer(() => serverExit);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    for (const panel of PANELS) {
      await openTab(page, panel.tab);
      const file = await shoot(page, panel, panel);
      const extra = panel.book ? " " + JSON.stringify(await measureBook(page)) : "";
      log(`OK   ${panel.file}${extra}`);
    }
    await context.close();

    // 390 — телефон: тот же прибор в столбик, кадр прокручен к стакану и ленте.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const mpage = await mobile.newPage();
    await mpage.goto(BASE, { waitUntil: "networkidle" });
    await mpage.evaluate(() => document.fonts.ready);
    await openTab(mpage, "Терминал");
    await waitForLiveClock(mpage);
    await mpage.locator(".book-panel").scrollIntoViewIfNeeded();
    await mpage.waitForTimeout(1_200);
    await mpage.screenshot({ path: resolve(OUT, "terminal-390.png") });
    log("OK   terminal-390.png");
    await mobile.close();

    // Карточки бота рисует не сайт, а `backend/telegram_bot.py`: python собирает
    // страницу из тех же payload-функций, что уходят в чат, браузер снимает её.
    // Файл лежит в tmp, а шрифты подгружаются с file:// — без этого флага
    // chromium блокирует локальный @font-face, и числа набирались бы системным
    // моно вместо того же шрифта, что в карточке чата.
    const cardsHtml = resolve(tmpdir(), "wake-bot-cards.html");
    const py = await new Promise((done) => {
      const child = spawn(
        "python",
        [resolve(root, "scripts", "telegram-cards.py"), "--out", cardsHtml],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
      );
      let out = "";
      child.stdout.on("data", (b) => {
        out += b;
        process.stdout.write(String(b));
      });
      child.stderr.on("data", (b) => process.stderr.write(`[cards] ${b}`));
      child.on("exit", (code) => done({ code, out }));
    });
    if (py.code !== 0) throw new Error(`telegram-cards.py завершился с кодом ${py.code}`);
    const cards = await browser.newContext({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 1 });
    const cpage = await cards.newPage();
    await cpage.goto(`file:///${cardsHtml.replace(/\\/g, "/")}`, { waitUntil: "load" });
    await cpage.evaluate(() => document.fonts.ready);
    await cpage.screenshot({ path: resolve(OUT, "bot-cards.png"), fullPage: true });
    log("OK   bot-cards.png");
    await cards.close();
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((e) => {
  log(`FAIL ${e.message}`);
  writeFileSync(resolve(OUT, ".shot-error"), String(e.stack ?? e));
  process.exit(1);
});
