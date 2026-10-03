import { useState, useEffect, useMemo } from "react";
import {
  TrendingUp,
  TrendingDown,
  Users,
  Copy as CopyIcon,
  X,
  Radio,
  Wallet as WalletIcon,
  ChevronRight,
  ChevronDown,
  Check,
  Zap,
  Pause,
  Play,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";

const TRADERS = [
  { id: "t1", handle: "@northstar", color: "bg-cyan-500", pnl30: 38.4, winRate: 71, followers: 812, risk: "Med", markets: "BTC · ETH", feeBps: 8 },
  { id: "t2", handle: "@vega.eth", color: "bg-violet-500", pnl30: 21.9, winRate: 64, followers: 349, risk: "Low", markets: "ETH · SOL", feeBps: 6 },
  { id: "t3", handle: "@driftking", color: "bg-amber-500", pnl30: 64.2, winRate: 58, followers: 1204, risk: "High", markets: "BTC · alts", feeBps: 10, trending: true },
  { id: "t4", handle: "@cassian_fx", color: "bg-emerald-500", pnl30: 14.7, winRate: 69, followers: 203, risk: "Low", markets: "BTC", feeBps: 5 },
  { id: "t5", handle: "@moonshin", color: "bg-pink-500", pnl30: 9.8, winRate: 61, followers: 128, risk: "Low", markets: "ETH", feeBps: 5 },
  { id: "t6", handle: "@zeroblock", color: "bg-blue-500", pnl30: 47.1, winRate: 55, followers: 566, risk: "High", markets: "BTC · ETH · alts", feeBps: 9 },
];

const WALLETS = [
  { id: "metamask", name: "MetaMask", color: "bg-orange-500" },
  { id: "phantom", name: "Phantom", color: "bg-violet-500" },
  { id: "rabby", name: "Rabby", color: "bg-blue-500" },
  { id: "walletconnect", name: "WalletConnect", color: "bg-cyan-500" },
];

function genWalk(start, n) {
  const arr = [start];
  for (let i = 1; i < n; i++) {
    const prev = arr[i - 1];
    arr.push(Math.max(100, prev + (Math.random() - 0.48) * prev * 0.004));
  }
  return arr;
}

function fmt(n, d = 0) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
}

function fakeAddress() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const part = (n) => Array.from({ length: n }, hex).join("");
  return `0x${part(4)}...${part(4)}`;
}

function genOrderbook(mid, levels, tick) {
  const asks = Array.from({ length: levels }, (_, i) => ({
    price: mid + (levels - i) * tick,
    size: +(Math.random() * 3 + 0.2).toFixed(2),
  }));
  const bids = Array.from({ length: levels }, (_, i) => ({
    price: mid - (i + 1) * tick,
    size: +(Math.random() * 3 + 0.2).toFixed(2),
  }));
  return { asks, bids };
}

