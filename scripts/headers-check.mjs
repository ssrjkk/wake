// Проверка заголовков Pages на собранном сайте.
//
// Зачем она нужна: `vite preview` заголовки из public/_headers не отдаёт — их
// применяет Cloudflare Pages при выдаче, то есть единственный способ увидеть
// свой CSP до деплоя — применить его самому. Скрипт поднимает dist с теми же
// правилами, что лежат в _headers, проходит в браузере каждую панель и модальное
// окно кошелька и требует нуля нарушений политики.
//
// Что проверка НЕ доказывает: заголовки, которые Pages добавляет сам (свои
// дефолты, https-редирект), и то, как они сливаются с правилами из `_headers`
// на живом ответе. Слияние смоделировано по документации (порядок файла +
// склейка через запятую), но видно это только curl по живому адресу после
// деплоя — и об этом сказано в отчёте.

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
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
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

/**
 * Разбор public/_redirects: одна декларация на строку — «source dest [code]»,
 * пустые строки и строки с # документация не считает правилами. Код по
 * умолчанию 302, и модель держит это число, а не «как-нибудь».
 */
function parseRedirects(file) {
  const rules = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) throw new Error(`_redirects: нужно «source dest [code]», а стоит «${line}»`);
    rules.push({ source: parts[0], dest: parts[1], code: Number(parts[2] ?? 302) });
  }
  return rules;
}

/**
 * Подходящие правила — так, как их сливает Pages: в порядке файла, заголовок,
 * заданный двумя правилами, склеивается через запятую (документация Cloudflare,
 * раздел «Attach a header»). Прежняя версия сортировала по длине паттерна и
 * оставляла первое значение — расхождение, которое ничем не проявляется, пока
 * правила не конфликтуют, и потому проверяет файл по его же правилам, а не по
 * упрощению.
 */
function matchingRules(rules, pathname) {
  return rules.filter(
    (r) => r.pattern === pathname || (r.pattern.endsWith("/*") && pathname.startsWith(r.pattern.slice(0, -1))),
  );
}

