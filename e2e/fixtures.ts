// Ответы провайдеров и бэкенда для проверок рендера и списков.
//
// Каждое число здесь — замер живого ответа, а не предположение: проверка,
// построенная на выдуманном объёме, либо не ловит реальную просадку, либо
// краснеет без причины. Замеры снимались 2026-10-26:
//
//   curl https://mainnet.zklighter.elliot.ai/api/v1/orderBooks?filter=all  → 246 rows (52,7 KB? нет: 187 KB), 32 поля
//   curl https://mainnet.zklighter.elliot.ai/api/v1/funding-rates          → 733 rows, 52,7 KB
//   backend: len(MAJOR_PERPS)                                              → 18
//   src/lib/arcus.ts (замер 2026-10-24, подтверждён тем же curl-путём)     → 70 рынков
//
// Форма поля повторяет захваченный ответ слово в слово (включая числа
// СТРОКАМИ — lighter отдаёт fees/OI/min_base_amount строками, и Number()-коэрция
// на фронте это часть контракта), поэтому фикстура проверяет тот же код, что и
// прода, а не упрощённую версию.
import type { Page, Route } from "@playwright/test";

export const MEASURED = {
  /** GET /api/v1/orderBooks?filter=all — все строки книги, активные и нет. */
  orderBookRows: 246,
  /** Из них status=active: неактивные фронт показывает, но не в рельсе. */
  orderBookActive: 226,
  /** GET /api/v1/funding-rates — по одной строке на (рынок, площадка). */
  fundingRows: 733,
  /** MAJOR_PERPS в backend/lighter_rest.py — ранжируемый список /markets/overview. */
  overviewRows: 18,
  /** GET https://api.arcus.xyz/v1/markets. */
  arcusMarkets: 70,
  /** Terminal.tsx: getCandles(id, "1h", 48) — 48 свечей на график. */
  candles: 48,
  /** Terminal.tsx: getRecentTrades(marketId, N) — лента сделок. */
  trades: 20,
  /** backend/api/copy_trading.py: limit=Query(50, ge=1, le=200) — потолок журнала. */
  mirrorLogCeiling: 200,
  /** App.tsx: .slice(0, 200) в окне выбора рынка. */
  pickerCeiling: 200,
} as const;

// Тикеры, по которым App.tsx категоризирует рынок (categorizeMarket): crypto +
// акции + Forex + товары, чтобы проверка задела и ветку «Stocks», и «Crypto»
// по умолчанию.
const CRYPTO = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "AVAX", "LINK", "TON", "ARB", "OP"];
const STOCKS = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "META", "GOOG", "COIN"];
const FOREX = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"];
const COMMODITIES = ["XAUUSD", "XAGUSD", "WTI", "NG"];

// Худший случай данных (opt-in: { stress: true }). Числа и тикеры берутся с
// краёв диапазона: цена в семь знаков с шестью после точки, тикер в 24 символа,
// funding 42 % в час, оборот 9.99e14. Смысл не в том, что такие рынки бывают,
// а в том, что панель обязана уметь их показать: «правдоподобная» фикстура
// прячет переполнение колонки и расползание шага строк до первого реального
// выброса. Флаг модульный, а не аргумент: билдеры вызываются из page.route
// -колбэков, где под опцию пришлось бы переписать десять сигнатур, а
// installFixtures ставит его до регистрации маршрутов — страница в тесте одна,
// и следующий тест начинает с собственного значения.
let stress = false;

/** Тикер строки: в стресс-режиме длиннее, чем что умеет нарисовать интерфейс. */
function wideSymbol(i: number): string {
  const base = symbolAt(i);
  if (!stress) return base;
  return `${base}-USD-PERP-${2026 + (i % 4)}Q${(i % 4) + 1}`.slice(0, 24);
}

/** Символ строки книги по индексу — тот же генератор, что и у фикстур, чтобы
 * проверка могла назвать последнюю строку списка, а не «какую-то». */
export function symbolAt(i: number): string {
  const all = [...CRYPTO, ...STOCKS, ...FOREX, ...COMMODITIES];
  return i < all.length ? all[i] : `${all[i % all.length]}${Math.floor(i / all.length)}`;
}

