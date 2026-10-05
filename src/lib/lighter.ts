// Thin client for Lighter's public REST API.
// Full reference: https://apidocs.lighter.xyz (an llms.txt index exists, meant for agents)
//
// Response shapes in this file were checked against live responses from
// mainnet.zklighter.elliot.ai on 2026-10-02, not guessed from docs. Where the docs are
// silent, the comment says what the live response actually returns.
//
// Everything in this file is public, read-only, unauthenticated data. No funds at risk.
// Order placement (sendTx) and account-scoped endpoints need a Lighter API key + their
// signer (see README — this is a different, separate signing scheme from the L1 wallet).

// mainnet.zklighter.elliot.ai и testnet.zklighter.elliot.ai — оба подтверждены официальными
// источниками Lighter (apidocs.lighter.xyz, GitHub elliottech/lighter-agent-kit).
import { backendJson } from "./backend";
import { LIGHTER_NETWORK, SIGNING_SERVICE_URL } from "./config";

const NETWORKS = {
  mainnet: "https://mainnet.zklighter.elliot.ai/api/v1",
  testnet: "https://testnet.zklighter.elliot.ai/api/v1",
} as const;

export type LighterNetwork = keyof typeof NETWORKS;

// res.json() — Promise<any>: единственное место, где внешний ответ входит в
// типизированный мир. Каждая функция ниже описывает свою сырую форму и один
// раз приводит её к публичному типу — any дальше по коду не расходится.
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

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
  // Живой /orderBooks (mainnet, 2026-10-03): строка в БАЗОВЫХ единицах актива —
  // у BTC "370.840860". Не доллары и не сопоставимо между рынками, поэтому
  // любое сравнение требует Number() и явной подписи "в активе".
  open_interest: string;
};

export async function getOrderBooks(filter: "all" | "spot" | "perp" = "perp"): Promise<OrderBook[]> {
  const res = await fetch(`${BASE_URL()}/orderBooks?filter=${filter}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ order_books: OrderBook[] }>(res);
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

const RESOLUTION_MS: Record<Resolution, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "12h": 12 * 3_600_000,
  "1d": 24 * 3_600_000,
};

// Live check (2026-10-02): the number of candles returned is driven by
// (end_timestamp - start_timestamp) / resolution, NOT by count_back. With
// start_timestamp=0 the API ignores count_back and returns a flat 500 candles,
// so "the last N candles" has to be asked for as an explicit time window.
// Passing count_back=N too is harmless and keeps the intent readable in the URL.
//
// Замер 2026-10-03 на том же окне: ответ содержит N+2 свечи — две лишние по
// краям окна. Поэтому срез здесь, а не на вызывающем коде: "последние N"
// означает ровно N, иначе 25-я свеча попадает в суточный расчёт и меняет число.
export async function getCandles(marketId: number, resolution: Resolution, count = 100): Promise<Candle[]> {
  const end = Date.now();
  const params = new URLSearchParams({
    market_id: String(marketId),
    resolution,
    start_timestamp: String(end - count * RESOLUTION_MS[resolution]),
    end_timestamp: String(end),
    count_back: String(count),
    set_timestamp_to_end: "true",
  });
  const res = await fetch(`${BASE_URL()}/candles?${params}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ c?: Candle[] }>(res);
  return (data.c ?? []).slice(-count);
}

export type Trade = {
  id: string | number;
  price: number;
  size: number;
  isAsk: boolean; // true = last trade was a sell hitting the bid
  timestamp?: number;
};

// Verified against a live mainnet response (2026-10-02): the payload is
// { code, trades: [ { trade_id, price, size, is_maker_ask, timestamp, ... } ] }
// where price/size come back as STRINGS, so they must be Number()-coerced before math.
// Params per https://apidocs.lighter.xyz/reference/recenttrades (market_id int16, limit 1-100).
// Raw trade row: the payload fields noted above; extras are ignored.
type RawTrade = {
  trade_id?: string | number;
  price: string | number;
  size: string | number;
  is_maker_ask?: boolean | number;
  timestamp?: number;
};

