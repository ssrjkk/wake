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

// Ответ GET /subscription/<user_id> (backend/api/agent.py): «none» синтезируется
// бэкендом, когда записи о подписке нет, остальные — значения Tier из
// backend/subscription.py. days_left_in_trial приходит только у подписки.
export type Subscription = {
  tier: "none" | "free_trial" | "free" | "pro";
  has_ai_agent: boolean;
  days_left_in_trial?: number;
};

// Вкладки верхнего уровня. Тип живёт здесь, а не в App.tsx, потому что
// навигация вглубь экрана («открыть BTC в терминале», «перейти в Predict»)
// нужна дочерним компонентам, и расширять список вкладок приходится обоим.
export type Tab = "dashboard" | "terminal" | "discover" | "portfolio" | "earn" | "predict" | "agent" | "risk" | "funding";

export type MarketCategory = "Crypto" | "Stocks" | "Forex" | "Commodities" | "Spot";

export const FOREX_SYMBOLS = new Set(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"]);
export const COMMODITY_SYMBOLS = new Set(["XAU", "XAG", "WTI", "BRENT", "NATGAS", "GOLD", "SILVER"]);
export const STOCK_SYMBOLS = new Set(["AAPL", "TSLA", "NVDA", "GOOGL", "META", "AMZN", "MSFT", "NFLX", "AMD", "COIN", "MSTR"]);
