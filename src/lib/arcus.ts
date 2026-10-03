// Thin client for Arcus's public REST API.
// Docs: https://docs.arcus.xyz, https://arcus-11aecf6e.mintlify.app
//
// Arcus is a self-custodial DEX on Robinhood Chain: zero-fee spot stock tokens,
// 24/7 perpetuals up to 50x leverage. API structure is similar to Lighter —
// market_id-based endpoints, public trades/orderbooks/markets, Ed25519 signing
// for order placement (not implemented here — this file is read-only public data).
//
// Everything in this file is public, read-only, unauthenticated data. No funds at risk.
// Order placement needs Arcus Ed25519 keys signed against Ethereum addresses.

const NETWORKS = {
  mainnet: "https://api.arcus.xyz/v1",
  testnet: "https://api.testnet.arcus.xyz/v1",
} as const;

export type ArcusNetwork = keyof typeof NETWORKS;

let currentNetwork: ArcusNetwork = "mainnet";
export function setNetwork(network: ArcusNetwork) {
  currentNetwork = network;
}
export function getNetwork(): ArcusNetwork {
  return currentNetwork;
}
const BASE_URL = () => NETWORKS[currentNetwork];

// GET /v1/markets returns MarketInfo array with fields like marketDisplayName, marketId,
// status, baseAsset, quoteAsset, tickSize, stepSize, and trading bounds.
// Verified from docs.arcus.xyz API reference.
export type ArcusMarket = {
  marketDisplayName: string;
  marketId: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  minOrderSize?: string;
  maxOrderSize?: string;
};

export async function getMarkets(): Promise<ArcusMarket[]> {
  const res = await fetch(`${BASE_URL()}/markets`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  const data = await res.json();
  return data.markets ?? [];
}

// GET /v1/mids returns mid prices as a map of market → price string, plus globalSequenceId.
// Optional query param: market (string) to filter to a single market.
// Verified from docs: response is { mids: { [market]: price }, globalSequenceId: number }.
export async function getMidPrices(market?: string): Promise<{ mids: Record<string, string>; globalSequenceId: number }> {
  const params = market ? `?market=${encodeURIComponent(market)}` : "";
  const res = await fetch(`${BASE_URL()}/mids${params}`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  return res.json();
}

// GET /v1/trades returns recent trades for a market.
// Params: market (required), limit (max 1000), from/to (int64 microseconds).
// Response: { trades: [...], total: number }.
export type ArcusTrade = {
  tradeId: string;
  market: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  timestamp: number;
};

export async function getRecentTrades(market: string, limit = 100): Promise<ArcusTrade[]> {
  const params = new URLSearchParams({
    market,
    limit: String(Math.min(limit, 1000)),
  });
  const res = await fetch(`${BASE_URL()}/trades?${params}`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  const data = await res.json();
  return data.trades ?? [];
}

// GET /v1/l2OrderBook/{market} returns L2 orderbook snapshot.
// Params: nLevels (default 20), sigFigs (significant figures for price/size).
// Response: OrderbookSnapshot with bids, asks, timestamps.
export type ArcusOrderBookLevel = {
  price: string;
  size: string;
};

export type ArcusOrderBook = {
  market: string;
  bids: ArcusOrderBookLevel[];
  asks: ArcusOrderBookLevel[];
  timestamp: number;
  sequenceId: number;
};

export async function getOrderBook(market: string, nLevels = 20): Promise<ArcusOrderBook> {
  const params = new URLSearchParams({
    nLevels: String(nLevels),
  });
  const res = await fetch(`${BASE_URL()}/l2OrderBook/${encodeURIComponent(market)}?${params}`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  return res.json();
}

// Convenience: get a single mid price for a market. Returns null if market not found.
export async function getMidPrice(market: string): Promise<number | null> {
  const data = await getMidPrices(market);
  const price = data.mids[market];
  return price ? Number(price) : null;
}
