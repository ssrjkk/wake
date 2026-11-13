// Приложение монтируется по-настоящему. Прежний тест этого файла утверждал
// `typeof App === "function"` — зелёное доказательство того, что экспорт
// существует: ни провайдеры из main.tsx, ни опрос бэкенда, ни переключение
// разделов в нём не участвовали, и App, который падает на первом же рендере,
// прошёл бы его так же.
//
// Здесь <App/> стоит в тех же провайдерах, что и в точке входа, с подменённым
// fetch: ответ отдаётся только тем адресам, которые приложение читает сама,
// остальное — 404, то есть «данных нет», а не вечная загрузка. Геометрия ленты
// (scrollLeft, подсказки краёв, пиксели) здесь не проверяется: ResizeObserver в
// jsdom подставлен пустым наблюдателем, и любой замер размера в этом файле
// врал бы. Замеры делает e2e на живом chromium.
import { StrictMode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { config } from "./wagmi";
import { BACKEND_URL, LIGHTER_NETWORK } from "./lib/config";
import { setNetwork as setLighterNetwork } from "./lib/lighter";
import { setNetwork as setArcusNetwork } from "./lib/arcus";
import { TABS } from "./lib/tabs";

// Один рынок вместо пустого списка: «нет данных» и «данные есть, но панелей не
// видно» для теста неразличимы, а с одной строкой Terminal находит, что рендерить.
const MARKET = {
  symbol: "BTC",
  market_id: 0,
  market_type: "perp",
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  min_base_amount: "0.00001",
  min_quote_amount: "10",
  supported_price_decimals: 2,
  supported_size_decimals: 5,
  open_interest: "370.84",
};

/* Один и тот же market_id в двух сетях — не одна и та же монета. Замер живого
   /orderBooks?filter=all (2026-11-13): mainnet — 246 книг, testnet — 9, и у них
   пять общих номеров, 4095…4099, под разными тикерами. Здесь взят 4096: в
   mainnet это OURA, в testnet — BTC. */
const COLLISION_ID = 4096;
/* Снят с торгов: у HANMI (#148, mainnet) книга пустая — orderBookOrders отдаёт
   `total_asks: 0, total_bids: 0`, — а свечи продолжают печатать последнюю цену.
   Поэтому статус площадки читается, а не выводится из наличия цены. */
const DELISTED = { ...MARKET, market_id: 148, symbol: "HANMI", status: "inactive" };
const MARKETS_BY_NETWORK: Record<"mainnet" | "testnet", unknown[]> = {
  mainnet: [MARKET, { ...MARKET, market_id: COLLISION_ID, symbol: "OURA" }, DELISTED],
  testnet: [{ ...MARKET, market_id: COLLISION_ID, symbol: "BTC" }],
};
/* Цена последней часовой свечи той же парой «сеть:market_id». Сеть берётся из
   хоста запроса, потому что именно хостом код различает площадки: BASE_URL() в
   lib/lighter.ts собирает адрес из текущей сети, и подмена по нему — это ответ
   биржи, а не догадка теста. 293001 — измеренное значение последней свечи HANMI. */
const CLOSE_BY_NETWORK: Record<string, number> = {
  "mainnet:4096": 12.34,
  "testnet:4096": 69000.12,
  "mainnet:148": 293001,
};

function networkOf(url: string): "mainnet" | "testnet" {
  return url.includes("testnet") ? "testnet" : "mainnet";
}

type Mode = "ready" | "backend-down";

let mode: Mode = "ready";
let calls: string[] = [];

// Один ответ на один адрес. Всё, чего приложение не просит, сюда не попадает:
// ветка 404 в конце — это «данных нет», а не «тест ждёт вечно».
function respond(url: string): Response {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.endsWith("/health")) {
    if (mode === "backend-down") throw new TypeError("fetch failed");
    return json({ status: "ok", network: "mainnet", dry_run: true });
  }
  if (url.endsWith("/ready")) {
    if (mode === "backend-down") throw new TypeError("fetch failed");
    return json({ status: "ready", checks: { postgres: "ok", redis: "ok" } });
  }
  if (url.includes("/api/v1/orderBooks")) return json({ order_books: MARKETS_BY_NETWORK[networkOf(url)] });
  if (url.includes("/api/v1/candles")) {
    const close = CLOSE_BY_NETWORK[`${networkOf(url)}:${new URL(url).searchParams.get("market_id")}`];
    // Рынка без записи в таблице в ответе нет вовсе: пустой ряд — это «свечей
    // нет», а не «свечи по нулям», и цена в списке осталась бы прочерком.
    if (close === undefined) return json({ c: [] });
    return json({
      c: [
        { t: 1, o: close, h: close, l: close, c: close, v: 1, V: close },
        { t: 2, o: close, h: close, l: close, c: close, v: 1, V: close },
      ],
    });
  }
  if (url.includes("/api/v1/recentTrades")) return json({ trades: [] });
  if (url.includes("/api/v1/funding-rates")) return json({ funding_rates: [] });
  if (url.includes("/api/v1/markets/overview")) return json({ markets: [] });
  if (url.includes("/v1/markets")) return json({ markets: [] });
  if (url.includes("/v1/mids")) return json({ mids: {}, globalSequenceId: 1 });
  if (url.includes("/predict/markets")) return json([]);
  if (url.includes("/predict/positions")) return json([]);
  if (url.includes("/subscription")) {
    return json({ tier: "free", has_ai_agent: false, has_copy_trading: true, has_predict_markets: true });
  }
  if (url.includes("/leaders/mine")) return json({ leader: null });
  if (url.includes("/follows")) return json([]);
  // Всё остальное — честный «не найдено»: глобальная заглушка, которая
  // возвращает 200 на любой путь, спрянула бы обращение к адресу, которого в
  // контракте нет.
  return json({ error: { code: "NOT_FOUND", message: "вне контракта теста" } }, 404);
}

