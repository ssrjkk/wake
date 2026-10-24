import type { LighterPosition } from "../lib/lighter";

// Snapshot of one leader as Wake's backend knows them (leaders + follows tables),
// plus what Lighter's public account endpoint says about that same account.
export type LeaderExchange = {
  equityUsd: number;
  realizedPnlUsd: number;
  openPositions: LighterPosition[];
};

export type Leader = {
  id: string;
  handle: string;
  feeBps: number;
  lighterAccountIndex: number;
  since: number;
  followers: number;
  aumUsd: number;
  exchange: LeaderExchange | null;
};

export type Following = {
  followId: string;
  leaderId: string;
  handle: string;
  allocationUsd: number;
  maxLeverage: number;
  mirroredSize: number;
  paused: boolean;
};

export type RiskPosition = { marketId: number; symbol: string; notionalUsd: number; side: "long" | "short" };

// POST /portfolio/risk (backend/api/portfolio.py)
export type RiskAnalysis = {
  naive_dollar_volatility: number;
  portfolio_dollar_volatility: number;
  diversification_score: number;
};

// POST /portfolio/hedge: suggestion null, когда хеджа не нашлось.
// unhedged_vol_usd — риск цели без хеджа: без него «результирующие 800$» не
// читаются никак, и панель предлагала бы хедж, который риск увеличил.
export type HedgeSuggestion = {
  market_id: number;
  symbol: string;
  hedge_notional_usd: number;
  correlation_to_target: number;
  resulting_portfolio_vol_usd: number;
  unhedged_vol_usd: number;
};

// POST /funding-arb/check (backend/api/funding.py): opportunity null —
// отрицательный funding или APR ниже порога
export type FundingCheck = {
  opportunity: {
    symbol: string;
    market_id: number;
    annualized_yield: number;
    perp_side: string;
    spot_needed: boolean;
    hourly_rate: number;
  } | null;
};

// POST /funding-arb/size: position null + reason, когда капитала не хватает
export type FundingSizing = {
  position: {
    perp_notional_usd: number;
    spot_notional_usd: number;
    perp_base_amount: number;
    spot_base_amount: number;
  } | null;
  reason?: string;
  // цена подставляется на клиенте из последней 1h-свечи
  price?: number;
};

// Ответ GET /subscription (backend/api/agent.py): «none» синтезируется бэкендом,
// когда записи о подписке нет, остальные — значения Tier из
// backend/subscription.py. days_left_in_trial приходит только у подписки. Чей это
// тир, решает токен сессии: эндпоинт не принимает user_id, потому что присланный
// id — пожелание клиента.
export type Subscription = {
  tier: "none" | "free_trial" | "free" | "pro";
  has_ai_agent: boolean;
  has_copy_trading: boolean;
  has_predict_markets: boolean;
  days_left_in_trial?: number;
};

// Вкладки верхнего уровня. Тип живёт здесь, а не в App.tsx, потому что
// навигация вглубь экрана («открыть BTC в терминале», «перейти в Predict»)
// нужна дочерним компонентам, и расширять список вкладок приходится обоим.
export type Tab = "dashboard" | "terminal" | "discover" | "portfolio" | "earn" | "predict" | "agent" | "risk" | "funding";

export type MarketCategory = "Crypto" | "Stocks" | "Forex" | "Commodities" | "Spot";

// Категории — единственный случай, где сайт называет класс актива: у книги
// Lighter нет поля «тип инструмента» (market_deployer у всех "lighter",
// base_asset_id/quote_asset_id/multiplier ничего не различают — проверено на
// живом /orderBooks 2026-10-24). Поэтому это курируемый список по тикеру, а не
// правило, и всё, чего в списке нет, показывается как Crypto: среди 225
// активных рынков книги крипто-перпов большинство, но для отдельной строки это
// допущение, а не факт — в фильтре об этом сказано прямо.
//
// Список сверян с живым /orderBooks?filter=all 2026-10-24. Мусорные значения,
// которых в книге нет и которые никогда не были тикерами Lighter ("GOLD",
// "SILVER", "BRENT" — по факту XAU, XAG, BRENTOIL), из него убраны: строка,
// которая ни с чем не сопоставляется, выглядит как покрытие, которого нет.
//
// SAMSUNGUSD / HYUNDAIUSD / SKHYNIXUSD в Forex не добавлены сознательно: по
// форме это похоже на валютную пару, но по смыслу — акция в долларах, а чем
// именно они являются у Lighter, по книге не определить.
export const FOREX_SYMBOLS = new Set(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY", "USDHKD", "USDKRW"]);
export const COMMODITY_SYMBOLS = new Set(["XAU", "XAG", "XPT", "XPD", "XCU", "WTI", "BRENTOIL", "NATGAS"]);
export const STOCK_SYMBOLS = new Set([
  "AAPL", "TSLA", "NVDA", "GOOGL", "META", "AMZN", "MSFT", "NFLX", "AMD", "COIN", "MSTR",
  // из живого списка Lighter: акции, ADS и биржевые фонды с известными тикерами
  "AAOI", "ARM", "ASML", "AXTI", "BABA", "BB", "DELL", "GEV", "GME", "HOOD", "IBM", "INTC",
  "MRNA", "MRVL", "MU", "NOK", "NOW", "ORCL", "PLTR", "QCOM", "RKLB", "SNDK", "TSM", "TTWO",
  "WDC", "EWY", "IWM", "QQQ", "SPY", "SOXL", "SOXS", "SPX", "US100", "US500", "US10Y", "TUR30",
]);
