// Обратный гейт к `--ignore` в шаге аудита фронтенд-зависимостей.
//
// Зачем он нужен, если `scripts/audit-check.mjs` уже краснеет на уязвимость.
// Тот скрипт сверяет адвизории с *установленным* деревом: пока vite и vitest
// держат picomatch 4.0.7, запись «<=4.0.7» продолжает попадать в отчёт, и
// исключение выглядит живым даже в тот день, когда picomatch выпустит патч.
// Исключение, которое никто не отменяет, — это не риск, принятый осознанно, а
// риск, про который забыли. Здесь проверяется само условие upstream:
// `first_patched_version` в базе адвизорий GitHub.
//
// Красным, а не предупреждением — по той же причине, по какой шаг с
// `pip install --dry-run` стоит после pip-audit: предупреждение в зелёном прогоне
// не читает никто. Шаг называет оба возможных действия, потому что они
// разные: если transitive-зависимости уже можно поднять — поднимать и удалять
// исключение, если нельзя — это надо писать в SECURITY.md, а не молча держать
// `--ignore` ещё один релиз.
//
// Сеть не маскируется: без ответа API шаг падает, а не проходит. Локально это
// проверяется тем же запуском, что и в CI.
//
// Про коды выхода: `process.exit(1)` из-под незакрытого сокета fetch на Windows
// срывается в либью-ассерте и отдаёт 127, а `scripts/gate.sh` читает 127 как
// «команда не поднялась» — красный гейт выглядел бы пропущенным. Поэтому код
// ставится в `process.exitCode`, а событие цикла сам завершает.

const GHSA_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

async function check(id) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "wake-audit-check" };
  // Без токена GitHub отдаёт 60 запросов в час на IP, а раннеры выходят общими
  // адресами: в такой момент честнее покраснеть, чем сделать вид, что проверка
  // прошла. В CI токен есть у каждого workflow.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/advisories/${id}`, { headers });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    return `GitHub API отдал ${res.status} для ${id}${token ? "" : " (токена в окружении нет)"}: ${body}`;
  }
  const data = await res.json();
  if (data.ghsa_id !== id) return `ответ относится к ${data.ghsa_id}, а запрошен ${id} — разобран не тот документ`;

  const patched = (data.vulnerabilities ?? []).filter((v) => v.first_patched_version);
  if (data.withdrawn_at) {
    return `${id} отозвана ${data.withdrawn_at}: npm audit её больше не вернёт, исключение нужно убрать из ci.yml и из SECURITY.md`;
  }
  if (patched.length) {
    const list = patched.map((v) => `${v.package.name} ${v.first_patched_version}`).join(", ");
    return (
      `${id} имеет исправленный выпуск: ${list}. ` +
      "Если transitive-зависимости уже принимают эту версию — поднимите дерево и удалите --ignore; " +
      "если нет (vite/vitest ещё не перешли) — запишите предел в SECURITY.md, как сделано для urllib3, " +
      "и удалите --ignore вместе с ним."
    );
  }

  const affected = (data.vulnerabilities ?? []).filter((v) => v.vulnerable_version_range);
  console.log(
    `OK: ${id} не имеет исправленного выпуска (${affected.map((v) => `${v.package.name} ${v.vulnerable_version_range}`).join(", ") || "нет затронутых пакетов"}); ` +
      `CVSS ${data.cvss?.score ?? "?"}, опубликована ${data.published_at}, обновлена ${data.updated_at}.`,
  );
  console.log("Пока исправленного выпуска нет, --ignore в шаге аудита — единственная возможная форма проверки, и она остаётся.");
  return null;
}

// Список id, а не один: тогда «исключение без стража» невозможно — в ci.yml
// каждый GHSA обязан встретиться и в --ignore шага аудита, и в аргументах здесь,
// и сверяет их backend/test_local_gate_parity.py.
const ids = process.argv.slice(2);
let bad = false;
for (const id of ids) {
  if (!GHSA_RE.test(id)) {
    console.error(`\nаргумент обязан быть GHSA-идентификатором, а стоит «${id}»`);
    bad = true;
    continue;
  }
  let problem = null;
  try {
    problem = await check(id);
  } catch (e) {
    problem = `${id}: запрос к базе адвизорий не завершился — ${e.message}`;
  }
  if (problem) {
    console.error(`\n${problem}`);
    bad = true;
  }
}
if (!ids.length) {
  console.error("\nне передано ни одного GHSA-идентификатора: шаг, который ничего не проверяет, зелёный всегда");
  bad = true;
}
if (bad) {
  console.error("Гейт не пройден.");
  process.exitCode = 1;
}