function mount() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <StrictMode>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </WagmiProvider>
    </StrictMode>,
  );
}

/** Вкладка по подписи: имя у таба — его подпись, и она же видна человеку.
 *  Сравнение имени полное: `getByRole` с строкой берёт точное совпадение, а
 *  «Predict» внутри «Predict Markets» иначе нашёлся бы не тем табом. */
function tab(name: string): HTMLElement {
  return screen.getByRole("tab", { name });
}

/** Выбранный таб — ровно один, и панель обязана быть подписана именно им.
 *  Это тот инвариант, который ломается молча: две «выбранные» вкладки или
 *  панель, оставшаяся с прошлой, в скриншоте выглядят нормально. */
async function expectSelected(name: string) {
  await waitFor(() => expect(tab(name)).toHaveAttribute("aria-selected", "true"));
  const tabs = screen.getAllByRole("tab");
  expect(tabs.filter((node) => node.getAttribute("aria-selected") === "true")).toHaveLength(1);
  expect(tabs.filter((node) => node.getAttribute("tabindex") === "0")).toHaveLength(1);
  const panel = await screen.findByRole("tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", tab(name).id);
}

// Панели грузятся лениво, и первый переход на каждую из них — это ещё и
// динамический import модуля. В холодном jsdom он раскладывается на ходу и не
// успевает внутри секундного ожидания `findByRole`, поэтому проверка «панель
// на месте» падала бы на тайминге сборки, а не на смысле. Import по тому же
// спецификатору кладёт модуль в реестр, и `lazy()` в App резолвится на первом
// же рендере: список совпадает с `lazy(() => import(...))` в App.tsx строка в
// строку, расхождение здесь означало бы, что грелся не тот модуль.
beforeAll(async () => {
  await Promise.all([
    import("./components/Dashboard"),
    import("./components/Terminal"),
    import("./components/Discover"),
    import("./components/Portfolio"),
    import("./components/Earn"),
    import("./components/Predict"),
    import("./components/Agent"),
    import("./components/Risk"),
    import("./components/Funding"),
  ]);
});

