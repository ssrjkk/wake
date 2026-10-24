// Thin client for Lighter's public REST API.
// Full reference: https://apidocs.lighter.xyz (an llms.txt index exists, meant for agents)
//
// Response shapes in this file were checked against live responses from
// mainnet.zklighter.elliot.ai on 2026-10-02, not guessed from docs. Where the docs are
// silent, the comment says what the live response actually returns.
//
// Запросы к Lighter — публичные, только чтение, без ключей: это котировки, а не
// чужие деньги. Размещение ордеров (sendTx) и аккаунтные эндпоинты Lighter требуют
// их API-ключ и свой signer (см. README — схема подписи там другая, чем у L1-кошелька).
//
// Вторая половина файла ходит в бэкенд Wake: часть маршрутов публичная (список
// лидеров, статистика лидера), а всё, у чего есть владелец, уходит с токеном
// сессии — заголовок подмешивает lib/backend.ts.

// mainnet.zklighter.elliot.ai и testnet.zklighter.elliot.ai — оба подтверждены официальными
// источниками Lighter (apidocs.lighter.xyz, GitHub elliottech/lighter-agent-kit).
import { backendJson } from "./backend";
import { timedFetch } from "./net";
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

// Хост отдельной строкой: в состоянии «Lighter не отвечает» нужно показать,
// именно куда не прошёл запрос, а не заставлять человека вычитать его из
// переключателя сети.
export function getApiHost(): string {
  return new URL(BASE_URL()).host;
}

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
  // Рядом с open_interest Lighter отдаёт и тот же интерес в долларах (замер
  // 2026-10-24: ключ есть у всех 225 активных рынков, у 16 из них значение
  // "0.000000" — новый рынок без открытого интереса). Формат — строка вида
  // "9920884.729544". Именно это поле сопоставимо между BTC и DOGE, поэтому по
  // нему ранжируются кандидаты на хедж. Тип — string, как у min_base_amount:
  // объявить его числом значило бы брать `toFixed` со строки и полагаться на то,
  // что `<` и `-` случайно приводят строку к числу.
  open_interest_usd?: string;
};

/** Открытый интерес в долларах числом. Пустое поле и мусор дают 0: рынок просто
 *  не попадёт в отбор, тогда как NaN в сортировке ведёт себя как «больше всех». */