/** Одна строка /orderBooks — все 32 поля живого ответа, в тех же типах. */
function orderBookRow(i: number) {
  const symbol = wideSymbol(i);
  const active = i < MEASURED.orderBookActive;
  const spot = i % 21 === 20;
  return {
    symbol,
    market_id: i + 1,
    market_type: spot ? "spot" : "perp",
    base_asset_id: i + 1,
    quote_asset_id: 0,
    status: active ? "active" : "inactive",
    taker_fee: "0.0000",
    is_taker_fee_enabled: true,
    maker_fee: "0.0000",
    is_maker_fee_enabled: true,
    liquidation_fee: "1.0000",
    min_base_amount: stress ? "1234567.891011" : "400",
    min_quote_amount: stress ? "99999999.000000" : "10.000000",
    order_quote_limit: "281474976.710655",
    supported_size_decimals: 0,
    supported_price_decimals: 6,
    supported_quote_decimals: 6,
    created_at: "1770885132385",
    multiplier: "1.000000000000000000",
    start_timestamp: 0,
    end_timestamp: 0,
    open_interest: stress ? "987654321.5526728" : "5.526728",
    open_interest_limit: "4401807821498",
    // У 16 из 226 активных рынков ключа нет — это замер, и фронт обязан его
    // отсутствие пережить (lib/lighter.ts: openInterestUsd).
    ...(i % 14 === 0 ? {} : { open_interest_usd: stress ? "999999999999.537360" : "90472.537360" }),
    outcome: 0,
    operator_account_index: 1,
    settlement_cap: 0,
    settlement_type: 0,
    settlement_price: 0,
    default_price: 0,
    is_frozen: false,
    market_deployer: "lighter",
  };
}

function fundingRows() {
  const venues = ["binance", "bybit", "hyperliquid"] as const;
  const rows: { market_id: number; exchange: string; symbol: string; rate: number }[] = [];
  for (let i = 0; i < MEASURED.orderBookActive; i++) {
    rows.push({ market_id: i + 1, exchange: "lighter", symbol: wideSymbol(i), rate: stress ? (i % 2 ? 0.42 : -0.37) : (i % 40) / 10000 });
  }
  // Остальное — референсные площадки: 733 = 226 lighter + 507 референсов.
  for (let i = 0; i < MEASURED.fundingRows - MEASURED.orderBookActive; i++) {
    rows.push({
      market_id: (i % MEASURED.orderBookActive) + 1,
      exchange: venues[i % 3],
      symbol: wideSymbol(i % 60),
      rate: stress ? (i % 2 ? 0.28 : -0.31) : ((i % 7) - 3) / 10000,
    });
  }
  return rows;
}

function candleRows(n: number) {
  const hour = 3_600_000;
  const end = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const c = stress ? 1_234_567.89 + Math.sin(i / 3) * 200_000 : 80_000 + Math.sin(i / 3) * 2_000;
    return {
      t: end - (n - i) * hour,
      o: c - 40,
      h: c + 120,
      l: c - 160,
      c,
      v: 120 + i,
      V: (120 + i) * c,
    };
  });
}

function tradeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    trade_id: `t${i}`,
    price: stress ? String(1_234_567.891011 + i) : String(80_000 + i),
    size: stress ? String(99_999.5 + i / 7) : String((i % 7) / 10),
    is_maker_ask: i % 2 === 0,
    timestamp: Math.floor(Date.now() / 1000) - i * 12,
  }));
}

function arcusMarketRow(i: number) {
  const symbol = wideSymbol(i);
  return {
    marketDisplayName: `${symbol}-USD`,
    marketId: i + 1,
    status: i % 17 === 0 ? "OFFLINE" : "ONLINE",
    baseAsset: symbol,
    quoteAsset: "USD",
    tickSize: "0.01",
    stepSize: "0.00001",
    type: i % 5 === 4 ? "SPOT" : "PERPETUAL",
    category: "CRYPTO",
    minOrderSize: "10",
    maxOrderSize: "100000",
  };
}

function overviewRows() {
  return Array.from({ length: MEASURED.overviewRows }, (_, i) => ({
    market_id: i + 1,
    symbol: wideSymbol(i),
    base: wideSymbol(i),
    price: stress ? (i % 2 ? 1_234_567.891011 : 0.0000012) : 80_000 / (i + 1),
    change_24h: stress ? (i % 2 ? 123.45 : -0.9999) : (i % 9) / 100 - 0.04,
    quote_volume_24h: stress ? 9.99e14 : 50_000_000 / (i + 1),
    open_interest_base: stress ? 98_765_432.123 : 1200 / (i + 1),
    min_base_amount: stress ? 1_234_567.891011 : 0.001,
    size_decimals: 3,
    taker_fee: 0.0004,
    maker_fee: 0.0002,
    funding_hourly: stress ? 0.42 : (i % 11) / 100000,
    funding_annualized: stress ? 0.42 * 24 * 365 : ((i % 11) / 100000) * 24 * 365,
    funding_payer: i % 3 === 0 ? "long" : "short",
  }));
}

function leaderRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `leader-${i}`,
    lighter_account_index: 10_000 + i,
    handle: stress ? `zeus-of-the-perp-vault-${i}` : `nike${i}`,
    fee_bps: 8 + (i % 20),
    created_at: Math.floor(Date.now() / 1000) - i * 86_400,
  }));
}

/** GET /leaders/hydrated — то же плюс подписчики и снимок счёта (backend/api/copy_trading.py). */
function hydratedLeaderRows(n: number, followsPerLeader: number) {
  return leaderRows(n).map((row, i) => ({
    ...row,
    follower_count: stress ? 9_999_999 : followsPerLeader,
    total_aum_usd: stress ? 9.99e11 : followsPerLeader * 3000,
    // Каждый третий лидер — счёт, по которому Lighter не ответил: карточка
    // обязана уметь показывать прочерк, а не нули.
    account:
      i % 3 === 2
        ? null
        : {
            equity_usd: stress ? 1_234_567_890.55 : 25_000 + i * 500,
            realized_pnl_usd: stress ? -999_999_999.5 : (i % 7) * 120 - 200,
            positions: Array.from({ length: 3 }, (_, k) => ({
              market_id: k + 1,
              symbol: wideSymbol(k),
              size: stress ? 98_765.4321 : 0.05 + k / 100,
              avg_entry: stress ? 1_234_567.89 : 79_000 - k * 500,
              value: stress ? 999_999_999 : 4_000 + k * 100,
              unrealized_pnl: 120 - k * 40,
              realized_pnl: 30 * k,
              liquidation_price: 60_000,
            })),
          },
  }));
}

function followRows(n: number, leaderId: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `follow-${i}`,
    follower_id: `0x${(i + 1).toString(16).padStart(40, "0")}`,
    leader_id: leaderId,
    leader_handle: `nike${i}`,
    allocation_usd: 500 + i * 250,
    max_leverage: 3,
    current_mirrored_size: i % 2,
    paused: false,
    created_at: Math.floor(Date.now() / 1000) - i * 3600,
  }));
}

function mirrorRows(n: number) {
  const statuses = ["sent", "dry_run", "skipped", "failed"] as const;
  return Array.from({ length: n }, (_, i) => ({
    id: `log-${i}`,
    follow_id: `follow-${i % 10}`,
    market_id: (i % 40) + 1,
    side: i % 2 ? "long" : "short",
    base_amount: stress ? 123_456.789012 : (i % 17) / 10,
    reduce_only: i % 5 === 0 ? 1 : 0,
    status: statuses[i % 4],
    reason: i % 4 === 3 ? (stress ? "equity_below_mirror_floor_after_fee_rounding" : "margin_unverified") : null,
    tx_hash: i % 4 === 0 ? `0x${"ab".repeat(32)}` : null,
    created_at: Math.floor(Date.now() / 1000) - i * 60,
    leader_handle: stress ? `zeus-of-the-perp-vault-${i % 10}` : `nike${i % 10}`,
  }));
}

function predictMarketRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    kind: i % 3 === 0 ? "event" : "price",
    question: stress
      ? `Will ${wideSymbol(i)} close above $${1_234_567_890.12} on ${new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)} 00:00 UTC, settled by the oracle and nothing else?`
      : `${symbolAt(i)} above ${10_000 + i * 1000} on ${new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10)}?`,
    lighter_market_id: (i % 40) + 1,
    threshold: 10_000 + i * 1000,
    comparator: ">=",
    resolve_at: Math.floor(Date.now() / 1000) + (i + 1) * 86_400,
    b: 100,
    status: "open",
    outcome: null,
    resolved_by: null,
    evidence_url: null,
    price_yes: 0.3 + (i % 40) / 100,
    price_no: 0.7 - (i % 40) / 100,
    max_subsidy: 50,
    volume_usd: i * 12.5,
    trade_count: i,
  }));
}

function predictPositionRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    market_id: `m-${i}`,
    question: `${symbolAt(i)} above ${10_000 + i * 1000}?`,
    kind: "price",
    market_status: i % 4 === 0 ? "resolved" : "open",
    market_outcome: i % 4 === 0 ? "yes" : null,
    resolve_at: Math.floor(Date.now() / 1000) + (i + 1) * 86_400,
    outcome: i % 2 ? "yes" : "no",
    shares: 10 + i,
    net_cost_usd: 4 + i * 0.5,
    avg_entry_usd: 0.42,
    mark_price: 0.51,
    mark_value_usd: 5 + i * 0.5,
    claimable_usd: i % 4 === 0 ? 10 + i : 0,
    claimed: false,
  }));
}

