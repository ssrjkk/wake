// Запуск: npx vitest run src/lib/url.test.ts
//
// Разбор адреса, от которого зависят отказы. Формы ниже — не выдуманные
// написания: они сняты с `new URL(...)` на Node 24 (см. комментарии к строкам),
// и именно на них сравнение строк молчит в обе стороны.
//
// Таблица SOURCE читается ещё и из Python — backend/test_url_parity.py берёт её
// отсюда же и прогоняет через backend/source_url.py. Порядок ключей в строке
// (url, any, https) — часть формата, а не стиль: по нему её разбирает экстрактор.

import { describe, expect, it } from "vitest";
import { sourceHost, urlHost, urlOrigin } from "./url";

const HOSTS: { url: string; host: string | null }[] = [
  { url: "https://wake.example.com/api/v1", host: "wake.example.com" },
  { url: "HTTPS://LOCALHOST:8000", host: "localhost" },
  { url: "http://127.0.0.2:8000", host: "127.0.0.2" },
  { url: "http://[::1]:8787", host: "::1" },
  // Свёртка IPv6 — часть разбора, а не косметика: у адреса в развёрнутой записи
  // hostname уже «[::1]», и сравнивать его со строкой, которую отдаёт свёрнутая
  // форма, значит иметь два ответа на один адрес.
  { url: "http://[0:0:0:0:0:0:0:1]:8000", host: "::1" },
  { url: "http://[0::1]:1", host: "::1" },
  // Форма без схемы: VITE_-переменные так и пишут руками. `new URL` читает её
  // как схему «localhost:» с пустым hostname, поэтому разбор обязан заметить
  // отсутствие схемы сам и подставить её только сюда.
  { url: "localhost:8787", host: "localhost" },
  { url: "127.0.0.1:8000", host: "127.0.0.1" },
  { url: "[::1]:8787", host: "::1" },
  { url: "localhost", host: "localhost" },
  { url: "wake.example.com/some/path", host: "wake.example.com" },
  // userinfo — часть адреса, а не хоста: у этой ссылки хост evil.com.
  { url: "https://t.me@evil.com/invite", host: "evil.com" },
  { url: "https://user:pw@wake.example.com", host: "wake.example.com" },
  // То, чем раньше сверялись: «localhost» внутри чужого адреса местным хостом
  // не становится, и суффикс «.localhost.attacker.tld» — не localhost.
  { url: "https://wake.example.com/localhost", host: "wake.example.com" },
  { url: "http://localhost.attacker.tld", host: "localhost.attacker.tld" },
  { url: "http://localhostish:9", host: "localhostish" },
  { url: "https://api.localhost.example.com", host: "api.localhost.example.com" },
  { url: "https://wake.example.com?callback=http://127.0.0.1:8000", host: "wake.example.com" },
  // Не адреса вовсе. «/api» — относительный путь: подставив к нему схему,
  // получили бы хост «api», поэтому безсхемная форма разбирается только целиком
  // как авторити.
  { url: "/api", host: null },
  { url: "не адрес", host: null },
  { url: "foo bar", host: null },
  { url: "", host: null },
  { url: "   ", host: null },
  { url: "https://", host: null },
  { url: "http://:8080", host: null },
  { url: "::1", host: null },
  { url: "mailto:hello@example.com", host: null },
];