export function openInterestUsd(m: OrderBook): number {
  const v = Number(m.open_interest_usd);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export async function getOrderBooks(filter: "all" | "spot" | "perp" = "perp"): Promise<OrderBook[]> {
  const res = await timedFetch(`${BASE_URL()}/orderBooks?filter=${filter}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ order_books: OrderBook[] }>(res);
  return data.order_books;
}

export type Candle = {
  t: number; // epoch milliseconds — Lighter отдаёт именно миллисекунды
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
  const res = await timedFetch(`${BASE_URL()}/candles?${params}`);
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
  const res = await timedFetch(`${BASE_URL()}/recentTrades?${params}`);
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
  const res = await timedFetch(`${BASE_URL()}/funding-rates`);
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
  const res = await timedFetch(`${BASE_URL()}/account?by=l1_address&value=${address}`);
  if (!res.ok) throw new Error(`Lighter API ${res.status}`);
  const data = await json<{ accounts?: RawAccount[] }>(res);
  return mapAccount(data.accounts ?? []);
}

// by=index is public on the same /account endpoint; the bulk /accounts route is not
// (it answers 403 without an API key), so one request per account is the only option.
export async function getAccountByIndex(index: number): Promise<LighterAccount> {
  const res = await timedFetch(`${BASE_URL()}/account?by=index&value=${index}`);
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
  funding_payer: "long" | "short" | "none" | null;
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

// Чьё это состояние, решает токен в заголовке, а не id в адресе: /follows,
// /mirror-log и /agent/memory отдают строки субъекта сессии. Параметр-follower_id
// из этих функций убран вместе с маршрутом, который его принимал.
export async function listOwnFollows(): Promise<BackendFollow[]> {
  return backendJson<BackendFollow[]>("/follows");
}

export async function createFollow(leaderId: string, allocationUsd: number, maxLeverage = 3): Promise<string> {
  const data = await backendJson<{ follow_id: string }>("/follows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leader_id: leaderId, allocation_usd: allocationUsd, max_leverage: maxLeverage }),
  });
  return data.follow_id;
}

export async function setFollowPaused(followId: string, paused: boolean): Promise<void> {
  await backendJson(`/follows/${encodeURIComponent(followId)}/${paused ? "pause" : "resume"}`, { method: "POST" });
}

export async function deleteFollow(followId: string): Promise<void> {
  await backendJson(`/follows/${encodeURIComponent(followId)}`, { method: "DELETE" });
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

export async function getMirrorLog(limit = 50): Promise<MirrorLogRow[]> {
  return backendJson<MirrorLogRow[]>(`/mirror-log?limit=${limit}`);
}

// Индекс аккаунта здесь не передаётся: его берёт из записи, привязанной входом
// кошелька, сам бэкенд. Присланный индекс позволил бы опубликовать лидера под
// чужим аккаунтом и чужой статистикой.
export async function registerLeader(handle: string, feeBps = 8): Promise<string> {
  const data = await backendJson<{ leader_id: string; active: boolean }>("/leaders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle, fee_bps: feeBps }),
  });
  return data.leader_id;
}

export type OwnLeader = {
  id: string;
  handle: string;
  fee_bps: number;
  active: boolean;
};

/** Свой лидер — включая выключенного.

    Публичный listLeaders() отдаёт только опубликованных, поэтому по нему нельзя
    восстановить положение рубильника после перезагрузки страницы: «выключен» и
    «никогда не публиковался» сливаются в один пустой ответ. */
export async function getMyLeader(): Promise<OwnLeader | null> {
  const data = await backendJson<{ leader: OwnLeader | null }>("/leaders/mine");
  return data.leader;
}

/** Выключить и включить публикацию. Пока не ответит бэкенд, интерфейс не
 *  показывает переключатель в новом положении: выключение, которое база не
 *  приняла, оставило бы человека верить, что его сделки больше не копируют. */
export async function setLeaderActive(leaderId: string, active: boolean): Promise<void> {
  await backendJson(`/leaders/${encodeURIComponent(leaderId)}/active`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  });
}

export type LeaderStats = { follower_count: number; total_aum_usd: number };

export async function getLeaderStats(leaderId: string): Promise<LeaderStats> {
  const data = await backendJson<{ follower_count: number; total_aum_usd: number }>(`/follows/by-leader/${leaderId}`);
  return { follower_count: data.follower_count, total_aum_usd: data.total_aum_usd };
}

// Ряд подписок лидера — те же строки таблицы follows, что считает getLeaderStats,
// но поштучно и только для владельца: публичный GET /follows/by-leader отдаёт
// агрегаты, потому что «кто именно и на сколько аллоцировал» у оператора
// закрыто токеном куратора, и правилом должно быть оно, а не комментарий.
export type LeaderFollowRow = {
  id: string;
  follower_id: string;
  allocation_usd: number;
  max_leverage: number;
  current_mirrored_size: number;
  created_at: number;
};

/** Консоль лидера: построчный список его подписчиков. 403, если лидер чужой. */
export async function listOwnLeaderFollowers(leaderId: string): Promise<LeaderFollowRow[]> {
  const rows = await backendJson<BackendFollow[]>(`/leaders/${leaderId}/followers`);
  return rows.map((r) => ({
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
// интерфейс не делает вид, что сделка прошла. Пока у сервиса включён сухой ход
// (WAKE_DRY_RUN, значение по умолчанию), он возвращает план, dry_run: true и
// tx_hash=null: в Lighter ничего не уходит.
const TICK_EPSILON = 1e-9;

/** Базовые единицы рынка: amount * 10**size_decimals, округление вниз.
 *
 * Math.floor(0.29 * 100) даёт 28, потому что 0.29*100 в float64 это
 * 28.999999999999996 — тот же баг, что был в Python-части, и он стоил одного
 * шага цены на каждом ордере, где значение кратно шагу. Сначала проверяется, не
 * лежит ли число в пределах float-шума под целым: если да, берётся целое; если
 * значение реально ниже (28.5, 28.999) — всё равно floor, вверх не округляем. */
export function toBaseUnits(amount: number, decimals: number): number {
  const scaled = amount * 10 ** decimals;
  const nearest = Math.round(scaled);
  return nearest <= scaled + TICK_EPSILON ? nearest : Math.floor(scaled);
}

/** Цена в тиках рынка: price * 10**price_decimals, ближайший тик. */
export function toPriceTicks(price: number, decimals: number): number {
  const scaled = price * 10 ** decimals;
  const nearest = Math.round(scaled);
  return nearest >= scaled - TICK_EPSILON ? nearest : Math.ceil(scaled);
}

/** client_order_index: уникальный на каждый замысел и в границах int32.
 *
 * Date.now() % 1e6 повторяется каждые ~16,7 минуты и совпадает у двух кликов в
 * одну миллисекунду. signing_service помнит отправленные индексы час и на
 * совпадении отдаёт tx_hash прошлой сделки, не отправляя ордер — «успешный»
 * ответ без ордера. crypto.getRandomValues даёт 31-битное значение; вероятность
 * совпадения на масштабе одного счёта пренебрежима. */
export function randomClientOrderIndex(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return Number(buf[0] % 0x7fffffff) || 1;
}

export async function placeOrderViaSigningService(
  market: OrderBook,
  side: "long" | "short",
  usdSize: number,
  price: number
): Promise<{ tx_hash: string | null; dry_run: boolean }> {
  const baseAmount = toBaseUnits(usdSize / price, market.supported_size_decimals);
  const priceInt = toPriceTicks(price, market.supported_price_decimals);
  const minQuote = Number(market.min_quote_amount);

  if (!(usdSize > 0) || !(price > 0)) {
    throw new Error("Размер и цена должны быть положительными числами");
  }
  if (baseAmount <= 0) {
    throw new Error("Размер после округления по decimals рынка равен нулю — увеличь сумму");
  }
  if (minQuote > 0 && usdSize < minQuote) {
    // До отправки: Lighter отверг бы такой ордер своей строкой, и человек получил
    // бы ошибку биржи вместо ответа «не хватает на минимум этого рынка».
    throw new Error(
      `Минимальный ордер по паре — ${minQuote} USDC, у тебя ${usdSize} USDC`
    );
  }

  // Таймаута здесь намеренно нет. GET можно оборвать без последствий, а POST,
  // который уже ушёл в Lighter, оборванный по таймеру оставляет состояние
  // «неизвестно»: клиент решит, что не вышло, повторит с новым client_order_index
  // и получит второй ордер. Пока запрос в полёте, кнопка заблокирована и
  // повторить его нельзя — это и есть защита от дубля.
  const res = await fetch(`${SIGNING_SERVICE_URL}/place-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      market_index: market.market_id,
      client_order_index: randomClientOrderIndex(),
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
  return json<{ tx_hash: string | null; dry_run: boolean }>(res);
}
