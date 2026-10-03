import { useState, useEffect, useMemo } from "react";
import {
  TrendingUp,
  TrendingDown,
  Users,
  Copy as CopyIcon,
  X,
  Radio,
  Wallet,
  ChevronRight,
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

function NavBtn({ active, onClick, label, icon }) {
  return (
    <button onClick={onClick} className={`flex flex-col items-center gap-1 py-1 rounded-xl transition-colors ${active ? "text-cyan-400" : "text-slate-500"}`}>
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function TerminalView({
  asset, setAsset, price, change24h, chartData,
  side, setSide, size, setSize, leverage, setLeverage,
  liqPrice, isCopyable, setIsCopyable, placeOrder,
}) {
  const up = change24h >= 0;
  return (
    <div className="px-5 py-4 space-y-4">
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

      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-mono font-semibold text-white">
            ${fmt(price, asset === "BTC" ? 0 : 2)}
          </span>
          <span className={`text-sm font-mono flex items-center gap-0.5 ${up ? "text-emerald-400" : "text-red-400"}`}>
            {up ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
            {up ? "+" : ""}
            {change24h.toFixed(2)}%
          </span>
        </div>
        <div className="h-16 -mx-1 mt-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="wakeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={up ? "#2dd4bf" : "#f87171"} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={up ? "#2dd4bf" : "#f87171"} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={up ? "#2dd4bf" : "#f87171"} strokeWidth={2} fill="url(#wakeGrad)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

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
        <span>Ликвидация ≈ ${fmt(liqPrice, 0)}</span>
        <span>Маржа ${fmt(size / leverage, 0)}</span>
      </div>

      <button
        onClick={placeOrder}
        className={`w-full py-3 rounded-xl font-semibold transition-colors ${side === "long" ? "bg-emerald-500 hover:bg-emerald-400 text-slate-950" : "bg-red-500 hover:bg-red-400 text-slate-950"}`}
      >
        {side === "long" ? "Открыть Long" : "Открыть Short"}
      </button>

      <div className="border-t border-slate-800 pt-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative w-4 h-4 shrink-0">
              {isCopyable && <Ripple />}
              <Radio className={`relative z-10 w-4 h-4 ${isCopyable ? "text-cyan-400" : "text-slate-500"}`} />
            </div>
            <div>
              <div className="text-sm text-slate-200 font-medium">Сделать сделки копируемыми</div>
              <div className="text-xs text-slate-500">Подписчики зеркалят тебя, ты получаешь комиссию</div>
            </div>
          </div>
          <button
            onClick={() => setIsCopyable((v) => !v)}
            className={`w-11 h-6 rounded-full transition-colors relative shrink-0 ${isCopyable ? "bg-cyan-500" : "bg-slate-700"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isCopyable ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        {isCopyable && (
          <div className="mt-3 bg-slate-800 border border-amber-700 rounded-xl p-3 text-xs text-amber-300">
            При среднем спросе в нише: ~340 подписчиков × $550 средняя аллокация × 0.08% с оборота ≈{" "}
            <span className="font-mono font-semibold">$2,140/мес</span>. Иллюстративные цифры.
          </div>
        )}
      </div>
    </div>
  );
}

function DiscoverView({ traders, onCopy }) {
  return (
    <div className="px-5 py-4 space-y-3">
      <div>
        <h2 className="text-white font-semibold text-sm">Топ Wakes сейчас</h2>
        <p className="text-slate-500 text-xs">Копируй позиции в один тап — без ордербука</p>
      </div>
      {traders.map((t) => (
        <div key={t.id} className="bg-slate-800 border border-slate-700 rounded-2xl p-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="relative w-9 h-9 shrink-0">
                {t.trending && <Ripple />}
                <div className={`relative z-10 w-9 h-9 rounded-full ${t.color} flex items-center justify-center text-xs font-bold text-slate-950`}>
                  {t.handle[1].toUpperCase()}
                </div>
              </div>
              <div>
                <div className="text-slate-100 text-sm font-medium flex items-center gap-1.5">
                  {t.handle}
                  {t.trending && <span className="text-cyan-400 text-xs font-normal">· в тренде</span>}
                </div>
                <div className="text-slate-500 text-xs">{t.markets} · риск {t.risk}</div>
              </div>
            </div>
            <button
              onClick={() => onCopy(t)}
              className="flex items-center gap-1 bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors"
            >
              <CopyIcon className="w-3 h-3" /> Copy
            </button>
          </div>
          <div className="flex justify-between mt-3 text-xs font-mono">
            <span className="text-emerald-400">+{t.pnl30}% / 30д</span>
            <span className="text-slate-400">{t.winRate}% winrate</span>
            <span className="text-slate-400 flex items-center gap-1">
              <Users className="w-3 h-3" />
              {fmt(t.followers)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PortfolioView({ following, onPause, onDiscover }) {
  if (following.length === 0) {
    return (
      <div className="px-5 py-16 flex flex-col items-center text-center">
        <Wallet className="w-8 h-8 text-slate-700 mb-3" />
        <p className="text-slate-400 text-sm mb-4">Ты пока никого не копируешь</p>
        <button onClick={onDiscover} className="text-cyan-400 text-sm font-medium flex items-center gap-1">
          Найти трейдера <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    );
  }
  return (
    <div className="px-5 py-4 space-y-3">
      <h2 className="text-white font-semibold text-sm mb-1">Твои копии</h2>
      {following.map((t) => (
        <div key={t.key} className={`bg-slate-800 border border-slate-700 rounded-2xl p-3.5 ${t.paused ? "opacity-50" : ""}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className={`w-8 h-8 rounded-full ${t.color} flex items-center justify-center text-xs font-bold text-slate-950`}>
                {t.handle[1].toUpperCase()}
              </div>
              <div>
                <div className="text-slate-100 text-sm font-medium">{t.handle}</div>
                <div className="text-slate-500 text-xs font-mono">${fmt(t.allocation)} аллокация</div>
              </div>
            </div>
            <button onClick={() => onPause(t.key)} className="text-slate-400 hover:text-slate-200">
              {t.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            </button>
          </div>
          <div className={`mt-2 text-sm font-mono ${Number(t.pnlPct) >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {Number(t.pnlPct) >= 0 ? "+" : ""}
            {t.pnlPct}% PnL
          </div>
        </div>
      ))}
    </div>
  );
}

function EarnView({ isCopyable, totalFollowers, totalAum, monthlyEarnings, onGoTerminal }) {
  if (!isCopyable) {
    return (
      <div className="px-5 py-16 flex flex-col items-center text-center">
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
    <div className="px-5 py-4 space-y-4">
      <h2 className="text-white font-semibold text-sm">Твой доход как Wake</h2>
      <div className="bg-slate-800 border border-amber-700 rounded-2xl p-4">
        <div className="text-amber-400 text-xs mb-1 uppercase tracking-wide">Этот месяц</div>
        <div className="text-3xl font-mono font-bold text-white">${fmt(monthlyEarnings)}</div>
        <div className="text-emerald-400 text-xs font-mono mt-1">+18% к прошлому месяцу</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
          <div className="text-slate-500 text-xs mb-1">Подписчики</div>
          <div className="text-white font-mono font-semibold">{fmt(totalFollowers)}</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3">
          <div className="text-slate-500 text-xs mb-1">AUM в копиях</div>
          <div className="text-white font-mono font-semibold">${fmt(totalAum / 1000, 0)}k</div>
        </div>
      </div>
      <p className="text-xs text-slate-600">Иллюстративные цифры для демо.</p>

      <div className="border-t border-slate-800 pt-4">
        <div className="text-slate-300 text-xs font-medium mb-1.5 uppercase tracking-wide">Для разработчиков</div>
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 font-mono text-xs text-slate-500 leading-relaxed">
          POST /v1/wake/embed
          <br />
          {"{"} integrator_account_index, wallet_or_bot_id {"}"}
        </div>
        <p className="text-slate-600 text-xs mt-1.5">Встраивай Wake в кошелёк или бота через тот же движок</p>
      </div>
    </div>
  );
}

export default function WakeMockup() {
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

  const basePrice = asset === "BTC" ? 98450 : 3620;
  const [history, setHistory] = useState(() => genWalk(basePrice, 36));
  const price = history[history.length - 1];

  useEffect(() => {
    setHistory(genWalk(asset === "BTC" ? 98450 : 3620, 36));
  }, [asset]);

  useEffect(() => {
    const id = setInterval(() => {
      setHistory((h) => {
        const prev = h[h.length - 1];
        const next = Math.max(100, prev + (Math.random() - 0.48) * prev * 0.0015);
        return [...h.slice(-40), next];
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

  function placeOrder() {
    setToast(`${side === "long" ? "Long" : "Short"} ${asset} на $${fmt(size)} открыт (демо)`);
  }

  function confirmCopy() {
    if (!copyModal) return;
    setFollowing((f) => [
      ...f,
      {
        ...copyModal,
        allocation,
        paused: false,
        pnlPct: (Math.random() * 20 - 4).toFixed(1),
        key: copyModal.id + Date.now(),
      },
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
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 p-4 font-sans">
      <style>{`
        @keyframes wakeRipple {
          0% { transform: scale(0.6); opacity: 0.7; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>

      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl overflow-hidden flex flex-col"
        style={{ height: "760px" }}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-cyan-500 flex items-center justify-center">
              <Zap className="w-4 h-4 text-slate-950" strokeWidth={2.5} />
            </div>
            <span className="text-white font-semibold tracking-tight">Wake</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-slate-500 font-mono uppercase tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
            Lighter · mainnet
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "terminal" && (
            <TerminalView
              asset={asset}
              setAsset={setAsset}
              price={price}
              change24h={change24h}
              chartData={chartData}
              side={side}
              setSide={setSide}
              size={size}
              setSize={setSize}
              leverage={leverage}
              setLeverage={setLeverage}
              liqPrice={liqPrice}
              isCopyable={isCopyable}
              setIsCopyable={setIsCopyable}
              placeOrder={placeOrder}
            />
          )}
          {tab === "discover" && <DiscoverView traders={TRADERS} onCopy={(t) => setCopyModal(t)} />}
          {tab === "portfolio" && (
            <PortfolioView following={following} onPause={togglePause} onDiscover={() => setTab("discover")} />
          )}
          {tab === "earn" && (
            <EarnView
              isCopyable={isCopyable}
              totalFollowers={totalFollowers}
              totalAum={totalAum}
              monthlyEarnings={monthlyEarnings}
              onGoTerminal={() => setTab("terminal")}
            />
          )}
        </div>

        <div className="grid grid-cols-4 border-t border-slate-800 bg-slate-900 px-1 py-2">
          <NavBtn active={tab === "terminal"} onClick={() => setTab("terminal")} label="Терминал" icon={<TrendingUp className="w-5 h-5" />} />
          <NavBtn active={tab === "discover"} onClick={() => setTab("discover")} label="Discover" icon={<Users className="w-5 h-5" />} />
          <NavBtn active={tab === "portfolio"} onClick={() => setTab("portfolio")} label="Портфель" icon={<Wallet className="w-5 h-5" />} />
          <NavBtn active={tab === "earn"} onClick={() => setTab("earn")} label="Earn" icon={<Radio className="w-5 h-5" />} />
        </div>
      </div>

      {copyModal && (
        <div
          className="fixed inset-0 flex items-end sm:items-center justify-center z-50 p-4"
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-700 text-slate-100 text-sm px-4 py-2.5 rounded-full shadow-xl flex items-center gap-2 z-50">
          <Check className="w-4 h-4 text-emerald-400" />
          {toast}
        </div>
      )}
    </div>
  );
}
