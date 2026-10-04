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

// POST /portfolio/hedge: suggestion null, когда хеджа не нашлось
export type HedgeSuggestion = {
  market_id: number;
  symbol: string;
  hedge_notional_usd: number;
  correlation_to_target: number;
  resulting_portfolio_vol_usd: number;
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
