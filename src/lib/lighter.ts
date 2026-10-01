// Thin client for Lighter's public REST API.
// Full reference: https://apidocs.lighter.xyz (an llms.txt index exists, meant for agents)
// Base URL and response shapes below are taken directly from Lighter's own OpenAPI spec
// (fetched 2026-08-09) — not guessed.
//
// Everything in this file is public, read-only, unauthenticated data. No funds at risk.
// Order placement (sendTx) and account-scoped endpoints need a Lighter API key + their
// signer (see README — this is a different, separate signing scheme from the L1 wallet).

// mainnet.zklighter.elliot.ai и testnet.zklighter.elliot.ai — оба подтверждены официальными
// источниками Lighter (apidocs.lighter.xyz, GitHub elliottech/lighter-agent-kit).
import { BACKEND_URL, SIGNING_SERVICE_URL as SIGNING_SERVICE_BASE_URL, LIGHTER_NETWORK } from "./config";

const NETWORKS = {
  mainnet: "https://mainnet.zklighter.elliot.ai/api/v1",
  testnet: "https://testnet.zklighter.elliot.ai/api/v1",
} as const;

export type LighterNetwork = keyof typeof NETWORKS;

// Сеть по умолчанию задаётся переменной окружения VITE_LIGHTER_NETWORK.
let currentNetwork: LighterNetwork = LIGHTER_NETWORK;
export function setNetwork(network: LighterNetwork) {
  currentNetwork = network;
}
export function getNetwork(): LighterNetwork {
  return currentNetwork;
}
const BASE_URL = () => NETWORKS[currentNetwork];

export type OrderBook = {
  symbol: string;
  market_id: number;
  market_type: "perp" | "spot";
  status: "active" | "inactive";
  taker_fee: string;
  maker_fee: string;
  min_base_amount: string;
  min_quote_amount: string;
  supported_price_decimals: number;
  supported_size_decimals: number;
};

export async function getOrderBooks(filter: "all" | "spot" | "perp" = "perp"): Promise<OrderBook[]> {
  const res = await fetch(`${BASE_URL()}/orderBooks?filter=${filter}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await res.json();
  return data.order_books;
}

export type Candle = {
  t: number; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // base volume
  V: number; // quote volume
};

export type Resolution = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "1d";

// NOTE: market_id, resolution, start_timestamp, end_timestamp and count_back are all
// marked required in Lighter's spec, but the doc doesn't spell out how start/end interact
// with count_back when you just want "the last N candles". The values below are a
// reasonable first attempt (end = now, start = 0, count_back = N) — verify against
// https://apidocs.lighter.xyz/reference/candles once you can actually hit the network.
export async function getCandles(marketId: number, resolution: Resolution, count = 100): Promise<Candle[]> {
  const params = new URLSearchParams({
    market_id: String(marketId),
    resolution,
    start_timestamp: "0",
    end_timestamp: String(Date.now()),
    count_back: String(count),
    set_timestamp_to_end: "true",
  });
  const res = await fetch(`${BASE_URL()}/candles?${params}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await res.json();
  return data.c;
}

export type Trade = {
  id: string | number;
  price: number;
  size: number;
  isAsk: boolean; // true = last trade was a sell hitting the bid
  timestamp?: number;
};

// Query params confirmed from https://apidocs.lighter.xyz/reference/recenttrades
// (market_id: int16 required, limit: int64 required, 1-100). The docs only show an
// interactive "Try It" widget, not a static example, so the exact response field names
// aren't published — this parses a couple of likely shapes defensively. Confirm the real
// field names against a live response before depending on this for anything beyond display.
export async function getRecentTrades(marketId: number, limit = 20): Promise<Trade[]> {
  const params = new URLSearchParams({ market_id: String(marketId), limit: String(limit) });
  const res = await fetch(`${BASE_URL()}/recentTrades?${params}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await res.json();
  const list: any[] = data.trades ?? data.recent_trades ?? (Array.isArray(data) ? data : []);
  return list.map((t, i) => ({
    id: t.trade_id ?? t.id ?? i,
    price: Number(t.price),
    size: Number(t.size ?? t.base_amount ?? t.amount),
    isAsk: t.is_maker_ask ?? t.taker_is_ask ?? t.is_ask ?? false,
    timestamp: t.timestamp ?? t.block_timestamp,
  }));
}

export async function getAccountByL1Address(address: string) {
  const res = await fetch(`${BASE_URL()}/account?by=l1_address&value=${address}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  return res.json();
}

// Wake's own backend (backend/app.py) — persistence for followers/leaders/follows.
// Адрес — из VITE_BACKEND_URL (см. config.ts), по умолчанию локальный dev.
const WAKE_BACKEND_URL = BACKEND_URL;

export async function registerFollower(l1Address: string): Promise<string> {
  const res = await fetch(`${WAKE_BACKEND_URL}/followers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l1_address: l1Address }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).follower_id;
}

export type BackendFollow = {
  id: string;
  leader_id: string;
  leader_handle: string;
  allocation_usd: number;
  max_leverage: number;
  current_mirrored_size: number;
  paused: number;
};

export async function listFollowsForFollower(followerId: string): Promise<BackendFollow[]> {
  const res = await fetch(`${WAKE_BACKEND_URL}/follows/by-follower/${followerId}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createFollow(followerId: string, leaderId: string, allocationUsd: number, maxLeverage = 3): Promise<string> {
  const res = await fetch(`${WAKE_BACKEND_URL}/follows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ follower_id: followerId, leader_id: leaderId, allocation_usd: allocationUsd, max_leverage: maxLeverage }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).follow_id;
}

export async function setFollowPaused(followId: string, paused: boolean): Promise<void> {
  const res = await fetch(`${WAKE_BACKEND_URL}/follows/${followId}/${paused ? "pause" : "resume"}`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

export async function registerLeader(lighterAccountIndex: number, handle: string, feeBps = 8): Promise<string> {
  const res = await fetch(`${WAKE_BACKEND_URL}/leaders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lighter_account_index: lighterAccountIndex, handle, fee_bps: feeBps }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).leader_id;
}

export type LeaderStats = { follower_count: number; total_aum_usd: number };

export async function getLeaderStats(leaderId: string): Promise<LeaderStats> {
  const res = await fetch(`${WAKE_BACKEND_URL}/follows/by-leader/${leaderId}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  return { follower_count: data.follower_count, total_aum_usd: data.total_aum_usd };
}

// Calls the local signing service from backend/signing_service.py — Phase 1, solo trading
// only. Not running by default; this is what makes that honest by failing loudly, not
// pretending to succeed, when the service isn't up. Адрес — из VITE_SIGNING_SERVICE_URL.
const SIGNING_SERVICE_URL = SIGNING_SERVICE_BASE_URL;

export async function placeOrderViaSigningService(
  market: OrderBook,
  side: "long" | "short",
  usdSize: number,
  price: number
): Promise<{ tx_hash: string }> {
  const baseAmountFloat = usdSize / price;
  const baseAmount = Math.floor(baseAmountFloat * 10 ** market.supported_size_decimals);
  const priceInt = Math.round(price * 10 ** market.supported_price_decimals);

  if (baseAmount <= 0) {
    throw new Error("Размер после округления по decimals рынка равен нулю — увеличь сумму");
  }

  const res = await fetch(`${SIGNING_SERVICE_URL}/place-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      market_index: market.market_id,
      client_order_index: Date.now() % 1_000_000,
      base_amount: baseAmount,
      price: priceInt,
      is_ask: side === "short",
      reduce_only: false,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(detail);
  }
  return res.json();
}
