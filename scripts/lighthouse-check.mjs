// Гейт скоров Lighthouse на развёрнутом сайте.
//
// Зачем отдельный скрипт, а не npm-зависимость: `lighthouse` тянет десятки
// пакетов ради одного вызова, а версия в гейте обязана быть зафиксирована —
// скор есть функция методики, и между мажорными ветками Performance у того же
// сайта расходится на десятки пунктов. Версия пинится прямо здесь (`LH_VERSION`),
// берётся через `npx --yes`, в `package.json` ничего не появляется.
//
// Что меряется: четыре категории по живому адресу (по умолчанию — боевой Pages).
// Локально это бессмысленно: `vite preview` не применяет `_headers` и
// `_redirects`, а профиль сети у localhost не тот, что у посетителя.
//
// Порог один на все категории (`LH_GATE`, по умолчанию 95 — «почти сотка»).
// Сегодня гейт красный, и это единственная честная форма: порог, выставленный
// по текущему замеру, сторожил бы только регресс, а не обещание.
//
// Заодно про оболочку: `execFileSync("npx", …)` на Windows падает с ENOENT,
// потому что `npx` — пакетник `.cmd`, а без `shell: true` Node их не запускает
// (и с 20-й ветки падает на EINVAL). Отсюда `spawnSync` с `shell: true` и
// собственное экранирование: отчёт читается из stdout, поэтому путей с пробелами
// в командной строке нет вовсе.

import { spawnSync } from "node:child_process";

const LH_VERSION = "12.6.0";
const URL_SITE = process.env.LH_URL ?? "https://wake-7k6.pages.dev";
const GATE = Number(process.env.LH_GATE ?? 95);
const FORM = process.env.LH_FORM ?? "mobile";
// Худший из прогонов, а не среднее: гейт, который зеленеет от того, что машина
// успела остудить CPU, ничего не сторожит. Худший прогон ближе всего к
// разогретому телефону посетителя.
const RUNS = Number(process.env.LH_RUNS ?? 3);

if (!Number.isFinite(GATE) || GATE < 0 || GATE > 100) {
  throw new Error(`LH_GATE обязан быть числом от 0 до 100, а стоит «${process.env.LH_GATE}»`);
}
if (!["mobile", "desktop"].includes(FORM)) {
  throw new Error(`LH_FORM принимает mobile или desktop, а стоит «${FORM}»`);
}
if (!Number.isInteger(RUNS) || RUNS < 1) {
  throw new Error(`LH_RUNS — целое не меньше 1, а не «${process.env.LH_RUNS}»`);
}

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const THROTTLE = process.env.LH_THROTTLE ?? "simulate";

// cmd.exe ест кавычки по-своему, поэтому токен с пробелом или спецсимволом
// отдаётся в двойных кавычках с удвоением внутренних, как того требует
// правило разбора аргументов Windows.
const quote = (token) => (/^[A-Za-z0-9@:=_.,\/+-]+$/.test(token) ? token : `"${token.replace(/"/g, '""')}"`);

function runOnce(index) {
  const args = [
    "npx",
    "--yes",
    `lighthouse@${LH_VERSION}`,
    URL_SITE,
    "--output=json",
    "--quiet",
    `--only-categories=${CATEGORIES.join(",")}`,
    `--form-factor=${FORM}`,
    `--throttling-method=${THROTTLE}`,
    "--chrome-flags=--headless=new",
  ];
  const started = Date.now();
  const proc = spawnSync(args.map(quote).join(" "), { shell: true, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (proc.error) throw new Error(`прогон ${index}: не удалось запустить npx — ${proc.error.message}`);
  const stdout = proc.stdout ?? "";
  if (proc.status !== 0 && !stdout.includes('"categories"')) {
    throw new Error(`прогон ${index}: npx lighthouse завершился кодом ${proc.status}\n${(proc.stderr ?? "").slice(-1500)}`);
  }
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error(`прогон ${index}: в stdout нет JSON-отчёта (${stdout.slice(0, 200)})`);
  let data;
  try {
    data = JSON.parse(stdout.slice(start));
  } catch (e) {
    throw new Error(`прогон ${index}: отчёт разобрался не целиком — ${e.message}`);
  }
  const runtimeError = data.runtimeError;
  if (runtimeError && runtimeError.code !== "NO_ERROR") {
    throw new Error(
      `прогон ${index}: Lighthouse вернул runtimeError ${runtimeError.code} — ${runtimeError.fatalMessage ?? ""}`,
    );
  }
  console.log(`прогон ${index}/${RUNS}: ${((Date.now() - started) / 1000).toFixed(0)}s`);
  return data;
}

const scoresOf = (data) =>
  Object.fromEntries(CATEGORIES.map((c) => [c, Math.round((data.categories[c]?.score ?? 0) * 100)]));

const runs = [];
for (let i = 1; i <= RUNS; i += 1) {
  const data = runOnce(i);
  runs.push({ data, scores: scoresOf(data) });
}

console.log(`\nАдрес: ${URL_SITE}, форма: ${FORM}, троттлинг: ${THROTTLE}, порог: ${GATE}`);
for (const r of runs) {
  console.log(`  ${CATEGORIES.map((c) => `${c}=${r.scores[c]}`).join("  ")}`);
}

// Худший прогон целиком, не худшие числа из разных: метрики связаны, и картина,
// собранная из осколков, не соответствует ни одному реальному замеру.
const worst = runs.reduce((a, b) => (b.scores.performance < a.scores.performance ? b : a));
const metric = (id) => worst.data.audits[id]?.displayValue ?? "нет данных";
console.log(
  `Метрики худшего прогона: FCP ${metric("first-contentful-paint")}, LCP ${metric("largest-contentful-paint")}, ` +
    `SI ${metric("speed-index")}, TBT ${metric("total-blocking-time")}, CLS ${metric("cumulative-layout-shift")}`,
);

const failed = CATEGORIES.filter((c) => worst.scores[c] < GATE);
if (!failed.length) {
  console.log(`\nOK: все четыре категории >= ${GATE} на худшем из ${RUNS} прогонов.`);
} else {
  console.log(`\nНиже порога ${GATE}: ${failed.map((c) => `${c}=${worst.scores[c]}`).join(", ")}`);
  const offenders = Object.values(worst.data.audits)
    .filter((a) => a.score !== null && a.score < 0.9)
    .map((a) => ({ id: a.id, score: Math.round(a.score * 100), items: a.details?.items?.length ?? 0 }))
    .sort((x, y) => x.score - y.score);
  console.log("Audit'ы ниже 0.9 (id, скор, элементов в деталях):");
  for (const o of offenders.slice(0, 12)) console.log(`  ${String(o.score).padStart(3)}  items=${String(o.items).padStart(3)}  ${o.id}`);
  console.log("\nГейт не пройден.");
  process.exit(1);
}
