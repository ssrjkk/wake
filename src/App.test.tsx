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
import { BACKEND_URL } from "./lib/config";
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
  if (url.includes("/api/v1/orderBooks")) return json({ order_books: [MARKET] });
  if (url.includes("/api/v1/candles")) return json({ c: [] });
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
