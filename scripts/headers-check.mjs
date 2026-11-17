// Проверка заголовков Pages на собранном сайте.
//
// Зачем она нужна: `vite preview` заголовки из public/_headers не отдаёт — их
// применяет Cloudflare Pages при выдаче, то есть единственный способ увидеть
// свой CSP до деплоя — применить его самому. Скрипт поднимает dist с теми же
// правилами, что лежат в _headers, проходит в браузере каждую панель и модальное
// окно кошелька и требует нуля нарушений политики.
//
// Что проверка НЕ доказывает: как именно Pages сливает несколько подходящих
// правил и какие заголовки добавляет сам (https-редирект, свои дефолты). Это
// видно только curl по живому адресу после деплоя, и об этом сказано в отчёте.

import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.HEADERS_PORT ?? 4188);
const BASE = `http://${HOST}:${PORT}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** Разбор public/_headers: блоки «путь» + отступные заголовки, комментарии #. */
function parseHeaders(file) {
  const rules = [];
  let current = null;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
    } else if (current) {
      const idx = line.indexOf(":");
      if (idx === -1) throw new Error(`_headers: строка без двоеточия: ${line}`);
      current.headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
  }
  return rules;
}

/** Подходящие правила: от самых специфичных к общим, конфликт решает первое. */
function headersFor(rules, pathname) {
  const matched = rules
    .filter((r) => r.pattern === pathname || (r.pattern.endsWith("/*") && pathname.startsWith(r.pattern.slice(0, -1))))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const out = {};
  for (const rule of matched) for (const [k, v] of Object.entries(rule.headers)) if (!(k in out)) out[k] = v;
  return out;
}

const rules = existsSync(join(ROOT, "public", "_headers"))
  ? parseHeaders(join(ROOT, "public", "_headers"))
  : [];
if (rules.length === 0) throw new Error("public/_headers пустой или не найден — проверять нечего");

// Кэш-политика — ровно та, ради которой файл и заведён: хэшированные файлы
// неизменяемы, index.html проверяется каждый заход. Если Pages когда-нибудь
// поменяет дефолты, здесь это видно до деплоя.
const assetRule = rules.find((r) => r.pattern === "/assets/*");
const cacheAsset = assetRule?.headers["cache-control"] ?? "";
if (!/max-age=31536000/.test(cacheAsset) || !/immutable/.test(cacheAsset)) {
  throw new Error(`/assets/* должен отдаваться с годовым immutable, а не "${cacheAsset || "нет правила"}"`);
}
const htmlRule = rules.find((r) => r.pattern === "/index.html");
if (!/max-age=0/.test(htmlRule?.headers["cache-control"] ?? "")) {
  throw new Error("index.html обязан проверяться каждый заход: в нём имена чанков этого билда");
}

// Собранная страница обязана не содержать непоставленных подстановок: Vite
// подставляет свои %VITE_*% и молча оставляет чужие, поэтому canonical с
// литералом "%SITE_URL%" уехал бы на прод как битая ссылка на себя же.
const builtHtml = readFileSync(join(DIST, "index.html"), "utf8");
const left = builtHtml.match(/%[A-Z_]+%/g);
if (left) throw new Error(`в dist/index.html остались подстановки: ${[...new Set(left)].join(", ")}`);

// preconnect греет соединение молча, если смотрит не туда, куда ходит бандл:
// сравниваем хост из HTML с хостом, который физически лежит в собранных чанках.
const preconnect = builtHtml.match(/rel="preconnect" href="https:\/\/([^/"]+)"/);
if (!preconnect) throw new Error("в dist/index.html нет preconnect на узел Lighter");
const bundleHosts = new Set();
for (const name of (await readdir(join(DIST, "assets"))).filter((n) => n.endsWith(".js"))) {
  for (const m of readFileSync(join(DIST, "assets", name), "utf8").matchAll(/https:\/\/([a-z0-9.-]*zklighter[a-z0-9.-]*)/g)) {
    bundleHosts.add(m[1]);
  }
}
if (!bundleHosts.has(preconnect[1])) {
  throw new Error(
    `preconnect греет ${preconnect[1]}, а бандл ходит в ${[...bundleHosts].join(", ") || "никуда"} — сети разъехались`,
  );
}
console.log(`OK   preconnect совпадает с узлом бандла: ${preconnect[1]}`);

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
  const index = join(DIST, "index.html");
  const wanted = pathname === "/" ? index : join(DIST, pathname);
  let file = wanted;
  try {
    const info = await stat(wanted);
    if (info.isDirectory()) file = join(wanted, "index.html");
  } catch {
    // Точка в точку как public/_redirects: /* -> /index.html 200.
    file = index;
  }
  if (!wanted.startsWith(DIST + sep) && wanted !== DIST) file = index;
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      ...headersFor(rules, pathname),
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
});

await new Promise((r) => server.listen(PORT, HOST, r));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();

// Формулировок у нарушения две: консоль фрейма пишет «violates the following
// report-only Content Security Policy directive» — со вставкой между «following»
// и «Content», — а eval-страница пишет обычную фразу и помечает себя отдельно
// (см. isReportOnly). Регулярка без этой вставки молча не досчитывается ровно тех
// нарушений, которые относятся к встраиванию: фреймы Telegram и кошельков.
const CSP_RE =
  /violates the following (?:report-only )?Content Security Policy directive|Refused to (?:execute|load|connect|frame)/i;
// Chrome помечает report-only тремя способами: префиксом "[Report Only]" у
// console-сообщений, фразой "The policy is report-only" у eval-нарушения (оно
// приходит как pageerror) и словом report-only внутри самого названия директивы у
// фреймов. Различать по одному из трёх — значит либо глушить сигнал, либо
// краснеть на политике, которая сейчас ничего не блокирует.
const isReportOnly = (text) =>
  /\[Report Only\]|policy is report-only|report-only Content Security Policy/i.test(text);
const enforced = [];
const reportOnly = [];
const blocked = [];
page.on("console", (msg) => {
  const text = msg.text();
  // Гейт валится только на enforce: политика в _headers сейчас именно в
  // Report-Only, и валиться на её же предупреждения — значит глушить единственный
  // сигнал о том, что enforce сломает вход через Telegram.
  if (CSP_RE.test(text)) (isReportOnly(text) ? reportOnly : enforced).push(text.slice(0, 300));
  if (process.env.HEADERS_DEBUG && msg.type() === "error") console.log(`console.error: ${text.slice(0, 240)}`);
});
page.on("pageerror", (e) => {
  const text = String(e.message ?? e);
  if (CSP_RE.test(text)) (isReportOnly(text) ? reportOnly : enforced).push(text.slice(0, 300));
  if (process.env.HEADERS_DEBUG) {
    console.log(`pageerror: ${text.slice(0, 240)}`);
    console.log(`  стек: ${String(e.stack ?? "").split("\n").slice(1, 5).join(" | ").slice(0, 300)}`);
  }
});
page.on("requestfailed", (req) => {
  if (/ERR_BLOCKED_BY_CSP|ERR_BlockedByResponse/i.test(req.failure()?.errorText ?? "")) {
    blocked.push(`${req.url().slice(0, 120)} :: ${req.failure().errorText}`);
  }
});

await page.goto(BASE, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);

const tabs = await page.getByRole("tab").allTextContents();
if (tabs.length === 0) throw new Error("вкладок не видно — сборка не та");

for (const tab of tabs) {
  const item = page.getByRole("tablist").getByRole("tab", { name: tab, exact: true });
  await item.click();
  const tabId = await item.evaluate((node) => node.id);
  const panel = page.locator(`[role="tabpanel"][aria-labelledby="${tabId}"]`);
  await panel.waitFor({ state: "visible", timeout: 20_000 });
  await panel.locator(".skeleton").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(400);
  console.log(`OK   панель «${tab}» — заблокировано политикой: ${enforced.length}, в Report-Only: ${new Set(reportOnly).size}`);
}

// Кошелёк: модалка тянет свои ассеты и логотипы кошельков — ровно то, что
// обычно и вылетает за рамки политики, собранной по крипто-данным площадки.
const wallet = page.getByRole("button", { name: /кошелёк/i }).first();
if (await wallet.count()) {
  await wallet.click();
  await page.waitForTimeout(2500);
  console.log(`OK   модалка кошелька открыта — заблокировано политикой: ${enforced.length}, в Report-Only: ${new Set(reportOnly).size}`);
}

await browser.close();
server.close();

const blockedUnique = [...new Set(blocked)];
const fatal = [...new Set([...enforced, ...blockedUnique])];
if (fatal.length) {
  console.log(`\nЗАБЛОКИРОВАНО ПОЛИТИКОЙ (${fatal.length}):`);
  for (const v of fatal) console.log("  - " + v);
  process.exit(1);
}
console.log(`\nЧисто: 0 заблокированных запросов на ${tabs.length} панелях и в модалке кошелька.`);
const wouldBreak = [...new Set(reportOnly)];
if (wouldBreak.length) {
  console.log(`Под enforce эта же политика сломала бы (${wouldBreak.length}):`);
  for (const v of wouldBreak) console.log("  - " + v.slice(0, 200));
}
console.log(`Правил в _headers: ${rules.length}; enforce-политика: ${rules.flatMap((r) => Object.keys(r.headers)).includes("content-security-policy") ? "есть" : "нет"}`);
