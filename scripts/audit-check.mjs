// Гейт аудита npm-зависимостей, раздельно для того, что уезжает в `dist`, и для
// того, что живёт только на машине сборки.
//
// Зачем отдельный скрипт, а не голая `npm audit`: у `npm audit` нет способа
// выразить «это исключение разобрано», есть только молчаливый `--audit-level`
// (краснеет реже, но не различает прод и dev) и `--force`-фикс, который по
// живому замеру 2026-11-17 предлагает поставить vite 6.2.7 вместо 8.3.8 —
// downgrade через мажор, то есть регресс, а не исправление. Здесь же политика
// видна по exit-коду: в продакшен-графе исключений не бывает вовсе, в dev-графе
// каждое названо GHSA-идентификатором.
//
// Оба направления проверяются, и это не косметика. Неизвестная адвизория красит
// сборку — так гейт не превращается в шум, который обещают посмотреть потом.
// Устаревшее исключение красит сборку тоже: список `--ignore`, из которого
// запись уже не нужна, сторожит ровно ноль и переживает собственный резон.
//
// Про оболочку: `execFileSync("npm", …)` на Windows падает с ENOENT, потому что
// `npm` — пакетник `.cmd`, а без `shell: true` Node их не запускает. Отсюда
// `spawnSync` с `shell: true`, собственное экранирование и чтение отчёта из
// stdout: файловых путей в командной строке нет, а значит и кавычек, которые
// cmd.exe разобрал бы по-своему, нет.

import { spawnSync } from "node:child_process";

// Стек в логе гейта nobody читает: важна строка, называющая причину. Всё, что
// не дошло до разбора отчёта, выходит одной строкой и кодом 1.
process.on("uncaughtException", (e) => {
  console.error(`\n${e.message}\nГейт не пройден.`);
  process.exit(1);
});

// Идентификатор из `url` поля блока `via` в `npm audit --json`. Формат фиксированный:
// четыре группы по четыре символа после префикса.
const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/;

const argv = process.argv.slice(2);
const ignore = new Set();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== "--ignore") fail(`неизвестный аргумент «${argv[i]}»; скрипт принимает только --ignore <GHSA-id>`);
  const id = argv[i + 1];
  if (!id || !GHSA_RE.test(id)) fail(`после --ignore обязан стоять GHSA-идентификатор, а стоит «${id}»`);
  ignore.add(id);
  i += 1;
}

function fail(message) {
  console.error(`\n${message}\nГейт не пройден.`);
  process.exit(1);
}

const quote = (token) => (/^[A-Za-z0-9@:=_.,\/+-]+$/.test(token) ? token : `"${token.replace(/"/g, '""')}"`);

function npmAudit(extra) {
  const cmd = ["npm", "audit", "--json", ...extra].map(quote).join(" ");
  const proc = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (proc.error) throw new Error(`не удалось запустить npm audit — ${proc.error.message}`);
  const stdout = proc.stdout ?? "";
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`npm audit ${extra.join(" ")} не выдал JSON (код ${proc.status}):\n${stdout.slice(0, 300)}${(proc.stderr ?? "").slice(-500)}`);
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(start));
  } catch (e) {
    throw new Error(`npm audit ${extra.join(" ")} выдал неразбираемый JSON — ${e.message}`);
  }
  if (report.auditReportVersion !== 2) {
    throw new Error(`ожидал npm audit отчёт версии 2, получил «${report.auditReportVersion}» — сверьте парсер с тем, что печатает npm`);
  }
  return report;
}

// Ключ отчёта — пакет, а `via` содержит и адвизории, и ссылки на другие пакеты
// (" Depends on vulnerable versions of picomatch"). Идентификатор несёт только
// адвизория, поэтому источник дыры — это записи с url, а всё остальное — следствия.
function advisoriesOf(report) {
  const found = new Map();
  for (const [pkgName, entry] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = (via.url ?? "").match(GHSA_RE)?.[0] ?? `источник #${via.source}`;
      const row = found.get(id) ?? { id, packages: new Set(), severities: new Set(), ranges: new Set(), titles: new Set(), urls: new Set() };
      row.packages.add(pkgName);
      if (via.severity) row.severities.add(via.severity);
      if (via.range) row.ranges.add(via.range);
      if (via.title) row.titles.add(via.title);
      if (via.url) row.urls.add(via.url);
      found.set(id, row);
    }
  }
  return found;
}

const prod = advisoriesOf(npmAudit(["--omit=dev"]));
const full = advisoriesOf(npmAudit([]));

console.log(`Прод-граф (без dev) и полный граф проверены каждым через npm audit --json.`);

for (const row of prod.values()) {
  console.log(`  ПРОД ${row.id} ${[...row.packages].join(" ")} ${[...row.ranges].join(" или ")} — ${[...row.urls].join(", ")}`);
}
if (prod.size) {
  console.log(`\nНиже порога: ${prod.size} адвизорий в графе, который попадает в dist.`);
  console.log("Исключений здесь не бывает: --ignore принимается только для dev-графа.");
  console.log("Гейт не пройден.");
  process.exit(1);
}

const devOnly = new Map([...full].filter(([id]) => !prod.has(id)));
const unreviewed = [...devOnly.keys()].filter((id) => !ignore.has(id));
const obsolete = [...ignore].filter((id) => !devOnly.has(id));

console.log(`В продакшен-графе адвизорий: ${prod.size}. Только в dev-графе: ${devOnly.size}. Разобрано исключениями: ${ignore.size}.`);
for (const row of devOnly.values()) {
  const mark = ignore.has(row.id) ? "DEV-исключение" : "DEV-не разобрано";
  console.log(`  ${mark}: ${row.id} ${[...row.severities].join("/")} ${[...row.packages].join(", ")} ${[...row.ranges].join(" или ")}`);
  for (const title of row.titles) console.log(`      ${title}`);
  for (const url of row.urls) console.log(`      ${url}`);
}

let bad = false;
if (unreviewed.length) {
  console.log(`\nНе разобраны: ${unreviewed.join(", ")} — добавьте --ignore <GHSA-id> в шаг аудита и опишите риск в SECURITY.md.`);
  bad = true;
}
if (obsolete.length) {
  console.log(`\nИсключение больше не действует: ${obsolete.join(", ")} — npm audit его не возвращает. Уберите --ignore из ci.yml и перепишите раздел «Проверка зависимостей» в SECURITY.md.`);
  bad = true;
}

if (!bad) {
  console.log(`\nOK: прод-граф чист, ${devOnly.size} dev-адвизорий названы разобранными исключениями.`);
  if (devOnly.size) console.log("Появление пропатченного релиза проверяет отдельный шаг «upstream fix must still be missing» — он краснеет сам.");
} else {
  console.log("\nГейт не пройден.");
  process.exit(1);
}
