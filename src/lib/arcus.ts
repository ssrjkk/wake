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

// res.json() is Promise<any> — this is the single entry point where an external
// response crosses into typed code; each function declares its response shape.
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

let currentNetwork: ArcusNetwork = "mainnet";
export function setNetwork(network: ArcusNetwork) {
  currentNetwork = network;
}
export function getNetwork(): ArcusNetwork {
  return currentNetwork;
}
const BASE_URL = () => NETWORKS[currentNetwork];

// GET /v1/markets returns MarketInfo array. Live mainnet response (2026-10-04):
// marketId is an INT (1, 2, 3…), the perp/spot discriminator is the `type` field
// ("PERPETUAL"), and status is "ONLINE", not "ACTIVE". Docs described an earlier
// shape; the fields below are what the API actually returns.
export type ArcusMarket = {
  marketDisplayName: string;
  marketId: number;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: string;
  stepSize: string;
  type?: string;
  category?: string;
  minOrderSize?: string;
  maxOrderSize?: string;
};

export function isArcusPerp(m: ArcusMarket): boolean {
  return m.type === "PERPETUAL" || m.marketDisplayName.includes("-PERP");
}

export async function getMarkets(): Promise<ArcusMarket[]> {
  const res = await fetch(`${BASE_URL()}/markets`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  const data = await json<{ markets?: ArcusMarket[] }>(res);
  return data.markets ?? [];
}

// GET /v1/mids returns mid prices keyed by marketDisplayName ("BTC-USD": "85212.05"
// on live mainnet), plus globalSequenceId.
export type MidPrices = { mids: Record<string, string>; globalSequenceId: number };

export async function getMidPrices(market?: string): Promise<MidPrices> {
  const params = market ? `?market=${encodeURIComponent(market)}` : "";
  const res = await fetch(`${BASE_URL()}/mids${params}`);
  if (!res.ok) throw new Error(`Arcus API ${res.status}`);
  return json<MidPrices>(res);
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
  const data = await json<{ trades?: ArcusTrade[] }>(res);
  return data.trades ?? [];
}
