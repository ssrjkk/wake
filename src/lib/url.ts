// Единственный владелец разбора адреса: «что это за хост и что за источник».
//
// Правила, отвечающие на этот вопрос, живут в трёх местах (петля сборки и
// текст ошибки панели — src/lib/loopback.ts, ссылки наружу из мини-аппа —
// src/lib/telegram.ts, фильтр запросов в e2e), и все три раньше сравнивали
// строки. Сравнение строк у URL молчит в обе стороны: «http://localhost» —
// префикс и «http://localhost.attacker.tld», а «https://t.me» без слэша — ещё и
// «https://t.me.evil.com». Обратная сторона та же: адрес машины без схемы
// (`localhost:8787`) разбор «как есть» читает как схему «localhost:» с пустым
// хостом, и проверка петли на нём просто перестаёт срабатывать.
//
// Почему слепое `new URL("http://" + value)` не спасает (замер на Node 24):
// у уже схематого адреса оно даёт хост «http», у «/api» — хост «api», а
// «localhost:8787» без схемы действительно разбирается только после
// подстановки. Поэтому схема подставляется ТОЛЬКО строке, которая выглядит как
// авторити без схемы, — и проверяется это отдельным шаблоном, а не догадкой.

const SCHEMELED = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
// host / IPv6-в-скобках, при желании порт, и обрыв только на `/`, `?` или `#`.
const BARE_AUTHORITY =
  /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?::\d{1,5})?(?:[/?#]|$)/;

/**
 * Имя хоста, которое реально откроется по этой строке, или null.
 *
 * Скобки IPv6 снимаются (в адресе это оформление, а не часть имени), регистр
 * не важен: `HTTPS://LOCALHOST:8000` и `localhost` дают одно имя. userinfo при
 * этом РЕШАЕТ: у `https://t.me@evil.com` хост — evil.com, и маршрут обязан
 * выбираться по нему, а не по первому слову после «://».
 */
export function urlHost(url: string): string | null {
  const text = url.trim();
  if (!text) return null;
  let candidate = text;
  if (!SCHEMELED.test(text)) {
    if (!BARE_AUTHORITY.test(text)) return null;
    candidate = `http://${text}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host || null;
}

/**
 * Источник адреса (`scheme://host:port`) или null — для сверки «запрос туда,
 * куда мы его ждём».
 *
 * Здесь схема значимая: подставлять http к «localhost:8787» означало бы
 * сравнить с источником, которого в запросе нет. Поэтому безсхемные строки
 * источника не имеют, а `URL.origin` отдаёт их уже сам разбор (у адреса без
 * порта — без порта, и «http://host» и «http://host:80» совпадут).
 */
export function urlOrigin(url: string): string | null {
  const text = url.trim();
  if (!SCHEMELED.test(text)) return null;
  try {
    return new URL(text).origin;
  } catch {
    return null;
  }
}

// Печатный ASCII — единственное, что можно и положить в атрибут href, и открыть:
// пробелы и переводы строк WHATWG молча вырезает из адреса (у
// `https://good.com\nX` хост выходит «good.comx»), а non-ASCII — способ показать
// одному читателю один домен, а другому другой. Punycode (`xn--…`) остаётся
// ASCII, поэтому под запрет не попадает.
const UNSAFE = /[\s<>"'`\\]|[^\x20-\x7e]/;
// Хост после разбора: буквы, цифры, дефис и точки, без скобок и двоеточий.
// Сюда же попадают «@» (userinfo) и «%» — имя, которое парсер дочитывает до
// другого адреса, подписью не бывает.
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const IPV4_LABEL = /^[0-9]{1,3}$/;

/**
 * Каноническая IPv4-запись: четыре метки по 1–3 цифры, каждая ≤255 и без
 * ведущих нулей.
 *
 * Только её два разбора читают одинаково. Всё остальное, где последняя метка
 * начинается с цифры, WHATWG сворачивает в IPv4 (`https://0xA9.254.169.254`
 * открывается как 169.254.169.254) или отвергает (`https://1.2.3.4.5`), а
 * `urlsplit` отдаёт строку как есть — и подпись ссылки звала бы не туда.
 */
function isCanonicalIpv4(host: string): boolean {
  const labels = host.split(".");
  if (labels.length !== 4) return false;
  for (const label of labels) {
    if (!IPV4_LABEL.test(label)) return false;
    if (label.length > 1 && label[0] === "0") return false;
    if (Number(label) > 255) return false;
  }
  return true;
}

/**
 * Хост ссылки-источника — строки, по которой человек уходит смотреть
 * доказательство. Парное правило к `backend/source_url.py`: та же таблица
 * форм проверена с обеих сторон (`src/lib/url.test.ts`,
 * `backend/test_url_parity.py`).
 *
 * От `urlHost` отличается тем, что у ссылки требовать нечего, а вот чем она
 * является — важно: безсхемное «example.com» никуда не ведёт, а `https:` без
 * двойного слэша или с чужой схемой ведёт не туда, куда выглядит. Поэтому
 * схема обязана быть написана как `http(s)://`, userinfo (у
 * `https://t.me@evil.com` открывается evil.com, и пустой `https://@good.com`
 * тоже) и нулевой порт отвергаются, а `httpsOnly` разделяет запись и показ: в
 * базу куратор может положить и http-страницу, а подпись в боте и ссылка на
 * сайте — только https.
 *
 * Имя берётся из написания, а не из `parsed.hostname`: WHATWG нормализует хост
 * (сворачивает IPv4, раскодиует `%63` в `c`), и тогда ссылка подписана одним
 * именем, а открывается другим. Разбор при этом остаётся — он решает, существует
 * ли адрес вовсе (`https://good.com:443x` бросает исключение).
 */
export function sourceHost(url: string, httpsOnly: boolean = false): string | null {
  const text = url.trim();
  if (!text || !SCHEMELED.test(text) || UNSAFE.test(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "https" && !(scheme === "http" && !httpsOnly)) return null;
  // Авторити кончается на первом `/`, `?` или `#` — обратная косая черта,
  // которую WHATWG тоже считает границей, уже отвергнута проверкой UNSAFE.
  const authority = text.slice(text.indexOf("://") + 3).split(/[/?#]/)[0];
  // «@» меняет смысл адреса: до него — логин, а не домен. Проверка текстовая,
  // а не через `parsed.username`: у WHATWG поле `username` для пустого userinfo
  // (`https://@good.com`) — пустая строка, и проверка `parsed.username ||
  // parsed.password` её пропустила бы, но HOST-регулярка всё равно бы отвергла
  // символ «@» в имени. Явное «нет @ в authority» читается проще и симметрично
  // Python-стороне.
  if (authority.includes("@")) return null;
  if (parsed.port === "0") return null;
  const host = authority.split(":")[0].toLowerCase();
  // Пустая этикетка («good..com») — не имя: адрес с ней не резолвится, и
  // принять её означало бы пообещать «хост назван», не пообещав ничего.
  if (host.includes("..") || !HOST.test(host)) return null;
  // Числовая последняя метка — это заявка на IPv4, а не имя: её оставляем
  // только в канонической записи, где написание и есть адрес.
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (/^[0-9]/.test(last) && !isCanonicalIpv4(host)) return null;
  return host;
}

