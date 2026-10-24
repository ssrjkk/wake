import { TAB_IDS } from "./tabs";
import type { Tab } from "../components/types";

// Точка входа извне: ссылка Telegram-бота открывает нужный раздел и, для
// карточки рынка, нужный инструмент или конкретный Predict-рынок. Разбирается до
// первого рендера — иначе переключение вкладок затирает то, с чего начали.

// Тот же профиль тикера, что держит бот: символ идёт в заголовок рынка, а не в
// запрос, но пустое или мусорное значение открывать нечего.
const ASSET = /^[A-Z0-9$]{1,12}$/;

// id рынка — uuid4 из таблицы predict_markets. Профиль синтаксический, как у
// тикера: значение не уходит ни в какой запрос само по себе, оно только ищется
// среди уже полученных списков.
const MARKET = /^[0-9a-fA-F][0-9a-fA-F-]{30,63}$/;

export interface Entry {
  tab: Tab;
  asset: string;
  market: string | null;
}

function readEntry(params: URLSearchParams, fallback: Entry): Entry {
  const tab = params.get("tab");
  const asset = (params.get("asset") ?? "").toUpperCase();
  const market = params.get("market") ?? "";
  return {
    tab: tab && (TAB_IDS as readonly string[]).includes(tab) ? (tab as Tab) : fallback.tab,
    asset: ASSET.test(asset) ? asset : fallback.asset,
    market: MARKET.test(market) ? market : null,
  };
}

export function readEntryFromSearch(search: string, fallback: Entry): Entry {
  return readEntry(new URLSearchParams(search), fallback);
}