function agentMemory(openN: number, closedN: number) {
  const open = Array.from({ length: openN }, (_, i) => ({
    id: `o-${i}`,
    market_id: (i % 40) + 1,
    side: i % 2 ? "long" : "short",
    entry_price: 80_000 - i * 50,
    size: 0.01 + i / 1000,
  }));
  const closed = Array.from({ length: closedN }, (_, i) => ({
    id: `c-${i}`,
    market_id: (i % 40) + 1,
    side: i % 3 ? "long" : "short",
    entry_price: 79_000 - i * 40,
    size: 0.02 + i / 1000,
    exit_price: 80_200 - i * 30,
  }));
  return {
    summary: `${closedN} закрытых, ${openN} открытых`,
    open_trades: open,
    closed_trades: closed,
    win_rate: 0.55,
    volume_today_usd: 420,
  };
}

function lighterAccount(index: number) {
  return {
    accounts: [
      {
        index,
        total_asset_value: "25000.55",
        positions: Array.from({ length: 12 }, (_, i) => ({
          market_id: i + 1,
          symbol: symbolAt(i),
          position: i < 3 ? "0.05" : "0.0000",
          avg_entry_price: "79000",
          position_value: i < 3 ? "4000" : "0",
          unrealized_pnl: i < 3 ? "120" : "0",
          realized_pnl: (i % 5) * 30,
          liquidation_price: "60000",
        })),
      },
    ],
  };
}

export type FixtureOptions = {
  leaders?: number;
  followsPerLeader?: number;
  predictMarkets?: number;
  predictPositions?: number;
  mirrorLog?: number;
  agentOpen?: number;
  agentClosed?: number;
  /** Подписанные строки /follows для входа. */
  ownFollows?: number;
  /** Крайние значения во всех числовых полях — см. комментарий у `stress`. */
  stress?: boolean;
};

export const FULL_FIXTURE: Required<FixtureOptions> = {
  // 40 лидеров — это не «много на глаз», а потолок, который фронт обязан
  // пережить: у /leaders нет limit, и каждый лидер стоит Two requests
  // (статистика + аккаунт Lighter). Проверяется в render-budget.spec.ts.
  leaders: 40,
  followsPerLeader: 25,
  predictMarkets: 60,
  predictPositions: 30,
  mirrorLog: MEASURED.mirrorLogCeiling,
  agentOpen: 20,
  agentClosed: 160,
  ownFollows: 25,
  stress: false,
};

export type RequestLog = { byPath: () => Record<string, number>; total: () => number };

function jsonRoute(log: Map<string, number>, body: unknown, key: string) {
  return async (route: Route) => {
    log.set(key, (log.get(key) ?? 0) + 1);
    await route.fulfill({ json: body });
  };
}

/** Ставит перехват провайдеров и бэкенда и глушит всё остальное.
 *
 * Возвращает счётчик запросов по пути: «сколько запросов уходит на экран» —
 * это и предмет проверки, и единственный способ увидеть N+1 по лидерам. */