export async function getRecentTrades(marketId: number, limit = 20): Promise<Trade[]> {
  const params = new URLSearchParams({ market_id: String(marketId), limit: String(Math.min(limit, 100)) });
  const res = await fetch(`${BASE_URL()}/recentTrades?${params}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ trades?: RawTrade[] }>(res);
  return (data.trades ?? []).map((t, i) => ({
    id: t.trade_id ?? i,
    price: Number(t.price),
    size: Number(t.size),
    isAsk: !!t.is_maker_ask,
    timestamp: t.timestamp,
  }));
}

// GET /api/v1/funding-rates returns one row per (market, venue): the Lighter funding rate
// alongside binance / bybit / hyperliquid for the same market_id. Verified live on
// mainnet 2026-10-02 (737 rows, 211 of them exchange="lighter", keyed by the same
// market_id that /orderBooks uses). Docs describe it as "funding rates across venues";
// they do not state the interval, so rate is shown as returned and only Lighter's own
// rows are annualised — that epoch is 1 hour, see backend/funding_arb.py.
export type FundingRateRow = {
  market_id: number;
  exchange: "binance" | "bybit" | "hyperliquid" | "lighter";
  symbol: string;
  rate: number;
};

export async function getFundingRates(): Promise<FundingRateRow[]> {
  const res = await fetch(`${BASE_URL()}/funding-rates`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ funding_rates: FundingRateRow[] }>(res);
  return data.funding_rates;
}

// One entry in account.positions. Numbers are Number()-coerced from the raw
// STRING fields of the API response — see RawPosition below.
export type LighterPosition = {
  marketId: number;
  symbol: string;
  size: number;
  avgEntry: number;
  value: number;
  unrealizedPnl: number;
  realizedPnl: number;
  liquidationPrice: number;
};

export type LighterAccount = {
  accountIndex: number;
  equityUsd: number;
  positions: LighterPosition[];
  realizedPnlUsd: number;
};

// Raw /account response shapes. Verified live on mainnet 2026-10-02: every
// numeric field arrives as a STRING, including the ones the types below
// declare as number — Number() coercion happens in the mapping code.
type RawPosition = {
  market_id: number;
  symbol: string;
  position: string | number;
  avg_entry_price: string | number;
  position_value: string | number;
  unrealized_pnl: string | number;
  realized_pnl: string | number;
  liquidation_price: string | number;
};

type RawAccount = {
  index: number;
  total_asset_value: string | number;
  positions?: RawPosition[];
};

export async function getAccountByL1Address(address: string): Promise<LighterAccount> {
  const res = await fetch(`${BASE_URL()}/account?by=l1_address&value=${address}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ accounts?: RawAccount[] }>(res);
  return mapAccount(data.accounts ?? []);
}

