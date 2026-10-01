import { useState, useEffect, useMemo } from "react";
import { useAccount, useConnect, useDisconnect, useEnsName } from "wagmi";
import {
  TrendingUp,
  TrendingDown,
  Users,
  Copy as CopyIcon,
  X,
  Radio,
  ChevronRight,
  ChevronDown,
  Check,
  Zap,
  Pause,
  Play,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { getOrderBooks, getCandles, getRecentTrades, getAccountByL1Address, placeOrderViaSigningService, registerFollower, listFollowsForFollower, createFollow, setFollowPaused, registerLeader, getLeaderStats, type OrderBook, type Candle, type Trade } from "./lib/lighter";
import { BACKEND_URL } from "./lib/config";

type Trader = {
  id: string;
  handle: string;
  color: string;
  pnl30: number;
  winRate: number;
  followers: number;
  risk: string;
  markets: string;
  feeBps: number;
  trending?: boolean;
};

type Following = Trader & { allocation: number; paused: boolean; pnlPct: string; key: string };

const TRADERS: Trader[] = [
  { id: "t1", handle: "@northstar", color: "bg-cyan-500", pnl30: 38.4, winRate: 71, followers: 812, risk: "Med", markets: "BTC · ETH", feeBps: 8 },
  { id: "t2", handle: "@vega.eth", color: "bg-violet-500", pnl30: 21.9, winRate: 64, followers: 349, risk: "Low", markets: "ETH · SOL", feeBps: 6 },
  { id: "t3", handle: "@driftking", color: "bg-amber-500", pnl30: 64.2, winRate: 58, followers: 1204, risk: "High", markets: "BTC · alts", feeBps: 10, trending: true },
  { id: "t4", handle: "@cassian_fx", color: "bg-emerald-500", pnl30: 14.7, winRate: 69, followers: 203, risk: "Low", markets: "BTC", feeBps: 5 },
];

function fmt(n: number, d = 0) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

// Категоризация по символу — market_type в API различает только perp/spot, не
// тему актива. Списки собраны из реального ответа orderBooks (проверено
// живьём, см. README), не исчерпывающие — новые тикеры Lighter попадут в
// "Crypto" по умолчанию, что разумно для крипто-нативной биржи.
const FOREX_SYMBOLS = new Set(["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"]);
const COMMODITY_SYMBOLS = new Set(["XAU", "XAG", "WTI", "BRENT", "NATGAS", "GOLD", "SILVER"]);
const STOCK_SYMBOLS = new Set(["AAPL", "TSLA", "NVDA", "GOOGL", "META", "AMZN", "MSFT", "NFLX", "AMD", "COIN", "MSTR"]);

type MarketCategory = "Crypto" | "Stocks" | "Forex" | "Commodities" | "Spot";

function categorizeMarket(m: OrderBook): MarketCategory {
  if (m.market_type === "spot") return "Spot";
  if (FOREX_SYMBOLS.has(m.symbol)) return "Forex";
  if (COMMODITY_SYMBOLS.has(m.symbol)) return "Commodities";
  if (STOCK_SYMBOLS.has(m.symbol)) return "Stocks";
  return "Crypto";
}

function Ripple({ className = "border-cyan-400" }: { className?: string }) {
  return (
    <span className="absolute inset-0 pointer-events-none">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`absolute inset-0 rounded-full border-2 ${className}`}
          style={{ animation: "wakeRipple 2.4s ease-out infinite", animationDelay: `${i * 0.6}s` }}
        />
      ))}
    </span>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`bg-slate-800 rounded ${className}`} style={{ animation: "wakeShimmer 1.6s ease-in-out infinite" }} />;
}