function Ripple({ className = "border-cyan-400" }) {
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

function NavTab({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${active ? "bg-slate-800 text-cyan-400" : "text-slate-400 hover:text-slate-200"}`}
    >
      {label}
    </button>
  );
}

function TerminalSection({
  asset, setAsset, price, change24h, chartData, orderbook,
  side, setSide, size, setSize, leverage, setLeverage, liqPrice,
  isCopyable, onToggleCopyable, onPlaceOrder, positions, onClosePosition,
}) {
  const up = change24h >= 0;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-6 bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex gap-2">
              {["BTC", "ETH"].map((a) => (
                <button
                  key={a}
                  onClick={() => setAsset(a)}
                  className={`px-3 py-1 rounded-full text-xs font-medium ${asset === a ? "bg-slate-100 text-slate-950" : "bg-slate-800 text-slate-400"}`}
                >
                  {a}-PERP
                </button>
              ))}
            </div>
            <span className={`text-xs font-mono flex items-center gap-0.5 ${up ? "text-emerald-400" : "text-red-400"}`}>
              {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {up ? "+" : ""}
              {change24h.toFixed(2)}%
            </span>
          </div>
          <div className="text-3xl font-mono font-semibold text-white mb-2">
            ${fmt(price, asset === "BTC" ? 0 : 2)}
          </div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="wakeGradWeb" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={up ? "#2dd4bf" : "#f87171"} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={up ? "#2dd4bf" : "#f87171"} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="v" stroke={up ? "#2dd4bf" : "#f87171"} strokeWidth={2} fill="url(#wakeGradWeb)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Order Book</div>
          <div className="space-y-1">
            {orderbook.asks.map((a, i) => (
              <div key={`a${i}`} className="flex justify-between text-xs font-mono">
                <span className="text-red-400">{fmt(a.price, asset === "BTC" ? 0 : 2)}</span>
                <span className="text-slate-500">{a.size}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs font-mono py-2 my-1.5 border-y border-slate-800 text-slate-300">
            <span>Mid</span>
            <span>${fmt(price, asset === "BTC" ? 0 : 2)}</span>
          </div>
          <div className="space-y-1">
            {orderbook.bids.map((b, i) => (
              <div key={`b${i}`} className="flex justify-between text-xs font-mono">
                <span className="text-emerald-400">{fmt(b.price, asset === "BTC" ? 0 : 2)}</span>
                <span className="text-slate-500">{b.size}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
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
            <input
              type="range"
              min="1"
              max="20"
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </div>

          <div className="flex justify-between text-xs text-slate-500 font-mono">
            <span>Ликв. ≈ ${fmt(liqPrice, 0)}</span>
            <span>Маржа ${fmt(size / leverage, 0)}</span>
          </div>

          <button
            onClick={onPlaceOrder}
            className={`w-full py-2.5 rounded-xl font-semibold transition-colors ${side === "long" ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950" : "bg-red-500 hover:bg-red-400 text-slate-950"}`}
          >
            {side === "long" ? "Открыть Long" : "Открыть Short"}
          </button>

          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="relative w-4 h-4 shrink-0">
                  {isCopyable && <Ripple />}
                  <Radio className={`relative z-10 w-4 h-4 ${isCopyable ? "text-cyan-400" : "text-slate-500"}`} />
                </div>
                <span className="text-xs text-slate-300 font-medium">Копируемые сделки</span>
              </div>
              <button
                onClick={onToggleCopyable}
                className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${isCopyable ? "bg-cyan-500" : "bg-slate-700"}`}
              >
                <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isCopyable ? "translate-x-5" : "translate-x-0.5"}`} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="text-xs text-slate-500 uppercase tracking-wide mb-3">Открытые позиции</div>
        {positions.length === 0 ? (
          <p className="text-slate-600 text-sm">Нет открытых позиций</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-normal">Рынок</th>
                <th className="pb-2 font-normal">Сторона</th>
                <th className="pb-2 font-normal">Размер</th>
                <th className="pb-2 font-normal">Вход</th>
                <th className="pb-2 font-normal">PnL</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.id} className="border-b border-slate-800 last:border-0">
                  <td className="py-2 font-mono text-slate-200">{p.asset}-PERP</td>
                  <td className={`py-2 font-mono ${p.side === "long" ? "text-emerald-400" : "text-red-400"}`}>{p.side === "long" ? "Long" : "Short"}</td>
                  <td className="py-2 font-mono text-slate-300">${fmt(p.size)}</td>
                  <td className="py-2 font-mono text-slate-300">${fmt(p.entry, p.asset === "BTC" ? 0 : 2)}</td>
                  <td className={`py-2 font-mono ${p.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{p.pnl >= 0 ? "+" : ""}{p.pnl}%</td>
                  <td className="py-2 text-right">
                    <button onClick={() => onClosePosition(p.id)} className="text-xs text-slate-500 hover:text-slate-300">Закрыть</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DiscoverSection({ traders, onCopy }) {
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-white font-semibold">Топ Wakes сейчас</h2>
        <p className="text-slate-500 text-sm">Копируй позиции в один клик — без ордербука</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {traders.map((t) => (
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
              <span className="text-slate-400 flex items-center gap-1"><Users className="w-3 h-3" />{fmt(t.followers)}</span>
            </div>
            <button
              onClick={() => onCopy(t)}
              className="w-full flex items-center justify-center gap-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold py-2 rounded-xl transition-colors"
            >
              <CopyIcon className="w-3.5 h-3.5" /> Copy
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function PortfolioSection({ following, onPause, onGoDiscover }) {
  if (following.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl py-20 flex flex-col items-center text-center">
        <WalletIcon className="w-8 h-8 text-slate-700 mb-3" />
        <p className="text-slate-400 text-sm mb-4">Ты пока никого не копируешь</p>
        <button onClick={onGoDiscover} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
          Найти трейдера <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }
  return (
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
                {Number(t.pnlPct) >= 0 ? "+" : ""}{t.pnlPct}%
              </td>
              <td className="py-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${t.paused ? "bg-slate-800 text-slate-500" : "bg-slate-800 text-cyan-400"}`}>
                  {t.paused ? "На паузе" : "Активно"}
                </span>
              </td>
              <td className="py-3 text-right">
                <button onClick={() => onPause(t.key)} className="text-slate-400 hover:text-slate-200">
                  {t.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EarnSection({ isCopyable, totalFollowers, totalAum, monthlyEarnings, onGoTerminal }) {
  if (!isCopyable) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl py-20 flex flex-col items-center text-center">
        <Radio className="w-8 h-8 text-slate-700 mb-3" />
        <p className="text-slate-400 text-sm mb-1">Заработок пока выключен</p>
        <p className="text-slate-600 text-xs mb-4">Включи «копируемые сделки» в Терминале</p>
        <button onClick={onGoTerminal} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
          Перейти в Терминал <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-900 border border-amber-700 rounded-2xl p-4">
          <div className="text-amber-400 text-xs uppercase tracking-wide mb-1">Этот месяц</div>
          <div className="text-2xl font-mono font-bold text-white">${fmt(monthlyEarnings)}</div>
          <div className="text-emerald-400 text-xs font-mono mt-1">+18% к прошлому месяцу</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-xs uppercase tracking-wide mb-1">Подписчики</div>
          <div className="text-2xl font-mono font-bold text-white">{fmt(totalFollowers)}</div>
        </div>
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
          <div className="text-slate-500 text-xs uppercase tracking-wide mb-1">AUM в копиях</div>
          <div className="text-2xl font-mono font-bold text-white">${fmt(totalAum / 1000, 0)}k</div>
        </div>
      </div>
      <p className="text-xs text-slate-600">Иллюстративные цифры для демо.</p>
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
        <div className="text-slate-300 text-xs font-medium mb-2 uppercase tracking-wide">Для разработчиков</div>
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-500 leading-relaxed inline-block">
          POST /v1/wake/embed<br />
          {"{"} integrator_account_index, wallet_or_bot_id {"}"}
        </div>
        <p className="text-slate-600 text-xs mt-2">Встраивай Wake в кошелёк или бота через тот же движок</p>
      </div>
    </div>
  );
}

export default function WakeWebMockup() {
  const [tab, setTab] = useState("terminal");
  const [asset, setAsset] = useState("BTC");
  const [side, setSide] = useState("long");
  const [size, setSize] = useState(1000);
  const [leverage, setLeverage] = useState(5);
  const [isCopyable, setIsCopyable] = useState(false);
  const [following, setFollowing] = useState([]);
  const [copyModal, setCopyModal] = useState(null);
  const [allocation, setAllocation] = useState(250);
  const [toast, setToast] = useState(null);
  const [positions, setPositions] = useState([{ id: "p0", asset: "ETH", side: "long", size: 2400, entry: 3550, pnl: 4.2 }]);

  const [wallet, setWallet] = useState(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connecting, setConnecting] = useState(null);

  const basePrice = asset === "BTC" ? 98450 : 3620;
  const [history, setHistory] = useState(() => genWalk(basePrice, 40));
  const price = history[history.length - 1];

  useEffect(() => {
    setHistory(genWalk(asset === "BTC" ? 98450 : 3620, 40));
  }, [asset]);

  useEffect(() => {
    const id = setInterval(() => {
      setHistory((h) => {
        const prev = h[h.length - 1];
        const next = Math.max(100, prev + (Math.random() - 0.48) * prev * 0.0015);
        return [...h.slice(-50), next];
      });
    }, 1800);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  const change24h = useMemo(() => {
    const first = history[0];
    return ((price - first) / first) * 100;
  }, [history, price]);

  const liqPrice = useMemo(() => {
    const dist = price * (1 / Math.max(leverage, 1)) * 0.9;
    return side === "long" ? price - dist : price + dist;
  }, [price, leverage, side]);

  const chartData = history.map((v, i) => ({ i, v }));
  const orderbook = useMemo(() => {
    const tick = asset === "BTC" ? 5 : 0.5;
    const mid = Math.round(price / tick) * tick;
    return genOrderbook(mid, 8, tick);
  }, [price, asset]);

  function requireWallet() {
    if (!wallet) {
      setWalletModalOpen(true);
      setToast("Сначала подключи кошелёк");
      return false;
    }
    return true;
  }

  function connectWallet(providerId) {
    setConnecting(providerId);
    setTimeout(() => {
      setWallet({ address: fakeAddress(), provider: providerId });
      setConnecting(null);
      setWalletModalOpen(false);
      setToast("Кошелёк подключен");
    }, 900);
  }

  function placeOrder() {
    if (!requireWallet()) return;
    setPositions((p) => [...p, { id: "p" + Date.now(), asset, side, size, entry: price, pnl: 0 }]);
    setToast(`${side === "long" ? "Long" : "Short"} ${asset} на $${fmt(size)} открыт`);
  }

  function closePosition(id) {
    setPositions((p) => p.filter((x) => x.id !== id));
  }

  function toggleCopyable() {
    if (!requireWallet()) return;
    setIsCopyable((v) => !v);
  }

  function confirmCopy() {
    if (!requireWallet()) return;
    if (!copyModal) return;
    setFollowing((f) => [
      ...f,
      { ...copyModal, allocation, paused: false, pnlPct: (Math.random() * 20 - 4).toFixed(1), key: copyModal.id + Date.now() },
    ]);
    setToast(`Ты оседлал волну ${copyModal.handle}`);
    setCopyModal(null);
    setAllocation(250);
  }

  function togglePause(key) {
    setFollowing((f) => f.map((t) => (t.key === key ? { ...t, paused: !t.paused } : t)));
  }

  const totalFollowers = 340;
  const totalAum = 186400;
  const monthlyEarnings = 2140;

  return (
    <div className="min-h-screen w-full bg-slate-950 font-sans">
      <style>{`
        @keyframes wakeRipple {
          0% { transform: scale(0.6); opacity: 0.7; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>

      <div className="max-w-6xl mx-auto px-6 py-5">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-cyan-500 flex items-center justify-center">
                <Zap className="w-4 h-4 text-slate-950" strokeWidth={2.5} />
              </div>
              <span className="text-white font-semibold tracking-tight text-lg">Wake</span>
              <span className="text-xs text-slate-500 font-mono uppercase tracking-wide ml-1">Lighter · mainnet</span>
            </div>
            <nav className="flex items-center gap-1">
              <NavTab active={tab === "terminal"} onClick={() => setTab("terminal")} label="Терминал" />
              <NavTab active={tab === "discover"} onClick={() => setTab("discover")} label="Discover" />
              <NavTab active={tab === "portfolio"} onClick={() => setTab("portfolio")} label="Портфель" />
              <NavTab active={tab === "earn"} onClick={() => setTab("earn")} label="Earn" />
            </nav>
          </div>

          <div className="relative">
            {wallet ? (
              <button
                onClick={() => setWalletMenuOpen((v) => !v)}
                className="flex items-center gap-2 bg-slate-900 border border-slate-700 hover:border-slate-600 rounded-full pl-1.5 pr-3 py-1.5 text-sm text-slate-200 font-mono transition-colors"
              >
                <span className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center text-slate-950 text-xs font-bold">
                  {wallet.provider[0].toUpperCase()}
                </span>
                {wallet.address}
                <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
              </button>
            ) : (
              <button
                onClick={() => setWalletModalOpen(true)}
                className="bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-sm font-semibold px-4 py-2 rounded-full transition-colors"
              >
                Connect Wallet
              </button>
            )}
            {wallet && walletMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setWalletMenuOpen(false)} />
                <div className="absolute right-0 mt-2 w-56 bg-slate-900 border border-slate-700 rounded-xl p-3 z-50 shadow-xl">
                  <div className="text-xs text-slate-500 mb-1">
                    Через {WALLETS.find((w) => w.id === wallet.provider)?.name}
                  </div>
                  <div className="text-sm text-slate-200 font-mono mb-3">{wallet.address}</div>
                  <button
                    onClick={() => {
                      setWallet(null);
                      setWalletMenuOpen(false);
                      setToast("Кошелёк отключен");
                    }}
                    className="w-full text-center text-sm text-red-400 hover:text-red-300 border border-red-900 rounded-lg py-1.5 transition-colors"
                  >
                    Отключить
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {tab === "terminal" && (
          <TerminalSection
            asset={asset} setAsset={setAsset} price={price} change24h={change24h} chartData={chartData} orderbook={orderbook}
            side={side} setSide={setSide} size={size} setSize={setSize} leverage={leverage} setLeverage={setLeverage} liqPrice={liqPrice}
            isCopyable={isCopyable} onToggleCopyable={toggleCopyable} onPlaceOrder={placeOrder}
            positions={positions} onClosePosition={closePosition}
          />
        )}
        {tab === "discover" && <DiscoverSection traders={TRADERS} onCopy={(t) => setCopyModal(t)} />}
        {tab === "portfolio" && <PortfolioSection following={following} onPause={togglePause} onGoDiscover={() => setTab("discover")} />}
        {tab === "earn" && (
          <EarnSection
            isCopyable={isCopyable} totalFollowers={totalFollowers} totalAum={totalAum} monthlyEarnings={monthlyEarnings}
            onGoTerminal={() => setTab("terminal")}
          />
        )}
      </div>

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
            <div className="flex justify-between text-xs text-slate-500 mb-4">
              <span>Комиссия за копию</span>
              <span className="font-mono text-slate-300">{(copyModal.feeBps / 100).toFixed(2)}% с оборота</span>
            </div>
            <button
              onClick={confirmCopy}
              className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-semibold rounded-xl py-3 transition-colors"
            >
              Подтвердить копирование
            </button>
            <p className="text-xs text-slate-600 mt-3 text-center">
              Позиции откроются на твоём аккаунте автоматически при новых входах {copyModal.handle}
            </p>
          </div>
        </div>
      )}

      {walletModalOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setWalletModalOpen(false)}
        >
          <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-sm">Подключить кошелёк</h3>
              <button onClick={() => setWalletModalOpen(false)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-2">
              {WALLETS.map((w) => (
                <button
                  key={w.id}
                  onClick={() => connectWallet(w.id)}
                  disabled={!!connecting}
                  className="w-full flex items-center justify-between bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-xl px-4 py-3 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-7 h-7 rounded-lg ${w.color} flex items-center justify-center text-xs font-bold text-slate-950`}>
                      {w.name[0]}
                    </div>
                    <span className="text-slate-200 text-sm font-medium">{w.name}</span>
                  </div>
                  {connecting === w.id ? (
                    <span className="text-xs text-slate-500">Подключение…</span>
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-600" />
                  )}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-600 mt-4 text-center">Демо — реальное подключение не выполняется</p>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-slate-100 text-sm px-4 py-2.5 rounded-full shadow-xl flex items-center gap-2 z-50">
          <Check className="w-4 h-4 text-emerald-400" />
          {toast}
        </div>
      )}
    </div>
    </div>
  );
}