describe("urlHost", () => {
  for (const { url, host } of HOSTS) {
    it(`reads "${url}" as ${host ?? "null"}`, () => {
      expect(urlHost(url)).toBe(host);
    });
  }

  it("the table distinguishes parsing from prefix matching", () => {
    // Зеркало прежних сверок: `includes` по строке адреса. Если оно перестанет
    // расходиться с разбором, таблица превратилась в пересказ одного случая.
    const naive = (url: string) => url.includes("localhost") || url.includes("127.0.0.1");
    const disagree = HOSTS.filter(({ url, host }) => {
      const loopback = host === "localhost" || host === "127.0.0.1" || host?.startsWith("127.") || host === "::1";
      return naive(url) !== loopback;
    }).map(({ url }) => url);
    expect(disagree).toEqual([
      // Подстрока не видит ни регистра, ни всего 127/8, ни IPv6-записей, ни
      // безсхемной формы — то есть молчит ровно там, где петля есть.
      "HTTPS://LOCALHOST:8000",
      "http://127.0.0.2:8000",
      "http://[::1]:8787",
      "http://[0:0:0:0:0:0:0:1]:8000",
      "http://[0::1]:1",
      "[::1]:8787",
      // …и наоборот: называет петлёй адрес, где «localhost» — лишь часть чужого
      // имени или значение query.
      "https://wake.example.com/localhost",
      "http://localhost.attacker.tld",
      "http://localhostish:9",
      "https://api.localhost.example.com",
      "https://wake.example.com?callback=http://127.0.0.1:8000",
    ]);
  });

  it("blind scheme prefixing is not a substitute for parsing", () => {
    // Замер: `new URL("http://" + value)` у схематого адреса отдаёт хост «http»,
    // у относительного пути — «api». Поэтому подстановка разрешена только
    // безсхемным авторити-формам.
    expect(() => new URL(`http://${"http://localhost:8000"}`).hostname).not.toThrow();
    expect(new URL(`http://${"http://localhost:8000"}`).hostname).toBe("http");
    expect(new URL(`http://${"/api"}`).hostname).toBe("api");
    expect(urlHost("http://localhost:8000")).toBe("localhost");
    expect(urlHost("/api")).toBeNull();
  });
});