export async function installFixtures(page: Page, options: FixtureOptions = {}): Promise<RequestLog> {
  const opts = { ...FULL_FIXTURE, ...options };
  stress = Boolean(opts.stress);
  const log = new Map<string, number>();
  const count = (key: string) => {
    log.set(key, (log.get(key) ?? 0) + 1);
  };

  const LIGHTER = "https://mainnet.zklighter.elliot.ai/api/v1";
  const ARCUS = "https://api.arcus.xyz/v1";
  const BACKEND = "https://wake-backend-production-3483.up.railway.app";

  // Ловушка порядка, из-за которой первая же версия прогона меряла не то: Playwright
  // перебирает зарегистрированные маршруты в обратном порядке, поэтому общий
  // «запретить чужое» обязан стоять ПЕРВЫМ, а конкретные ответы — позже. Иначе
  // `**/*` перехватывает запрос раньше фикстуры, счётчик остаётся нулевым, и
  // панель замеряется в состоянии «данных нет», что выглядит как отличный результат.
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const known = [LIGHTER, ARCUS, BACKEND, "http://127.0.0.1", "http://localhost"].some((o) => url.startsWith(o));
    return known ? route.continue() : route.abort();
  });

  await page.route(`${LIGHTER}/orderBooks**`, async (route) => {
    count("lighter/orderBooks");
    await route.fulfill({ json: { order_books: Array.from({ length: MEASURED.orderBookRows }, (_, i) => orderBookRow(i)) } });
  });
  await page.route(`${LIGHTER}/funding-rates**`, async (route) => {
    count("lighter/funding-rates");
    await route.fulfill({ json: { funding_rates: fundingRows() } });
  });
  await page.route(`${LIGHTER}/candles**`, async (route) => {
    count("lighter/candles");
    const back = Number(new URL(route.request().url()).searchParams.get("count_back") ?? MEASURED.candles);
    await route.fulfill({ json: { c: candleRows(back + 2) } });
  });
  await page.route(`${LIGHTER}/recentTrades**`, async (route) => {
    count("lighter/recentTrades");
    await route.fulfill({ json: { trades: tradeRows(MEASURED.trades) } });
  });
  await page.route(`${LIGHTER}/account**`, async (route) => {
    count("lighter/account");
    const index = Number(new URL(route.request().url()).searchParams.get("value") ?? 0);
    await route.fulfill({ json: lighterAccount(index).accounts[0] ? lighterAccount(index) : { accounts: [] } });
  });

  await page.route(`${ARCUS}/markets**`, async (route) => {
    count("arcus/markets");
    await route.fulfill({ json: { markets: Array.from({ length: MEASURED.arcusMarkets }, (_, i) => arcusMarketRow(i)) } });
  });
  await page.route(`${ARCUS}/mids**`, async (route) => {
    count("arcus/mids");
    const mids: Record<string, string> = {};
    for (let i = 0; i < MEASURED.arcusMarkets; i++) mids[`${symbolAt(i)}-USD`] = String(80_000 - i * 100);
    await route.fulfill({ json: { mids, globalSequenceId: 1 } });
  });
  await page.route(`${ARCUS}/trades**`, async (route) => {
    count("arcus/trades");
    await route.fulfill({
      json: {
        trades: Array.from({ length: MEASURED.trades }, (_, i) => ({
          tradeId: `a${i}`,
          market: "BTC-USD",
          price: String(80_000 + i),
          size: String((i % 7) / 10),
          side: i % 2 ? "buy" : "sell",
          timestamp: Date.now() * 1000 - i * 1_000_000,
        })),
        total: MEASURED.trades,
      },
    });
  });

  const backend = (path: string, key: string, body: unknown) =>
    page.route(`${BACKEND}${path}`, jsonRoute(log, body, key));

  await Promise.all([
    backend("/markets/overview", "wake/markets-overview", {
      network: "mainnet",
      ranked_by: "quote_volume_24h",
      epoch_hours: 1,
      count: MEASURED.overviewRows,
      rows: overviewRows(),
      no_market: [],
      no_data: [],
    }),
    backend("/leaders", "wake/leaders", leaderRows(opts.leaders)),
    backend("/leaders/hydrated", "wake/leaders-hydrated", hydratedLeaderRows(opts.leaders, opts.followsPerLeader)),
    backend("/leaders/mine", "wake/leaders-mine", { leader: null }),
    // Витрина каждого лидера — агрегат (backend/api/copy_trading.py), и она
    // дёргается по разу на строку списка: без этого маршрута карточка лидера
    // рендерилась бы в ветке «статистика не пришла», а не в своей.
    backend("/follows/by-leader/**", "wake/leader-stats", {
      follower_count: opts.followsPerLeader,
      total_aum_usd: opts.followsPerLeader * 3000,
    }),
    backend("/leaders/**/followers", "wake/leader-followers", followRows(opts.followsPerLeader, "leader-0")),
    backend("/follows", "wake/follows", followRows(opts.ownFollows, "leader-0")),
    backend("/mirror-log**", "wake/mirror-log", mirrorRows(opts.mirrorLog)),
    backend("/predict/markets**", "wake/predict-markets", predictMarketRows(opts.predictMarkets)),
    backend("/predict/positions", "wake/predict-positions", predictPositionRows(opts.predictPositions)),
    backend("/agent/memory", "wake/agent-memory", agentMemory(opts.agentOpen, opts.agentClosed)),
    backend("/subscription", "wake/subscription", {
      tier: "pro",
      days_left_in_trial: null,
      has_ai_agent: true,
      has_copy_trading: true,
      has_predict_markets: true,
    }),
    backend("/funding-arb/check", "wake/funding-check", { opportunity: null, reason: "фикстура" }),
    backend("/funding-arb/size", "wake/funding-size", { legs: [], total_usd: 0 }),
    backend("/health", "wake/health", { status: "ok", network: "mainnet", dry_run: true }),
    backend("/ready", "wake/ready", { status: "ready", checks: { database: "ok", redis: "ok" } }),
  ]);

  return {
    byPath: () => Object.fromEntries(log),
    total: () => [...log.values()].reduce((a, b) => a + b, 0),
  };
}