function NavTab({ active, onClick, label, live }: { active: boolean; onClick: () => void; label: string; live: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${active ? "bg-slate-800 text-cyan-400" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
      {live ? (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Живые данные" />
      ) : (
        <span className="text-xs text-slate-600 border border-slate-700 rounded px-1">демо</span>
      )}
    </button>
  );
}

export default function App() {
  const { address, isConnected } = useAccount();
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [tab, setTab] = useState<"terminal" | "discover" | "portfolio" | "earn" | "predict" | "agent" | "risk" | "funding">("terminal");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [lighterAccount, setLighterAccount] = useState<any>(null);
  const [lighterChecked, setLighterChecked] = useState(false);

  const [asset, setAsset] = useState<string>("BTC");
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const [marketSearch, setMarketSearch] = useState("");
  const [marketCategory, setMarketCategory] = useState<MarketCategory | "Все">("Все");
  const [markets, setMarkets] = useState<OrderBook[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);
  const [isCopyable, setIsCopyable] = useState(false);
  const [following, setFollowing] = useState<Following[]>([]);
  const [copyModal, setCopyModal] = useState<Trader | null>(null);
  const [allocation, setAllocation] = useState(250);

  // Реальный бэкенд (backend/app.py) — регистрируем follower'а при коннекте, честно
  // молчим и остаёмся на демо-состоянии, если бэкенд не поднят локально.
  const [followerId, setFollowerId] = useState<string | null>(null);
  const [backendUp, setBackendUp] = useState(false);

  useEffect(() => {
    if (!address) {
      setFollowerId(null);
      setBackendUp(false);
      return;
    }
    registerFollower(address)
      .then((id) => {
        setFollowerId(id);
        setBackendUp(true);
        return listFollowsForFollower(id);
      })
      .then((rows) => {
        setFollowing(
          rows.map((r) => ({
            id: r.leader_id,
            handle: r.leader_handle,
            color: TRADERS.find((t) => t.id === r.leader_id)?.color ?? "bg-slate-500",
            pnl30: 0,
            winRate: 0,
            followers: 0,
            risk: "—",
            markets: "",
            feeBps: 0,
            allocation: r.allocation_usd,
            paused: !!r.paused,
            pnlPct: "0.0",
            key: r.id,
          }))
        );
      })
      .catch(() => setBackendUp(false)); // бэкенд не поднят — остаёмся на демо-состоянии, не падаем
  }, [address]);
  const [toast, setToast] = useState<string | null>(null);

  // Real check against Lighter's actual API — not simulated.
  useEffect(() => {
    if (!address) {
      setLighterAccount(null);
      setLighterChecked(false);
      return;
    }
    setLighterChecked(false);
    getAccountByL1Address(address)
      .then((data) => setLighterAccount(data))
      .catch(() => setLighterAccount(null))
      .finally(() => setLighterChecked(true));
  }, [address]);

  // Real market list from Lighter, polled (WebSocket is the natural next upgrade — see README).
  useEffect(() => {
    function load() {
      getOrderBooks("all").then(setMarkets).catch((e) => setDataError(String(e)));
    }
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const currentMarket = markets.find((m) => m.symbol === asset);

  useEffect(() => {
    if (currentMarket?.market_type === "spot" && side === "short") setSide("long");
  }, [currentMarket, side]);

  const filteredMarkets = useMemo(() => {
    const q = marketSearch.trim().toUpperCase();
    return markets
      .filter((m) => marketCategory === "Все" || categorizeMarket(m) === marketCategory)
      .filter((m) => !q || m.symbol.toUpperCase().includes(q))
      .slice(0, 200); // защита от рендера тысяч строк разом, если каталог вырастет
  }, [markets, marketSearch, marketCategory]);

  useEffect(() => {
    if (!currentMarket) return;
    function load() {
      getCandles(currentMarket!.market_id, "1h", 48)
        .then(setCandles)
        .catch((e) => setDataError(String(e)));
    }
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [currentMarket?.market_id]);

  const [trades, setTrades] = useState<Trade[]>([]);
  useEffect(() => {
    if (!currentMarket) return;
    function load() {
      getRecentTrades(currentMarket!.market_id, 16)
        .then(setTrades)
        .catch((e) => setDataError(String(e)));
    }
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [currentMarket?.market_id]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(id);
  }, [toast]);

  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const price = lastCandle?.c ?? null;
  const change = lastCandle && firstCandle ? ((lastCandle.c - firstCandle.o) / firstCandle.o) * 100 : null;
  const chartData = candles.map((c, i) => ({ i, v: c.c }));

  const liqPrice = useMemo(() => {
    if (price == null) return null;
    const dist = price * (1 / Math.max(leverage, 1)) * 0.9;
    return side === "long" ? price - dist : price + dist;
  }, [price, leverage, side]);

  async function placeOrder() {
    if (!currentMarket || price == null) {
      setToast("Рынок ещё не загружен");
      return;
    }
    setToast("Отправляю через локальный signing service…");
    try {
      const result = await placeOrderViaSigningService(currentMarket, side, size, price);
      setToast(`Ордер отправлен реально: ${result.tx_hash}`);
    } catch (e) {
      setToast(
        `Signing service недоступен (ожидаемо в песочнице/если не запущен локально): ${String(e).slice(0, 100)}. Запусти backend/signing_service.py — см. README.`
      );
    }
  }

  async function confirmCopy() {
    if (!copyModal) return;
    if (backendUp && followerId) {
      try {
        const followId = await createFollow(followerId, copyModal.id, allocation, 3);
        setFollowing((f) => [
          ...f,
          { ...copyModal, allocation, paused: false, pnlPct: "0.0", key: followId },
        ]);
        setToast(`Ты оседлал волну ${copyModal.handle} — записано в реальную базу`);
      } catch (e) {
        setToast(`Бэкенд отклонил: ${String(e).slice(0, 100)}. Прогнан ли backend/seed_demo_leaders.py?`);
        setCopyModal(null);
        return;
      }
    } else {
      setFollowing((f) => [
        ...f,
        { ...copyModal, allocation, paused: false, pnlPct: (Math.random() * 20 - 4).toFixed(1), key: copyModal.id + Date.now() },
      ]);
      setToast(`Ты оседлал волну ${copyModal.handle} (демо — локальный бэкенд не отвечает)`);
    }
    setCopyModal(null);
    setAllocation(250);
  }

  function togglePause(key: string) {
    setFollowing((f) => f.map((t) => (t.key === key ? { ...t, paused: !t.paused } : t)));
    if (backendUp) {
      const target = following.find((t) => t.key === key);
      if (target) setFollowPaused(key, !target.paused).catch(() => {});
    }
  }

  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [leaderStats, setLeaderStats] = useState<{ follower_count: number; total_aum_usd: number } | null>(null);

  async function toggleCopyable() {
    const next = !isCopyable;
    setIsCopyable(next);
    if (!next || !backendUp || lighterAccount?.accounts?.[0]?.index == null) return;
    try {
      const id = await registerLeader(lighterAccount.accounts[0].index, ensName ?? `${address?.slice(0, 6)}...${address?.slice(-4)}`, 8);
      setLeaderId(id);
      setToast("Записан как Wake в реальную базу");
    } catch (e) {
      setToast(`Не удалось зарегистрироваться лидером: ${String(e).slice(0, 100)}`);
    }
  }

  useEffect(() => {
    if (!leaderId || !isCopyable) return;
    function load() {
      getLeaderStats(leaderId!).then(setLeaderStats).catch(() => {});
    }
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [leaderId, isCopyable]);

  const totalFollowers = leaderStats?.follower_count ?? 340;
  const totalAum = leaderStats?.total_aum_usd ?? 186400;
  const isRealStats = leaderStats != null;
  const monthlyEarnings = 2140; // реальный расчёт требует истории исполненных сделок — этого источника пока нет

  // --- Модуль предсказаний: реальные вызовы backend/app.py, честный откат в пустой список ---
  const [predictMarkets, setPredictMarkets] = useState<any[]>([]);
  const [predictBackendUp, setPredictBackendUp] = useState(false);
  const [predictTrade, setPredictTrade] = useState<{ market: any; outcome: "yes" | "no" } | null>(null);
  const [predictShares, setPredictShares] = useState(10);
  const [predictPreviewCost, setPredictPreviewCost] = useState<number | null>(null);

  useEffect(() => {
    if (tab !== "predict") return;
    fetch("${BACKEND_URL}/predict/markets")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => {
        setPredictMarkets(data);
        setPredictBackendUp(true);
      })
      .catch(() => setPredictBackendUp(false));
  }, [tab]);

  function openPredictTrade(market: any, outcome: "yes" | "no") {
    setPredictTrade({ market, outcome });
    setPredictShares(10);
    setPredictPreviewCost(null);
  }

  useEffect(() => {
    if (!predictTrade) return;
    fetch(`${BACKEND_URL}/predict/markets/${predictTrade.market.id}/preview?outcome=${predictTrade.outcome}&shares=${predictShares}`)
      .then((r) => r.json())
      .then((data) => setPredictPreviewCost(data.cost_usd))
      .catch(() => setPredictPreviewCost(null));
  }, [predictTrade, predictShares]);

  async function confirmPredictTrade() {
    if (!predictTrade) return;
    if (!followerId) {
      setToast("Подключи кошелёк сначала");
      return;
    }
    try {
      const res = await fetch(`${BACKEND_URL}/predict/markets/${predictTrade.market.id}/trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: followerId, outcome: predictTrade.outcome, shares: predictShares }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setToast(`Куплено ${predictShares} ${predictTrade.outcome.toUpperCase()}: $${data.cost_usd.toFixed(2)}`);
      setPredictTrade(null);
    } catch (e) {
      setToast(`Ошибка сделки: ${String(e).slice(0, 100)}`);
    }
  }

  // --- Подписка гейтит AI-агента, тот же принцип честного отката в демо-состояние ---
  const [subscription, setSubscription] = useState<{ tier: string; has_ai_agent: boolean; days_left_in_trial?: number } | null>(null);

  useEffect(() => {
    if (!followerId) return;
    fetch(`${BACKEND_URL}/subscription/${followerId}`)
      .then((r) => r.json())
      .then(setSubscription)
      .catch(() => setSubscription(null));
  }, [followerId]);

  async function startTrial() {
    if (!followerId) {
      setToast("Подключи кошелёк сначала");
      return;
    }
    try {
      await fetch(`${BACKEND_URL}/subscription/${followerId}/start-trial`, { method: "POST" });
      const r = await fetch(`${BACKEND_URL}/subscription/${followerId}`);
      setSubscription(await r.json());
      setToast("Пробный период начат — 14 дней");
    } catch (e) {
      setToast(`Бэкенд не отвечает: ${String(e).slice(0, 100)}`);
    }
  }

  // --- AI-агент: память + решение через уже протестированные agent_memory/agent_runner ---
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentLastDecision, setAgentLastDecision] = useState<any>(null);
  const [agentMemoryView, setAgentMemoryView] = useState<any>(null);

  useEffect(() => {
    if (tab !== "agent" || !followerId) return;
    fetch(`${BACKEND_URL}/agent/memory/${followerId}`)
      .then((r) => r.json())
      .then(setAgentMemoryView)
      .catch(() => setAgentMemoryView(null));
  }, [tab, followerId, agentLastDecision]);

  async function runAgentStep() {
    if (!followerId || !currentMarket || price == null) {
      setToast("Нужен кошелёк и загруженный рынок");
      return;
    }
    setAgentBusy(true);
    try {
      const res = await fetch("${BACKEND_URL}/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: followerId,
          market_id: currentMarket.market_id,
          recent_prices: chartData.slice(-10).map((c) => c.v),
          size_decimals: currentMarket.supported_size_decimals,
          price_decimals: currentMarket.supported_price_decimals,
          base_size_usd: 100,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setAgentLastDecision(data);
      setToast(`Агент: ${data.action} (${(data.confidence * 100).toFixed(0)}% увер.)`);
    } catch (e) {
      setToast(`Агент недоступен: ${String(e).slice(0, 100)}`);
    } finally {
      setAgentBusy(false);
    }
  }

  // --- Portfolio Risk: позиции вводятся вручную (реального трекера позиций Lighter
  // ещё нет), но цены под ними — настоящие свечи с Lighter, не выдуманные ---
  type RiskPosition = { marketId: number; symbol: string; notionalUsd: number; side: "long" | "short" };
  const [riskPositions, setRiskPositions] = useState<RiskPosition[]>([]);
  const [riskPickerOpen, setRiskPickerOpen] = useState(false);
  const [riskResult, setRiskResult] = useState<any>(null);
  const [hedgeResult, setHedgeResult] = useState<any>(null);
  const [riskBusy, setRiskBusy] = useState(false);

  function addRiskPosition(m: OrderBook, side: "long" | "short") {
    setRiskPositions((p) => [...p, { marketId: m.market_id, symbol: m.symbol, notionalUsd: 1000, side }]);
    setRiskPickerOpen(false);
  }

  function removeRiskPosition(i: number) {
    setRiskPositions((p) => p.filter((_, idx) => idx !== i));
    setRiskResult(null);
  }

  async function analyzePortfolioRisk() {
    if (riskPositions.length < 1) {
      setToast("Добавь хотя бы одну позицию");
      return;
    }
    setRiskBusy(true);
    setHedgeResult(null);
    try {
      // Реальные свечи с Lighter под каждую позицию — не смоделированные ряды.
      const returnsByMarket: Record<string, number[]> = {};
      for (const pos of riskPositions) {
        const candles = await getCandles(pos.marketId, "1h", 30);
        const closes = candles.map((c) => c.c);
        const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
        returnsByMarket[String(pos.marketId)] = returns;
      }

      const res = await fetch("${BACKEND_URL}/portfolio/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: riskPositions.map((p) => ({
            market_id: p.marketId,
            symbol: p.symbol,
            signed_notional_usd: p.side === "long" ? p.notionalUsd : -p.notionalUsd,
          })),
          returns_by_market: returnsByMarket,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setRiskResult(await res.json());
    } catch (e) {
      setToast(`Анализ риска недоступен: ${String(e).slice(0, 100)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  async function findHedge() {
    if (riskPositions.length === 0) return;
    const target = riskPositions[0];
    setRiskBusy(true);
    try {
      const returnsByMarket: Record<string, number[]> = {};
      const candidates: [number, string][] = [];
      for (const m of markets.slice(0, 15)) {
        const candles = await getCandles(m.market_id, "1h", 30);
        const closes = candles.map((c) => c.c);
        returnsByMarket[String(m.market_id)] = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
        if (m.market_id !== target.marketId) candidates.push([m.market_id, m.symbol]);
      }
      const res = await fetch("${BACKEND_URL}/portfolio/hedge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: { market_id: target.marketId, symbol: target.symbol, signed_notional_usd: target.side === "long" ? target.notionalUsd : -target.notionalUsd },
          candidates,
          returns_by_market: returnsByMarket,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHedgeResult(await res.json());
    } catch (e) {
      setToast(`Поиск хеджа недоступен: ${String(e).slice(0, 100)}`);
    } finally {
      setRiskBusy(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-950 font-sans">
      <style>{`
        @keyframes wakeRipple {
          0% { transform: scale(0.6); opacity: 0.7; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        @keyframes wakeShimmer {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.85; }
        }
        @keyframes wakeFadeIn {
          0% { opacity: 0; transform: translateY(-3px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="max-w-6xl mx-auto px-6 py-5">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-cyan-500 flex items-center justify-center">
                <Zap className="w-4 h-4 text-slate-950" strokeWidth={2.5} />
              </div>
              <span className="text-white font-semibold tracking-tight text-lg">Wake</span>
              <span className="text-xs text-slate-500 font-mono uppercase tracking-wide ml-1 hidden sm:inline">Lighter · mainnet</span>
            </div>

            <div className="relative">
              {isConnected && address ? (
                <button
                onClick={() => setWalletMenuOpen((v) => !v)}
                className="flex items-center gap-2 bg-slate-900 border border-slate-700 hover:border-slate-600 rounded-full pl-1.5 pr-3 py-1.5 text-sm text-slate-200 font-mono transition-colors"
              >
                <span className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-slate-950 text-xs font-bold">
                  {address.slice(2, 3).toUpperCase()}
                </span>
                {ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}`}
                <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              </button>
            ) : (
              <button
                onClick={() => setConnectPickerOpen(true)}
                className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold px-4 py-2 rounded-full transition-colors"
              >
                Connect Wallet
              </button>
            )}

            {isConnected && walletMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setWalletMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-64 bg-slate-900 border border-slate-700 rounded-xl p-3 z-50 shadow-xl">
                  {ensName && <div className="text-sm text-cyan-400 font-medium mb-1">{ensName}</div>}
                  <div className="text-xs text-slate-500 mb-1">Ethereum-адрес</div>
                  <div className="text-sm text-slate-200 font-mono mb-3 break-all">{address}</div>
                  <div className="text-xs text-slate-400 mb-3">
                    {!lighterChecked
                      ? "Проверяю аккаунт на Lighter…"
                      : lighterAccount?.accounts?.[0]?.index != null
                      ? `Lighter account index: ${lighterAccount.accounts[0].index}`
                      : "Аккаунт на Lighter не найден — зарегистрируйся на app.lighter.xyz"}
                  </div>
                  <button
                    onClick={() => {
                      disconnect();
                      setWalletMenuOpen(false);
                    }}
                    className="w-full text-center text-sm text-red-400 hover:text-red-300 border border-red-900 rounded-lg py-1.5 transition-colors"
                  >
                    Отключить
                  </button>
                </div>
              </>
            )}

            {connectPickerOpen && (
              <div
                className="fixed inset-0 flex items-center justify-center z-50 p-4"
                style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
                onClick={() => setConnectPickerOpen(false)}
              >
                <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-white font-semibold text-sm">Подключить кошелёк</h3>
                    <button onClick={() => setConnectPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="space-y-2">
                    {connectors.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          connect({ connector: c });
                          setConnectPickerOpen(false);
                        }}
                        disabled={isPending}
                        className="w-full flex items-center justify-between bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl px-4 py-3 transition-colors"
                      >
                        <span className="text-slate-200 text-sm font-medium">{c.name}</span>
                        <ChevronRight className="w-4 h-4 text-slate-600" />
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-slate-600 mt-4 text-center">Настоящее подключение через wagmi — не демо.</p>
                </div>
              </div>
            )}
          </div>
          </div>

          <div className="relative -mx-6 px-6 sm:mx-0 sm:px-0">
            <nav className="flex items-center gap-1 overflow-x-auto pb-0.5">
              <NavTab active={tab === "terminal"} onClick={() => setTab("terminal")} label="Терминал" live />
              <NavTab active={tab === "discover"} onClick={() => setTab("discover")} label="Discover" live={false} />
              <NavTab active={tab === "portfolio"} onClick={() => setTab("portfolio")} label="Портфель" live={false} />
              <NavTab active={tab === "earn"} onClick={() => setTab("earn")} label="Earn" live={false} />
              <NavTab active={tab === "predict"} onClick={() => setTab("predict")} label="Predict" live={false} />
              <NavTab active={tab === "agent"} onClick={() => setTab("agent")} label="AI Agent" live={false} />
              <NavTab active={tab === "risk"} onClick={() => setTab("risk")} label="Risk" live={false} />
              <NavTab active={tab === "funding"} onClick={() => setTab("funding")} label="Funding" live={false} />
            </nav>
          </div>
        </div>

        {tab === "terminal" && (
          <div className="space-y-4">
            {dataError && (
              <div className="flex items-start gap-3 bg-slate-900 border border-amber-800 rounded-2xl p-4">
                <div className="w-7 h-7 rounded-lg bg-slate-800 border border-amber-700 flex items-center justify-center shrink-0 text-amber-400 text-sm font-bold">
                  !
                </div>
                <div>
                  <div className="text-sm text-amber-300 font-medium">Сеть недоступна из этой песочницы</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Живые данные заработают при запуске локально: <code className="text-slate-400">npm run dev</code>. Ошибка: {dataError}
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={() => setMarketPickerOpen(true)}
                    className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 rounded-full pl-3 pr-2 py-1 text-xs font-medium text-slate-100 transition-colors"
                  >
                    {currentMarket ? `${currentMarket.symbol}${currentMarket.market_type === "perp" ? "-PERP" : "/USDC"}` : asset}
                    <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                    {markets.length > 0 && <span className="text-slate-600">· {markets.length} рынков</span>}
                  </button>
                  {change != null && (
                    <span className={`text-xs font-mono flex items-center gap-0.5 ${change >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {change >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                      {change >= 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </span>
                  )}
                </div>
                {price != null ? (
                  <div className="text-3xl font-mono font-semibold text-white mb-2">${fmt(price, currentMarket?.supported_price_decimals ?? 2)}</div>
                ) : (
                  <Skeleton className="h-9 w-40 mb-2" />
                )}
                <div className="h-48">
                  {chartData.length > 1 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <defs>
                          <linearGradient id="wakeGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <Area type="monotone" dataKey="v" stroke={(change ?? 0) >= 0 ? "#2dd4bf" : "#f87171"} strokeWidth={2} fill="url(#wakeGrad)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <Skeleton className="h-full w-full" />
                  )}
                </div>
                <div className="text-xs text-slate-600 mt-1">GET /api/v1/candles — 1h, реальный ответ Lighter</div>
              </div>

              <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-slate-500 uppercase tracking-wide">Лента сделок</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${trades.length ? "bg-emerald-400" : "bg-slate-700"}`} />
                </div>
                {trades.length === 0 ? (
                  <div className="space-y-2">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <Skeleton key={i} className="h-3 w-full" />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-1 max-h-56 overflow-hidden">
                    {trades.slice(0, 14).map((t, i) => (
                      <div
                        key={t.id}
                        className="flex justify-between text-xs font-mono"
                        style={i === 0 ? { animation: "wakeFadeIn 0.4s ease-out" } : undefined}
                      >
                        <span className={t.isAsk ? "text-red-400" : "text-emerald-400"}>{fmt(t.price, currentMarket?.supported_price_decimals ?? 2)}</span>
                        <span className="text-slate-500">{t.size}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="text-xs text-slate-600 mt-2">GET /api/v1/recentTrades — обновляется каждые 4с</div>
              </div>

              <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                {currentMarket?.market_type === "spot" ? (
                  <div className="flex bg-slate-800 rounded-xl p-1">
                    <button
                      onClick={() => setSide("long")}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "long" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}
                    >
                      Buy
                    </button>
                    <button
                      onClick={() => setSide("short")}
                      disabled
                      title="Спот — только покупка/продажа того, что уже держишь, шорта нет"
                      className="flex-1 py-2 rounded-lg text-sm font-medium text-slate-700 cursor-not-allowed"
                    >
                      Sell
                    </button>
                  </div>
                ) : (
                  <div className="flex bg-slate-800 rounded-xl p-1">
                    <button
                      onClick={() => setSide("long")}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "long" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}
                    >
                      Long
                    </button>
                    <button
                      onClick={() => setSide("short")}
                      className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${side === "short" ? "bg-red-500 text-slate-950" : "text-slate-400"}`}
                    >
                      Short
                    </button>
                  </div>
                )}

                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Размер позиции</label>
                  <div className="flex items-center bg-slate-800 border border-slate-700 rounded-xl px-3 py-2">
                    <span className="text-slate-500 mr-1">$</span>
                    <input
                      type="number"
                      value={size}
                      onChange={(e) => setSize(Number(e.target.value))}
                      className="bg-transparent text-white font-mono outline-none w-full"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs text-slate-400 mb-1">
                    <span>Плечо</span>
                    <span className="font-mono text-slate-200">{leverage}x</span>
                  </div>
                  <input type="range" min="1" max="20" value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="w-full accent-cyan-500" />
                </div>

                <div className="flex justify-between text-xs text-slate-500 font-mono">
                  <span>Ликв. ≈ {liqPrice != null ? `$${fmt(liqPrice, 0)}` : "—"}</span>
                  <span>Маржа ${fmt(size / leverage, 0)}</span>
                </div>

                <button
                  onClick={placeOrder}
                  className={`w-full py-2.5 rounded-xl font-semibold transition-colors ${side === "long" ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950" : "bg-red-500 hover:bg-red-400 text-slate-950"}`}
                >
                  {side === "long" ? "Открыть Long" : "Открыть Short"}
                </button>
                <p className="text-xs text-slate-600">Исполнение ордера пока не подключено — см. backend/place_order_example.py</p>

                <div className="border-t border-slate-800 pt-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="relative w-4 h-4 shrink-0">
                        {isCopyable && <Ripple />}
                        <Radio className={`relative z-10 w-4 h-4 ${isCopyable ? "text-cyan-400" : "text-slate-500"}`} />
                      </div>
                      <span className="text-xs text-slate-300 font-medium">Копируемые сделки (preview)</span>
                    </div>
                    <button
                      onClick={toggleCopyable}
                      className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${isCopyable ? "bg-cyan-500" : "bg-slate-700"}`}
                    >
                      <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isCopyable ? "translate-x-5" : "translate-x-0.5"}`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === "discover" && (
          <div>
            <div className="mb-4">
              <h2 className="text-white font-semibold flex items-center gap-2">
                Топ Wakes сейчас <span className="text-xs text-slate-600 border border-slate-700 rounded px-1.5 py-0.5 font-normal">демо-данные</span>
              </h2>
              <p className="text-slate-500 text-sm">Preview UX — ждёт бэкенд копи-движка (см. README)</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {TRADERS.map((t) => (
                <div key={t.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="relative w-10 h-10 shrink-0">
                        {t.trending && <Ripple />}
                        <div className={`relative z-10 w-10 h-10 rounded-full ${t.color} flex items-center justify-center text-sm font-bold text-slate-950`}>
                          {t.handle[1].toUpperCase()}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-100 text-sm font-medium flex items-center gap-1.5">
                          {t.handle}
                          {t.trending && <span className="text-cyan-400 text-xs font-normal">· в тренде</span>}
                        </div>
                        <div className="text-slate-500 text-xs">{t.markets}</div>
                      </div>
                    </div>
                    <span className="text-xs text-slate-500 border border-slate-700 rounded-full px-2 py-0.5 shrink-0">риск {t.risk}</span>
                  </div>
                  <div className="flex justify-between text-xs font-mono mb-3">
                    <span className="text-emerald-400">+{t.pnl30}% / 30д</span>
                    <span className="text-slate-400">{t.winRate}% winrate</span>
                    <span className="text-slate-400 flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      {fmt(t.followers)}
                    </span>
                  </div>
                  <button
                    onClick={() => setCopyModal(t)}
                    className="w-full flex items-center justify-center gap-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                  >
                    <CopyIcon className="w-3.5 h-3.5" /> Copy
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "portfolio" &&
          (following.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl py-20 flex flex-col items-center text-center">
              <p className="text-slate-400 text-sm mb-4">Ты пока никого не копируешь</p>
              <button onClick={() => setTab("discover")} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
                Найти трейдера <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                    <th className="pb-2 font-normal">Трейдер</th>
                    <th className="pb-2 font-normal">Аллокация</th>
                    <th className="pb-2 font-normal">PnL</th>
                    <th className="pb-2 font-normal">Статус</th>
                    <th className="pb-2 font-normal"></th>
                  </tr>
                </thead>
                <tbody>
                  {following.map((t) => (
                    <tr key={t.key} className="border-b border-slate-800 last:border-0">
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <div className={`w-7 h-7 rounded-full ${t.color} flex items-center justify-center text-xs font-bold text-slate-950`}>
                            {t.handle[1].toUpperCase()}
                          </div>
                          <span className="text-slate-200 font-medium">{t.handle}</span>
                        </div>
                      </td>
                      <td className="py-3 font-mono text-slate-300">${fmt(t.allocation)}</td>
                      <td className={`py-3 font-mono ${Number(t.pnlPct) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {Number(t.pnlPct) >= 0 ? "+" : ""}
                        {t.pnlPct}%
                      </td>
                      <td className="py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${t.paused ? "bg-slate-800 text-slate-500" : "bg-slate-800 text-cyan-400"}`}>
                          {t.paused ? "На паузе" : "Активно"}
                        </span>
                      </td>
                      <td className="py-3 text-right">
                        <button onClick={() => togglePause(t.key)} className="text-slate-400 hover:text-slate-200">
                          {t.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === "earn" &&
          (!isCopyable ? (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl py-20 flex flex-col items-center text-center">
              <Radio className="w-8 h-8 text-slate-700 mb-3" />
              <p className="text-slate-400 text-sm mb-1">Заработок пока выключен</p>
              <p className="text-slate-600 text-xs mb-4">Включи «копируемые сделки» в Терминале</p>
              <button onClick={() => setTab("terminal")} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
                Перейти в Терминал <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-slate-900 border border-amber-700 rounded-2xl p-4">
                  <div className="text-amber-400 text-xs uppercase tracking-wide mb-1">Этот месяц</div>
                  <div className="text-2xl font-mono font-bold text-white">${fmt(monthlyEarnings)}</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                  <div className="text-slate-500 text-xs uppercase tracking-wide mb-1 flex items-center gap-1.5">
                    Подписчики
                    <span className={`w-1.5 h-1.5 rounded-full ${isRealStats ? "bg-emerald-400" : "bg-slate-700"}`} title={isRealStats ? "реальные данные из базы" : "демо"} />
                  </div>
                  <div className="text-2xl font-mono font-bold text-white">{fmt(totalFollowers)}</div>
                </div>
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                  <div className="text-slate-500 text-xs uppercase tracking-wide mb-1">AUM в копиях</div>
                  <div className="text-2xl font-mono font-bold text-white">${fmt(totalAum / 1000, 0)}k</div>
                </div>
              </div>
              <p className="text-xs text-slate-600">
                {isRealStats
                  ? "Подписчики и AUM — реальные строки из базы (backend/app.py). Заработок — ещё нет, для него нужна история исполненных зеркальных сделок."
                  : "Демо-цифры — backend не отвечает, либо seed_demo_leaders.py ещё не прогнан."}
              </p>
            </div>
          ))}

        {tab === "predict" && (
          <div>
            <div className="mb-4">
              <h2 className="text-white font-semibold flex items-center gap-2">
                Predict
                <span className={`w-1.5 h-1.5 rounded-full ${predictBackendUp ? "bg-emerald-400" : "bg-slate-700"}`} title={predictBackendUp ? "реальный бэкенд" : "бэкенд не отвечает"} />
              </h2>
              <p className="text-slate-500 text-sm">Бинарные рынки: цены на Lighter резолвятся автоматически, события — вручную куратором</p>
            </div>
            {predictMarkets.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl py-16 flex flex-col items-center text-center">
                <p className="text-slate-400 text-sm mb-1">Рынков нет или бэкенд не отвечает</p>
                <p className="text-slate-600 text-xs">Создать: POST /predict/markets/price или /predict/markets/event</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {predictMarkets.map((m) => (
                  <div key={m.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-slate-500 uppercase tracking-wide">{m.kind === "price" ? "Цена на Lighter" : "Событие"}</span>
                      <span className="text-xs text-slate-600">до {new Date(m.resolve_at * 1000).toLocaleDateString("ru-RU")}</span>
                    </div>
                    <div className="text-slate-100 text-sm font-medium mb-3">{m.question}</div>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="flex-1 h-2 bg-red-950 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500" style={{ width: `${(m.price_yes * 100).toFixed(0)}%` }} />
                      </div>
                      <span className="text-xs font-mono text-slate-400 w-16 text-right">{(m.price_yes * 100).toFixed(0)}% YES</span>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => openPredictTrade(m, "yes")}
                        className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                      >
                        YES {(m.price_yes * 100).toFixed(0)}¢
                      </button>
                      <button
                        onClick={() => openPredictTrade(m, "no")}
                        className="flex-1 bg-red-500 hover:bg-red-400 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                      >
                        NO {(m.price_no * 100).toFixed(0)}¢
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "agent" && (
          <div>
            <div className="mb-4">
              <h2 className="text-white font-semibold">AI Agent</h2>
              <p className="text-slate-500 text-sm">Momentum-эвристика с памятью, LLM-рассуждение поверх неё с проверенным откатом</p>
            </div>

            {!subscription?.has_ai_agent ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl py-16 flex flex-col items-center text-center">
                <Zap className="w-8 h-8 text-slate-700 mb-3" />
                <p className="text-slate-400 text-sm mb-1">
                  {subscription?.tier === "free" ? "Пробный период закончился" : "AI-агент доступен на trial или Pro"}
                </p>
                <button onClick={startTrial} className="mt-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold px-4 py-2 rounded-full transition-colors">
                  Начать 14-дневный trial
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {subscription.days_left_in_trial != null && (
                  <div className="text-xs text-amber-400">Trial: {subscription.days_left_in_trial.toFixed(1)} дней осталось</div>
                )}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-slate-500 uppercase tracking-wide">
                      {asset}-PERP, momentum за последние {chartData.slice(-10).length} точек
                    </span>
                    <button
                      onClick={runAgentStep}
                      disabled={agentBusy}
                      className="bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors"
                    >
                      {agentBusy ? "Считаю…" : "Спросить агента"}
                    </button>
                  </div>
                  {agentLastDecision ? (
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`text-lg font-mono font-bold ${
                            agentLastDecision.action === "long" ? "text-emerald-400" : agentLastDecision.action === "short" ? "text-red-400" : "text-slate-400"
                          }`}
                        >
                          {agentLastDecision.action.toUpperCase()}
                        </span>
                        <span className="text-xs text-slate-500 font-mono">{(agentLastDecision.confidence * 100).toFixed(0)}% уверенность</span>
                        {agentLastDecision.size_usd > 0 && <span className="text-xs text-slate-500 font-mono">${agentLastDecision.size_usd.toFixed(0)}</span>}
                      </div>
                      <p className="text-xs text-slate-500">{agentLastDecision.reasoning}</p>
                    </div>
                  ) : (
                    <p className="text-slate-600 text-sm">Ещё не спрашивали агента в этой сессии</p>
                  )}
                </div>

                {agentMemoryView && (
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                    <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">Память агента</div>
                    <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono">{agentMemoryView.summary}</pre>
                  </div>
                )}
                <p className="text-xs text-slate-600">
                  Требует backend/app.py и signing_service.py локально — в этой песочнице бэкенд не отвечает.
                </p>
              </div>
            )}
          </div>
        )}

        {tab === "funding" && (
          <div>
            <div className="mb-4">
              <h2 className="text-white font-semibold">Funding Arbitrage</h2>
              <p className="text-slate-500 text-sm">
                Cash-and-carry: шорт перпа + лонг спота одного актива. Дельта-нейтрально, доходность от funding rate.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-slate-500 uppercase tracking-wide">Проверить рынок</span>
                <span className="text-xs text-slate-600">POST /funding-arb/check</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Рынок</label>
                  <select className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm outline-none w-full">
                    <option value="">Выбери рынок…</option>
                    {markets.filter((m) => m.market_type === "perp").map((m) => (
                      <option key={m.market_id} value={m.market_id}>{m.symbol}-PERP</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Funding rate (например, 0.0001 = 0.01%/час)</label>
                  <input
                    type="number"
                    step="0.00001"
                    placeholder="0.0001"
                    className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white font-mono text-sm outline-none w-full"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button className="flex-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors">
                  Проверить возможность
                </button>
                <button className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold py-2 rounded-xl transition-colors">
                  Рассчитать размер
                </button>
              </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Как это работает</div>
              <div className="space-y-2 text-sm text-slate-400">
                <p>• <span className="text-slate-200">Positive funding</span> — лонги платят шортам. Шортишь перп, покупаешь спот — дельта-нейтрально.</p>
                <p>• <span className="text-slate-200">Доходность</span> — funding rate × 24 × 365 (эпох у Lighter — 1 час, не 8).</p>
                <p>• <span className="text-slate-200">Порог по умолчанию</span> — 5% годовых. Ниже — операционная сложность не стоит свеч.</p>
                <p>• <span className="text-slate-200">Negative funding</span> — не поддержано (нужен займ актива для шорта спота).</p>
              </div>
            </div>
          </div>
        )}

        {tab === "risk" && (
          <div>
            <div className="mb-4">
              <h2 className="text-white font-semibold">Portfolio Risk</h2>
              <p className="text-slate-500 text-sm">
                Единая маржа Lighter через крипту, акции и форекс — риск считается по всему портфелю разом, не по одной позиции
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-slate-500 uppercase tracking-wide">Позиции для анализа</span>
                <button
                  onClick={() => setRiskPickerOpen(true)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
                >
                  + Добавить
                </button>
              </div>
              {riskPositions.length === 0 ? (
                <p className="text-slate-600 text-sm py-4 text-center">Добавь пару позиций с разных рынков, чтобы увидеть эффект диверсификации</p>
              ) : (
                <div className="space-y-2">
                  {riskPositions.map((p, i) => (
                    <div key={i} className="flex items-center justify-between bg-slate-800 rounded-xl px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-mono ${p.side === "long" ? "text-emerald-400" : "text-red-400"}`}>{p.side === "long" ? "LONG" : "SHORT"}</span>
                        <span className="text-slate-200 text-sm font-medium">{p.symbol}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          value={p.notionalUsd}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setRiskPositions((arr) => arr.map((x, idx) => (idx === i ? { ...x, notionalUsd: v } : x)));
                          }}
                          className="w-20 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white font-mono text-xs outline-none"
                        />
                        <button onClick={() => removeRiskPosition(i)} className="text-slate-500 hover:text-red-400">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {riskPositions.length > 0 && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={analyzePortfolioRisk}
                    disabled={riskBusy}
                    className="flex-1 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
                  >
                    {riskBusy ? "Считаю на реальных свечах…" : "Проанализировать"}
                  </button>
                  <button
                    onClick={findHedge}
                    disabled={riskBusy}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 text-sm font-semibold py-2 rounded-xl transition-colors"
                  >
                    Найти хедж
                  </button>
                </div>
              )}
            </div>

            {riskResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-4">
                <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Результат</div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <div className="text-slate-500 text-xs mb-1">Наивная сумма риска</div>
                    <div className="text-white font-mono">${riskResult.naive_dollar_volatility.toFixed(0)}</div>
                  </div>
                  <div>
                    <div className="text-slate-500 text-xs mb-1">Реальный риск портфеля</div>
                    <div className="text-cyan-400 font-mono">${riskResult.portfolio_dollar_volatility.toFixed(0)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${Math.max(0, riskResult.diversification_score * 100).toFixed(0)}%` }} />
                  </div>
                  <span className="text-xs font-mono text-slate-400">{(riskResult.diversification_score * 100).toFixed(0)}% диверсификация</span>
                </div>
              </div>
            )}

            {hedgeResult && (
              <div className="bg-slate-900 border border-amber-700 rounded-2xl p-4">
                <div className="text-xs text-amber-400 uppercase tracking-wide mb-2">Предложение хеджа</div>
                {hedgeResult.suggestion ? (
                  <div>
                    <p className="text-slate-200 text-sm mb-1">
                      {hedgeResult.suggestion.hedge_notional_usd < 0 ? "Short" : "Long"} <span className="font-mono">${Math.abs(hedgeResult.suggestion.hedge_notional_usd).toFixed(0)}</span> {hedgeResult.suggestion.symbol}
                    </p>
                    <p className="text-slate-500 text-xs">
                      Корреляция {(hedgeResult.suggestion.correlation_to_target * 100).toFixed(0)}%, остаточный риск ${hedgeResult.suggestion.resulting_portfolio_vol_usd.toFixed(0)}
                    </p>
                  </div>
                ) : (
                  <p className="text-slate-500 text-sm">Хорошего хеджа среди доступных рынков не нашлось</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {predictTrade && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setPredictTrade(null)}
        >
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-sm">
                {predictTrade.outcome === "yes" ? "Купить YES" : "Купить NO"} — {predictTrade.market.question}
              </h3>
              <button onClick={() => setPredictTrade(null)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <label className="text-xs text-slate-400 mb-1 block">Количество shares</label>
            <input
              type="number"
              value={predictShares}
              onChange={(e) => setPredictShares(Number(e.target.value))}
              className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 mb-3 text-white font-mono outline-none w-full"
            />
            <div className="flex justify-between text-xs text-slate-500 mb-4">
              <span>Стоимость сейчас</span>
              <span className="font-mono text-slate-300">{predictPreviewCost != null ? `$${predictPreviewCost.toFixed(2)}` : "…"}</span>
            </div>
            <button
              onClick={confirmPredictTrade}
              className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold rounded-xl py-3 transition-colors"
            >
              Подтвердить
            </button>
            <p className="text-xs text-slate-600 mt-3 text-center">
              Победившие shares стоят $1 каждая после резолюции, проигравшие — $0. LMSR-цена, не фиксированная.
            </p>
          </div>
        </div>
      )}

      {marketPickerOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setMarketPickerOpen(false)}
        >
          <div
            className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-4 flex flex-col"
            style={{ height: "560px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Выбор рынка</h3>
              <button onClick={() => setMarketPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={marketSearch}
              onChange={(e) => setMarketSearch(e.target.value)}
              placeholder="Поиск по символу…"
              autoFocus
              className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 mb-3 text-white text-sm outline-none w-full"
            />
            <div className="flex gap-1.5 mb-3 overflow-x-auto">
              {(["Все", "Crypto", "Spot", "Stocks", "Forex", "Commodities"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setMarketCategory(c)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    marketCategory === c ? "bg-cyan-500 text-slate-950" : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {filteredMarkets.length === 0 && <p className="text-slate-600 text-sm text-center py-8">Ничего не найдено</p>}
              {filteredMarkets.map((m) => (
                <button
                  key={m.market_id}
                  onClick={() => {
                    setAsset(m.symbol);
                    setMarketPickerOpen(false);
                    setMarketSearch("");
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-colors ${
                    m.symbol === asset ? "bg-slate-800 border border-cyan-700" : "hover:bg-slate-800"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-slate-100 text-sm font-medium">{m.symbol}</span>
                    <span className="text-slate-600 text-xs">{categorizeMarket(m)}</span>
                  </div>
                  <span className="text-slate-600 text-xs font-mono">{m.market_type}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {copyModal && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setCopyModal(null)}
        >
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full ${copyModal.color} flex items-center justify-center text-xs font-bold text-slate-950`}>
                  {copyModal.handle[1].toUpperCase()}
                </div>
                <div>
                  <div className="text-white font-medium text-sm">{copyModal.handle}</div>
                  <div className="text-slate-500 text-xs">{copyModal.markets}</div>
                </div>
              </div>
              <button onClick={() => setCopyModal(null)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <label className="text-xs text-slate-400 mb-1 block">Сумма для копирования</label>
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 mb-3">
              <span className="text-slate-500 mr-1">$</span>
              <input
                type="number"
                value={allocation}
                onChange={(e) => setAllocation(Number(e.target.value))}
                className="bg-transparent text-white font-mono outline-none w-full"
              />
            </div>
            <button onClick={confirmCopy} className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold rounded-xl py-3 transition-colors">
              Подтвердить копирование
            </button>
            <p className="text-xs text-slate-600 mt-3 text-center">Демо: копи-движок ещё не исполняет реальные сделки</p>
          </div>
        </div>
      )}

      {riskPickerOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setRiskPickerOpen(false)}
        >
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[70vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Добавить позицию</h3>
              <button onClick={() => setRiskPickerOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-1.5">
              {markets.slice(0, 60).map((m) => (
                <div key={m.market_id} className="flex items-center justify-between bg-slate-800 rounded-xl px-3 py-2">
                  <span className="text-slate-200 text-sm">{m.symbol}</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => addRiskPosition(m, "long")}
                      className="bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
                    >
                      Long
                    </button>
                    {m.market_type === "perp" && (
                      <button
                        onClick={() => addRiskPosition(m, "short")}
                        className="bg-red-500 hover:bg-red-400 text-slate-950 text-xs font-semibold px-2.5 py-1 rounded-lg transition-colors"
                      >
                        Short
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {markets.length === 0 && <p className="text-slate-600 text-sm text-center py-6">Рынки ещё загружаются</p>}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-slate-100 text-sm px-4 py-2.5 rounded-full shadow-xl flex items-center gap-2 z-50 max-w-md text-center">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          {toast}
        </div>
      )}
    </div>
  );
}