beforeEach(() => {
  mode = "ready";
  calls = [];
  /* Сети библиотек — глобальное состояние модуля, и переключатель в шапке его
     меняет по-настоящему. Без возврата к написанному в конфиге умолчанию каждый
     тест после сетевого молча ходил бы в testnet: ассерты продолжали бы зелёным
     гореть над чужими ответами. Адрес окна — то же самое про ссылку ?asset=. */
  setLighterNetwork(LIGHTER_NETWORK);
  setArcusNetwork(LIGHTER_NETWORK);
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      // fetch при недоступном бэкенде не бросает синхронно — он возвращает уже
      // отвергнутый промис. Без этой развилки TypeError из respond ушёл бы в
      // стек вызывающего кода, а не то, что проверяет тест «бэкенд не готов».
      try {
        return Promise.resolve(respond(url));
      } catch (reason) {
        // Причина отказа обязана быть Error: приложение различает «бэкенд
        // лёг» и «ответ плохой» по `instanceof TypeError`, как это делает
        // настоящий fetch.
        return Promise.reject(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      }
    }),
  );
  // Пустой наблюдатель: в jsdom нет ни LayoutObjects, ни осмысленных размеров,
  // а конструктор без него роняет монтирование ленты вкладок до первого ассерта.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  /* Модальные <dialog> в jsdom не реализованы: showModal отсутствует, и любое
     окно (а рынок выбирается именно в окне) падало бы на монтировании — до
     первого ассерта. Заменяются только два метода открытия/закрытия, и делают
     они ровно то, что требует спецификация: двигают `open`, от которого зависит
     видимость. Всё остальное внутри окна — настоящий код компонента; поведение
     самого диалога (Esc, возврат фокуса) отдаётся браузером и здесь не
     проверялось бы. */
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("App", () => {
  it("монтируется в провайдерах точки входа и спрашивает бэкенд", async () => {
    mount();
    await expectSelected(TABS[0].label);
    // Опрос — не украшение: без него панель молчала бы «загружаю» вечно, а
    // баннер «бэкенд не готов» вообще никогда бы не появился.
    await waitFor(() => expect(calls.filter((u) => u === `${BACKEND_URL}/health`)).not.toHaveLength(0));
    expect(calls.filter((u) => u === `${BACKEND_URL}/ready`)).not.toHaveLength(0);
  });

  it("показывает все разделы и держит landmark навигации рядом с tablist", async () => {
    const { container } = mount();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((node) => node.textContent?.trim())).toEqual(TABS.map((t) => t.label));
    // role="tablist" на <nav> перебивает неявную роль navigation: разделы
    // остаются tablist'ом, но у диктора исчезает способ к ним прыгнуть.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(container.querySelector(".tabbar")).not.toBeNull();
  });

  it("клик по вкладке переключает раздел, а не только подсветку", async () => {
    mount();
    await expectSelected(TABS[0].label);

    fireEvent.click(tab("Predict"));
    await expectSelected("Predict");
    expect(tab(TABS[0].label)).toHaveAttribute("aria-selected", "false");

    fireEvent.click(tab("Терминал"));
    await expectSelected("Терминал");
  });

  it("стрелки внутри ленты двигают фокус и выбор вместе", async () => {
    mount();
    await expectSelected(TABS[0].label);

    tab(TABS[0].label).focus();
    fireEvent.keyDown(tab(TABS[0].label), { key: "ArrowRight" });
    await expectSelected(TABS[1].label);
    expect(document.activeElement).toBe(tab(TABS[1].label));

    fireEvent.keyDown(tab(TABS[1].label), { key: "Home" });
    await expectSelected(TABS[0].label);

    fireEvent.keyDown(tab(TABS[0].label), { key: "ArrowLeft" });
    await expectSelected(TABS[TABS.length - 1].label);

    fireEvent.keyDown(tab(TABS[TABS.length - 1].label), { key: "ArrowRight" });
    await expectSelected(TABS[0].label);
  });

  it("горячая клавиша Alt+цифра открывает тот же раздел, что и клик", async () => {
    mount();
    await expectSelected(TABS[0].label);

    fireEvent.keyDown(window, { key: "3", altKey: true });
    await expectSelected(TABS[2].label);
  });

  it("без ответа бэкенда показывает причину, а не пустые панели", async () => {
    mode = "backend-down";
    mount();
    const notice = await screen.findByText(/Бэкенд Wake не готов/);
    expect(notice).toBeVisible();
    // Разделы, которым база не нужна, обязаны остаться доступны: Терминал и
    // Funding читают публичный API Lighter напрямую.
    expect(tab("Терминал")).toBeEnabled();
  });

  it("каждая вкладка указывает на единственную панель", async () => {
    mount();
    const tabs = await screen.findAllByRole("tab");
    const panel = await screen.findByRole("tabpanel");
    for (const node of tabs) {
      expect(node).toHaveAttribute("aria-controls", panel.id);
    }
    // Раздел по умолчанию — из реестра TABS, а не из порядка рендера: сдвиг
    // списка молча переложил бы ответственность за панель на другую вкладку.
    expect(panel).toHaveAttribute("aria-labelledby", tabs[0].id);
  });
});