describe("urlOrigin", () => {
  it("compares origins, not prefixes", () => {
    expect(urlOrigin("https://mainnet.zklighter.elliot.ai/api/v1")).toBe(
      "https://mainnet.zklighter.elliot.ai",
    );
    expect(urlOrigin("https://mainnet.zklighter.elliot.ai.attacker.tld/api")).toBe(
      "https://mainnet.zklighter.elliot.ai.attacker.tld",
    );
    expect(urlOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    // Порт по умолчанию в origin не попадает — «http://host» и «http://host:80»
    // остаются одним источником.
    expect(urlOrigin("http://localhost")).toBe("http://localhost");
    expect(urlOrigin("http://localhost:80")).toBe("http://localhost");
  });

  it("has no origin for a scheme-less or unparseable address", () => {
    for (const url of ["localhost:8787", "/api", "не адрес", "", "https://"]) {
      expect(urlOrigin(url), url).toBeNull();
    }
  });
});

// Общие ключи `any`/`https` — это один и тот же разбор, но спросили его дважды:
// при записи в базу источник может быть и http, а подпись в боте и ссылка на
// сайте ставятся только на https. Колонка `https` обязана быть не шире `any`.
const SOURCE: { url: string; any: string | null; https: string | null }[] = [
  { url: "https://wake.example.com/api/v1", any: "wake.example.com", https: "wake.example.com" },
  // Регистр схемы и обрамляющие пробелы адрес не портят — и ровно то, из-за
  // чего префиксная сверка теряла источник целиком.
  { url: "HTTPS://Wake.Example.COM", any: "wake.example.com", https: "wake.example.com" },
  { url: "  https://good.com/report  ", any: "good.com", https: "good.com" },
  { url: "http://wake.example.com/x", any: "wake.example.com", https: null },
  { url: "http://good.com:80/x", any: "good.com", https: null },
  { url: "https://good.com:8443/x", any: "good.com", https: "good.com" },
  // IDN в адресу не место (см. строку ниже), а punycode — обычный ASCII-хост.
  { url: "https://xn--bcher-kva.de/x", any: "xn--bcher-kva.de", https: "xn--bcher-kva.de" },
  { url: "https://127.0.0.1:8443/proof", any: "127.0.0.1", https: "127.0.0.1" },
  { url: "https://good.com?next=http://evil", any: "good.com", https: "good.com" },
  { url: "https://good.com#t=1", any: "good.com", https: "good.com" },
  // «@» после порта — часть пути, а не userinfo: домен здесь свой.
  { url: "https://good.com:443/@evil", any: "good.com", https: "good.com" },
  { url: "https://t.me@evil.com/invite", any: null, https: null },
  { url: "https://user:pw@wake.example.com", any: null, https: null },
  { url: "javascript://evil.com", any: null, https: null },
  { url: "javascript:alert(1)", any: null, https: null },
  { url: "data:text/html,x", any: null, https: null },
  // Один пропущенный слэш: у urlsplit хоста в такой форме нет, а WHATWG её
  // «догадывается» достроить — на одном написании два разных ответа.
  { url: "https:/good.com", any: null, https: null },
  { url: "https:good.com", any: null, https: null },
  { url: "//evil.com/path", any: null, https: null },
  { url: "good.com", any: null, https: null },
  { url: "localhost:8787", any: null, https: null },
  { url: "https://", any: null, https: null },
  { url: "https://:8080/x", any: null, https: null },
  // Порт не разобран (throw) и порт, по которому не подключаются.
  { url: "https://good.com:443x", any: null, https: null },
  { url: "https://good.com:0/", any: null, https: null },
  { url: "https://good.com:65536/", any: null, https: null },
  // Пробел, апостроф и угловая скобка внутри адреса — это уже не адрес, а
  // сломанный атрибут.
  { url: "https://good.com x", any: null, https: null },
  { url: "https://good.com'y", any: null, https: null },
  { url: "https://good.com<", any: null, https: null },
  { url: "https://bücher.de", any: null, https: null },
  { url: "https://[::1]:8443/proof", any: null, https: null },
  // Точка в конце, двойная точка, точка в начале, дефис в начале — имя, которое
  // никуда не резолвится; называть его хостом значит обещать ссылку, которой нет.
  { url: "https://good.com./", any: null, https: null },
  { url: "https://good..com", any: null, https: null },
  { url: "https://.good.com", any: null, https: null },
  { url: "https://-good.com", any: null, https: null },
  // `%2E` — точка, и WHATWG раскодирует её в хосте (`good..com`), а urlsplit
  // оставляет как есть. Имя читают из написания, поэтому обе стороны отвергают
  // адрес с экранированным символом в хосте — и по одной причине.
  { url: "https://good.%2Ecom/x", any: null, https: null },
  { url: "", any: null, https: null },
  { url: "/api", any: null, https: null },
  // Числовые написания, которые WHATWG ведёт по IPv4-ветке: ссылка была бы
  // подписана одним именем, а открылась другим (`0x7f000001` и `017700000001`
  // открывают 127.0.0.1, `0xA9.254.169.254` — 169.254.169.254, `1` — 0.0.0.1,
  // `1.2.3` — 1.2.0.3, `1.2.3.004` — 1.2.3.4). Замер — Node 24 и urlsplit.
  { url: "https://0x7f000001", any: null, https: null },
  { url: "https://2130706433", any: null, https: null },
  { url: "https://017700000001", any: null, https: null },
  { url: "https://0xA9.254.169.254", any: null, https: null },
  { url: "https://127.1", any: null, https: null },
  { url: "https://1.2.3.004", any: null, https: null },
  { url: "https://192.168.000.001", any: null, https: null },
  { url: "https://1", any: null, https: null },
  { url: "https://1.2.3", any: null, https: null },
  { url: "https://1.1.1.0x", any: null, https: null },
  { url: "https://1.1.1.00", any: null, https: null },
  // …а эти WHATWG отвергает вовсе, тогда как urlsplit отдаёт строку буквально.
  { url: "https://999.999.999.999", any: null, https: null },
  { url: "https://1.2.3.4.5", any: null, https: null },
  { url: "https://127.0.0.1.", any: null, https: null },
  { url: "https://example.1", any: null, https: null },
  // Канонический dotted-quad — единственная числовая форма, где написание и есть
  // адрес; правило обязано принимать её, иначе оно свелось бы к «никаких чисел».
  { url: "https://1.1.1.0", any: "1.1.1.0", https: "1.1.1.0" },
  { url: "https://192.168.1.10/x", any: "192.168.1.10", https: "192.168.1.10" },
  // Цифра начинает НЕ последнюю метку: IPv4-ветка не срабатывает ни в одном
  // разборе, и имя остаётся именем.
  { url: "https://1com.example", any: "1com.example", https: "1com.example" },
  // Percent-форма в хосте раскодируется WHATWG (`%63` → `c`,
  // `%31%32%37.0.0.1` → 127.0.0.1) и не раскодируется urlsplit — отвергается
  // обоими, пока имя читается из написания.
  { url: "https://good.%63om", any: null, https: null },
  { url: "https://%31%32%37.0.0.1", any: null, https: null },
  // Пустой userinfo: у `urlsplit` поле `username` в этой форме — пустая строка,
  // а не None, и проверка «есть ли userinfo» по нему не срабатывала.
  { url: "https://@good.com", any: null, https: null },
  { url: "https://:@good.com", any: null, https: null },
  { url: "https://good.com:443@evil.com", any: null, https: null },
];

describe("sourceHost", () => {
  for (const { url, any, https } of SOURCE) {
    it(`reads "${url}" as ${any ?? "null"} for record, ${https ?? "null"} for https`, () => {
      expect(sourceHost(url), url).toBe(any);
      expect(sourceHost(url, true), url).toBe(https);
    });
  }

  it("never lets the https column accept what the record column rejects", () => {
    const wider = SOURCE.filter((r) => r.https !== null && r.any !== r.https).map((r) => r.url);
    expect(wider).toEqual([]);
  });

  it("names the address that actually opens", () => {
    // Главное свойство правила: то, что стоит под ссылкой, и то, куда она
    // ведёт, — одно имя. `new URL` здесь не второй вариант правила, а тот же
    // движок, который открывает соединение в браузере: если принятая форма
    // начнёт резолвиться в другой хост (`0x7f000001` → `127.0.0.1`), таблица
    // это увидит сама, без сверки двух реализаций.
    const redirected = SOURCE.filter((r) => r.any !== null)
      .map((r) => {
        const host = new URL(r.url.trim()).hostname.toLowerCase();
        return host === r.any ? null : { url: r.url, shown: r.any, opens: host };
      })
      .filter((r): r is { url: string; shown: string; opens: string } => r !== null);
    expect(redirected).toEqual([]);
  });

  it("keeps the table about parsing, not about one case", () => {
    // Зеркало прежнего гейта бота: `text.strip().startswith("https://")` —
    // тримка в нём была, поэтому пробелы вокруг адреса здесь не расхождение, а
    // регистр схемы — расхождение. Таблица теряет смысл, если перестанет
    // расходиться с префиксом в обе стороны.
    const prefix = (url: string) => url.trim().startsWith("https://");
    const tooKind = SOURCE.filter((r) => prefix(r.url) && r.https === null).map((r) => r.url);
    const tooStrict = SOURCE.filter((r) => !prefix(r.url) && r.https !== null).map((r) => r.url);
    expect(tooStrict).toEqual(["HTTPS://Wake.Example.COM"]);
    // MEASURED по текущей таблице: столько её форм префикс считал ссылкой.
    expect(tooKind).toHaveLength(37);
    expect(tooKind).toContain("https://t.me@evil.com/invite");
    expect(tooKind).toContain("https://good.com:443x");
    expect(tooKind).toContain("https://");
    expect(tooKind).toContain("https://good.com x");
    // Класс, которого в прежней таблице не было: префикс принимает их как https,
    // а открывается по ним не то, что написано.
    expect(tooKind).toContain("https://0x7f000001");
    expect(tooKind).toContain("https://@good.com");
    expect(tooKind).toContain("https://good.%63om");
  });

  it("refuses a bidirectional mark inside the host", () => {
    // Не в общей таблице намеренно: символ управляющий, и в исходнике его быть
    // не должно. Python отвергает его тем же запретом non-ASCII.
    expect(sourceHost("https://good.com\u200e.evil.com")).toBeNull();
  });
});