function headersFor(rules, pathname) {
  const out = {};
  for (const rule of matchingRules(rules, pathname)) {
    for (const [k, v] of Object.entries(rule.headers)) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

/**
 * Ловушка склейки: у list-valued заголовков два значения через запятую — это
 * осмысленно, а у Cache-Control директивы max-age расходятся, и по RFC 9111 кэш
 * обязан взять первое или считать ответ протухшим. Pages при этом не ошибки не
 * выдаёт, и документация прямо называет это «easy to miss».
 */
function collisions(rules) {
  const bad = [];
  for (const rule of rules) {
    for (const other of rules) {
      if (other === rule) continue;
      const shared = Object.keys(rule.headers).filter((k) => k in other.headers);
      if (!shared.length) continue;
      // Пересечение паттернов: /a/* и /a/b, два /* и т.п.
      const [narrow, wide] = [rule.pattern, other.pattern].sort((a, b) => a.length - b.length);
      const overlaps =
        rule.pattern === other.pattern ||
        (wide.endsWith("/*") && narrow.startsWith(wide.slice(0, -1))) ||
        (narrow.endsWith("/*") && wide.startsWith(narrow.slice(0, -1)));
      if (overlaps) bad.push(`${rule.pattern} ∩ ${other.pattern}: ${shared.join(", ")}`);
    }
  }
  return [...new Set(bad)];
}

const HEADERS_FILE = join(ROOT, "public", "_headers");
const rules = existsSync(HEADERS_FILE) ? parseHeaders(HEADERS_FILE) : [];
if (rules.length === 0) throw new Error("public/_headers пустой или не найден — проверять нечего");
if (rules.length > 100) throw new Error(`правил ${rules.length}, Pages принимает не больше 100`);

const tooLong = readFileSync(HEADERS_FILE, "utf8").split(/\r?\n/).filter((l) => l.length > 2000);
if (tooLong.length) {
  throw new Error(`строк длиннее лимита Pages (2000 символов): ${tooLong.length} — такая строка не применяется`);
}

const clash = collisions(rules);
if (clash.length) {
  throw new Error(
    `одно имя заголовка задают два подходящих правила — Pages склеит значения через запятую: ${clash.join("; ")}`,
  );
}

// `_redirects` харнесс раньше не читал вовсе, хотя Pages идёт по его правилам
// раньше, чем ищет ассет: «redirects are always followed, regardless of whether
// or not an asset matches the incoming request». Значит и лимиты, и порядок, и
// тень над собранным файлом видны здесь, а не после деплоя.
const REDIRECTS_FILE = join(ROOT, "public", "_redirects");
const redirects = existsSync(REDIRECTS_FILE) ? parseRedirects(REDIRECTS_FILE) : [];
const isDynamic = (r) => r.source.includes("*") || /:[A-Za-z]\w*/.test(r.source);
const dynamic = redirects.filter(isDynamic);
const statics = redirects.filter((r) => !isDynamic(r));
if (statics.length > 2000 || dynamic.length > 100) {
  throw new Error(
    `_redirects: статических ${statics.length} при лимите 2000, динамических ${dynamic.length} при лимите 100`,
  );
}
const longDecl = readFileSync(REDIRECTS_FILE, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trimStart().startsWith("#") && l.length > 1000);
if (longDecl.length) {
  throw new Error(`_redirects: деклараций длиннее лимита Pages (1000 символов) — ${longDecl.length}`);
}
// Плейсхолдеры и `:splat` модель не разбирает: смоделировать их молча — значит
// проверить не то, что отдаст Pages.
const fancy = redirects.filter((r) => /:[A-Za-z]\w*/.test(r.source) || r.dest.includes(":splat"));
if (fancy.length) {
  throw new Error(
    `_redirects: харнесс умеет только wildcard, а здесь ${fancy.map((r) => r.source).join(", ")} — их читают руками`,
  );
}
// Тень: редирект (3xx), статический source которого совпадает с настоящим
// файлом сборки, перекрывает этот файл — Pages говорит об этом прямо:
// «redirects are always followed, regardless of whether or not an asset matches
// the incoming request». Правило-rewrite (200) затемняет файл иначе и ровно за
// тем и заведён: это fallback одиночного приложения, а не подмена ассета.
const shadowed = statics.filter((r) => r.code !== 200).filter((r) => existsSync(join(DIST, r.source)));
if (shadowed.length) {
  throw new Error(
    `_redirects перекрывает файлы сборки: ${shadowed.map((r) => `${r.source} -> ${r.dest}`).join(", ")} — Pages применяет правило до того, как смотрит, есть ли ассет`,
  );
}
// Порядок правил — не стиль: Pages берёт верхнее из подходящих, и документация
// просит статические выше динамических.
const firstDynamic = redirects.findIndex(isDynamic);
const staticAfterDynamic = firstDynamic === -1 ? [] : redirects.slice(firstDynamic).filter((r) => !isDynamic(r));
if (staticAfterDynamic.length) {
  throw new Error(
    `_redirects: статические ${staticAfterDynamic.map((r) => r.source).join(", ")} стоят после wildcard — сработает верхнее правило`,
  );
}

// 3xx без собранной цели — редирект на fallback: по такому адресу Pages отдаёт
// index.html с кодом 200, ровно то, от чего /favicon.ico и спасают.
const dangling = statics
  .filter((r) => r.code !== 200)
  .filter((r) => !existsSync(join(DIST, r.dest)))
  .map((r) => `${r.source} -> ${r.dest}`);
if (dangling.length) {
  throw new Error(
    `_redirects ведёт на несобранные цели: ${dangling.join(", ")} — Pages отдаст по такому адресу index.html со статусом 200`,
  );
}

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

// Правило кэша, написанное против пути, которого в сборке нет, молчит: Pages
// применяет его к ответу, которого не бывает, и расхождение не видно ни в одном
// замере. Список сверяется с dist буквально.
const orphan = rules
  .filter((r) => "cache-control" in r.headers && !r.pattern.includes("*"))
  .filter((r) => !existsSync(join(DIST, r.pattern)))
  .map((r) => r.pattern);
if (orphan.length) {
  throw new Error(
    `правила кэша смотрят на пути, которых нет в сборке: ${orphan.join(", ")} — файл переименовали, строку забыли`,
  );
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

// Файлы роботов не проходят ни через один браузерный тест: их читают пауки, а
// адрес в них — литерал, потому что Vite подставляет VITE_SITE_URL только в
// index.html. Расхождение выглядит безобидно ровно до того момента, когда
// чужой домен уедет в поисковую индекс первым.
const canonical = builtHtml.match(/rel="canonical" href="([^"]+)"/)?.[1];
if (!canonical) throw new Error("в dist/index.html нет canonical — сверять адрес роботов не с чем");
const canonicalHost = new URL(canonical).host;
const robotFiles = [
  ["robots.txt", /^Sitemap:[ \t]*(\S+)[ \t]*$/m],
  ["sitemap.xml", /<loc>([^<]+)<\/loc>/],
];
for (const [file, pattern] of robotFiles) {
  const path = join(DIST, file);
  if (!existsSync(path)) {
    // Именно это и был живый замер до появления файлов: неизвестный путь
    // получал fallback со статусом 200 и content-type страницы.
    throw new Error(`в dist нет ${file} — Pages отдаст по этому пути index.html с кодом 200`);
  }
  const hit = readFileSync(path, "utf8").match(pattern);
  if (!hit) throw new Error(`в ${file} нет ни одной строки вида ${pattern}`);
  const host = new URL(hit[1]).host;
  if (host !== canonicalHost) {
    throw new Error(
      `${file} называет ${host}, а canonical собранной страницы — ${canonicalHost}: при смене VITE_SITE_URL файлы из public/ правят руками`,
    );
  }
}
console.log(`OK   robots.txt и sitemap.xml называют хост canonical: ${canonicalHost}`);

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
  const index = join(DIST, "index.html");
  const rule = redirects.find(
    (r) => r.source === pathname || (r.source.endsWith("/*") && pathname.startsWith(r.source.slice(0, -1))),
  );
  if (rule && rule.code !== 200) {
    // 3xx берётся до поиска файла: Pages идёт по правилам `_redirects` всегда,
    // «regardless of whether or not an asset matches the incoming request».
    res.writeHead(rule.code, { location: rule.dest, ...headersFor(rules, pathname) });
    res.end();
    return;
  }
  const wanted = pathname === "/" ? index : join(DIST, pathname);
  let file = wanted;
  try {
    const info = await stat(wanted);
    if (info.isDirectory()) file = join(wanted, "index.html");
  } catch {
    // Rewrite (200) работает там, где файла нет: точка в точку как
    // `/* -> /index.html 200` в public/_redirects.
    file = rule ? join(DIST, rule.dest) : index;
  }
  if (!file.startsWith(DIST + sep)) file = index;
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

// Модель `_redirects` обязана применяться, а не только разбираться: правило
// проверяется ответом собственного сервера. Без этого опечатка в условии
// (`code !== 200` наоборот) оставляла бы все прогоны зелёными над правилом,
// которое не отдаёт ничего.
for (const r of statics.filter((x) => x.code !== 200)) {
  const res = await fetch(`${BASE}${r.source}`, { redirect: "manual" });
  if (res.status !== r.code || res.headers.get("location") !== r.dest) {
    throw new Error(
      `_redirects не применён: ${r.source} дал ${res.status} → ${res.headers.get("location")}, а ждали ${r.code} → ${r.dest}`,
    );
  }
  console.log(`OK   ${r.source} -> ${r.dest} (${r.code})`);
}

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

// Вход: модалка «Войти в Wake» монтирует `TelegramLogin`, и это единственный шаг,
// на котором виджет вообще появляется — скрипт грузится с telegram.org, iframe
// строится на oauth.telegram.org, а адрес `data-onauth` исполняется как строка.
// Без этого клика проверка политики не видит ровно то нарушение, из-за которого
// enforce отложен, и зелёный отчёт означал бы «не проверяли».
const login = page.getByRole("button", { name: /войти/i }).first();
if (await login.count()) {
  await login.click();
  await page.waitForTimeout(3000);
  console.log(`OK   модалка входа открыта — заблокировано политикой: ${enforced.length}, в Report-Only: ${new Set(reportOnly).size}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
} else {
  console.log("OK   кнопки входа на экране нет — сборка без TELEGRAM_BOT_NAME, виджет не монтируется");
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
console.log(`\nЧисто: 0 заблокированных запросов на ${tabs.length} панелях, в модалке входа и в модалке кошелька.`);
const wouldBreak = [...new Set(reportOnly)];
if (wouldBreak.length) {
  console.log(`Под enforce эта же политика сломала бы (${wouldBreak.length}):`);
  for (const v of wouldBreak) console.log("  - " + v.slice(0, 200));
}
console.log(`Правил в _headers: ${rules.length}; в _redirects: ${redirects.length}; enforce-политика: ${rules.flatMap((r) => Object.keys(r.headers)).includes("content-security-policy") ? "есть" : "нет"}`);