// by=index is public on the same /account endpoint; the bulk /accounts route is not
// (it answers 403 without an API key), so one request per account is the only option.
export async function getAccountByIndex(index: number): Promise<LighterAccount> {
  const res = await fetch(`${BASE_URL()}/account?by=index&value=${index}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ accounts?: RawAccount[] }>(res);
  return mapAccount(data.accounts ?? []);
}

// Lighter returns a row per market the account has ever touched, so most rows
// carry position "0.0000" — they are kept as-is (size 0); callers filter on size.
function mapAccount(accounts: RawAccount[]): LighterAccount {
  const account = accounts[0];
  if (!account) throw new Error("Аккаунт не найден");
  const positions: LighterPosition[] = (account.positions ?? []).map((p) => ({
    marketId: p.market_id,
    symbol: p.symbol,
    size: Number(p.position),
    avgEntry: Number(p.avg_entry_price),
    value: Number(p.position_value),
    unrealizedPnl: Number(p.unrealized_pnl),
    realizedPnl: Number(p.realized_pnl),
    liquidationPrice: Number(p.liquidation_price),
  }));
  return {
    accountIndex: account.index,
    equityUsd: Number(account.total_asset_value),
    positions,
    realizedPnlUsd: positions.reduce((s, p) => s + p.realizedPnl, 0),
  };
}

// Wake's own backend (backend/app.py) — persistence for followers/leaders/follows.
// Адрес — из VITE_BACKEND_URL, запросы идут через lib/backend.ts.

// Тот же ответ, что печатает бот по /markets: ряды, отсортированные по реальному
// $-обороту за 24 часа, с funding по каждому. Считается на бэкенде, потому что
// оборот — сумма 24 часовых свечей по каждому рынку (18 запросов к Lighter), и
// кэшируется там же на 60 секунд. Держать эту математику второй раз в TS
// означало бы расходиться с ботом.
export type MarketOverviewRow = {
  market_id: number;
  symbol: string;
  base: string;
  price: number;
  change_24h: number;          // доля за 24ч: -0.002 = -0.20%
  quote_volume_24h: number;    // USD
  open_interest_base: number;  // в единицах актива, не в $
  min_base_amount: number;
  size_decimals: number;
  taker_fee: number;
  maker_fee: number;
  funding_hourly: number | null;      // без знака; кто платит — funding_payer
  funding_annualized: number | null;  // ставка × 24 × 365
  funding_payer: "long" | "short" | null;
};

export type MarketOverview = {
  network: LighterNetwork;
  ranked_by: "quote_volume_24h";
  epoch_hours: number;
  count: number;
  rows: MarketOverviewRow[];
  no_market: string[];
  no_data: string[];
};

export async function getMarketOverview(): Promise<MarketOverview> {
  return backendJson<MarketOverview>("/markets/overview");
}

export async function registerFollower(l1Address: string): Promise<string> {
  const data = await backendJson<{ follower_id: string }>("/followers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l1_address: l1Address }),
  });
  return data.follower_id;
}

export type BackendFollow = {
  id: string;
  follower_id: string;
  leader_id: string;
  leader_handle?: string;
  allocation_usd: number;
  max_leverage: number;
  current_mirrored_size: number;
  paused: number;
  created_at: number;
};

export async function listFollowsForFollower(followerId: string): Promise<BackendFollow[]> {
  return backendJson<BackendFollow[]>(`/follows/by-follower/${followerId}`);
}

export async function createFollow(followerId: string, leaderId: string, allocationUsd: number, maxLeverage = 3): Promise<string> {
  const data = await backendJson<{ follow_id: string }>("/follows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ follower_id: followerId, leader_id: leaderId, allocation_usd: allocationUsd, max_leverage: maxLeverage }),
  });
  return data.follow_id;
}

export async function setFollowPaused(followId: string, paused: boolean, followerId: string): Promise<void> {
  await backendJson(`/follows/${followId}/${paused ? "pause" : "resume"}?follower_id=${encodeURIComponent(followerId)}`, { method: "POST" });
}

export async function deleteFollow(followId: string, followerId: string): Promise<void> {
  await backendJson(`/follows/${followId}?follower_id=${encodeURIComponent(followerId)}`, { method: "DELETE" });
}

// mirror_log — то, чем закончился каждый прогон копи-движка (leader_listener.py).
// Статусы фиксированы схемой: planned | skipped | dry_run | sent | failed.
export type MirrorLogRow = {
  id: string;
  follow_id: string;
  market_id: number;
  side: "long" | "short";
  base_amount: number;
  reduce_only: number;
  status: "planned" | "skipped" | "dry_run" | "sent" | "failed";
  reason: string | null;
  tx_hash: string | null;
  created_at: number;
  leader_handle: string;
};

export async function getMirrorLog(followerId: string, limit = 50): Promise<MirrorLogRow[]> {
  return backendJson<MirrorLogRow[]>(`/mirror-log/${followerId}?limit=${limit}`);
}

export async function registerLeader(lighterAccountIndex: number, handle: string, feeBps = 8): Promise<string> {
  const data = await backendJson<{ leader_id: string }>("/leaders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lighter_account_index: lighterAccountIndex, handle, fee_bps: feeBps }),
  });
  return data.leader_id;
}

export type LeaderStats = { follower_count: number; total_aum_usd: number };

export async function getLeaderStats(leaderId: string): Promise<LeaderStats> {
  const data = await backendJson<{ follower_count: number; total_aum_usd: number }>(`/follows/by-leader/${leaderId}`);
  return { follower_count: data.follower_count, total_aum_usd: data.total_aum_usd };
}

// Ряд подписок лидера — те же строки таблицы follows, что считает getLeaderStats,
// но поштучно: видно, кто именно и сколько аллоцировал. Пауза исключается запросом.
export type LeaderFollowRow = {
  id: string;
  follower_id: string;
  allocation_usd: number;
  max_leverage: number;
  current_mirrored_size: number;
  created_at: number;
};

export async function listFollowsForLeader(leaderId: string): Promise<LeaderFollowRow[]> {
  const data = await backendJson<{ follows?: BackendFollow[] }>(`/follows/by-leader/${leaderId}`);
  return (data.follows ?? []).map((r) => ({
    id: r.id,
    follower_id: r.follower_id,
    allocation_usd: Number(r.allocation_usd),
    max_leverage: Number(r.max_leverage),
    current_mirrored_size: Number(r.current_mirrored_size),
    created_at: Number(r.created_at),
  }));
}

// fee_bps можно менять после публикации: POST /leaders отдаёт существующего лидера
// как есть и новые значения не применяет, поэтому для комиссии — отдельный PATCH.
export async function setLeaderFee(leaderId: string, feeBps: number): Promise<void> {
  await backendJson(`/leaders/${leaderId}/fee`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fee_bps: feeBps }),
  });
}

export type LeaderRow = {
  id: string;
  lighter_account_index: number;
  handle: string;
  fee_bps: number;
  created_at: number;
};

export async function listLeaders(): Promise<LeaderRow[]> {
  return backendJson<LeaderRow[]>("/leaders");
}

// Ордер подписывает и отправляет локальный backend/signing_service.py; адрес — из
// VITE_SIGNING_SERVICE_URL. Если сервис не запущен, запрос падает явной ошибкой —
// интерфейс не делает вид, что сделка прошла.
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
  return json<{ tx_hash: string }>(res);
}
