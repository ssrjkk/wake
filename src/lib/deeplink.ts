import type { Tab } from "../components/types";

// Точка входа извне: ссылка Telegram-бота открывает нужный раздел и, для
// карточки рынка, нужный инструмент. Разбирается до первого рендера — иначе
// переключение вкладок затирает то, с чего начали.
const TABS: readonly Tab[] = [
  "dashboard",
  "terminal",
  "discover",
  "portfolio",
  "earn",
  "predict",
  "agent",
  "risk",
  "funding",
];

// Тот же профиль тикера, что держит бот: символ идёт в заголовок рынка, а не в
// запрос, но пустое или мусорное значение открывать нечего.
const ASSET = /^[A-Z0-9$]{1,12}$/;

export interface Entry {
  tab: Tab;
  asset: string;
}

function readEntry(params: URLSearchParams, fallback: Entry): Entry {
  const tab = params.get("tab");
  const asset = (params.get("asset") ?? "").toUpperCase();
  return {
    tab: tab && (TABS as readonly string[]).includes(tab) ? (tab as Tab) : fallback.tab,
    asset: ASSET.test(asset) ? asset : fallback.asset,
  };
}

export function readEntryFromSearch(search: string, fallback: Entry): Entry {
  return readEntry(new URLSearchParams(search), fallback);
}