// Отдельный прогон: панель обязана быть внутри дерева, а не рядом с ним —
// иначе `aria-labelledby` указывает на элемент, которого нет, и диктор читает
// «вкладка выбрана» без всякого содержимого.
describe("оболочка", () => {
  it("держит панель в том же дереве, что и навигация", async () => {
    const { container } = mount();
    await screen.findAllByRole("tab");
    const panel = await screen.findByRole("tabpanel");
    const shell = container.querySelector(".app-shell");
    expect(shell).not.toBeNull();
    expect(within(shell as HTMLElement).getByRole("tabpanel")).toBe(panel);
  });
});

/** Строка списка рынков по тикеру. Спрос внутри `.markets-list` и живой узел на
 *  каждой попытке: тикер выбранного рынка продублирован в шапке терминала, а
 *  React при смене сети пересоздаёт строку по новому market_id — захваченный
 *  раньше узел остался бы отсоединённым числом из прошлой сети. */
function marketRow(container: Element, symbol: string): Element | undefined {
  return Array.from(container.querySelectorAll(".markets-list .desk-row")).find((node) =>
    node.textContent?.includes(symbol),
  );
}

// Кэш цен списка живёт вне компонента и переживает remount, который делает
// переключатель сети. Это единственная проверка, где после смены сети читается
// ОТРИСОВАННОЕ число, а не сам факт запроса: прежний e2e ждал запрос к Arcus и
// ничего не сверял, поэтому расхождение цен двух площадок под одним market_id
// (см. COLLISION_ID выше) не ловилось нигде.
describe("переключение сети", () => {
  it("не отдаёт цену mainnet в строке testnet под тем же market_id", async () => {
    const { container } = mount();
    await expectSelected(TABS[0].label);
    fireEvent.click(tab("Терминал"));
    await expectSelected("Терминал");

    // mainnet: market_id 4096 — это OURA, последняя свеча 12.34.
    await waitFor(() =>
      expect(marketRow(container, "OURA")?.textContent).toContain("12.34"),
    );

    fireEvent.click(screen.getByRole("button", { name: "testnet" }));

    // testnet: тот же 4096 — уже BTC, и свеча там другая.
    await waitFor(() =>
      expect(marketRow(container, "BTC")?.textContent).toContain("69,000.12"),
    );
    expect(marketRow(container, "BTC")?.textContent).not.toContain("12.34");
    expect(marketRow(container, "OURA")).toBeUndefined();
  });
});

/* Рынок, снятый с торгов, из книги не исчезает: у 26 из 246 книг mainnet
   (замер /orderBooks?filter=all, 2026-11-13) стоит status inactive. Свечи у них
   продолжают отдавать цену, а заявок нет, поэтому список без фильтра предлагает
   тикет по инструменту, на котором ничего не исполнится. */
describe("снятый с торгов рынок", () => {
  it("не едет ни в рельсе терминала, ни в окне выбора рынка", async () => {
    const { container } = mount();
    await expectSelected(TABS[0].label);
    fireEvent.click(tab("Терминал"));
    await expectSelected("Терминал");

    // Активный сосед отрисован с ценой: «HANMI нет» значит «выкинут», а не
    // «список ещё не заполнился».
    await waitFor(() =>
      expect(marketRow(container, "OURA")?.textContent).toContain("12.34"),
    );
    expect(marketRow(container, "HANMI")).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Выбрать рынок" }));
    const search = await screen.findByLabelText("Поиск рынка");
    fireEvent.change(search, { target: { value: "HANMI" } });
    expect(await screen.findByText("Ничего не найдено")).toBeVisible();
  });

  it("по ссылке ?asset= не открывает кнопку ордера", async () => {
    window.history.replaceState(null, "", "/?tab=terminal&asset=HANMI");
    const { container } = mount();
    await expectSelected("Терминал");

    // Сначала доказательство, что книга пришла: до неё кнопка выключена по
    // любой ссылке, и проверка прошла бы зелёным на пустом экране.
    await waitFor(() => expect(marketRow(container, "OURA")).toBeDefined());

    const ticketName = /Открыть (long|short)|Рынок не загружен|Цена недоступна/;
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ticketName })).toBeDisabled(),
    );
    expect(screen.getByRole("button", { name: "Рынок не загружен" })).toBeVisible();
    expect(container.querySelector(".markets-list")?.textContent).not.toContain("HANMI");
  });
});
