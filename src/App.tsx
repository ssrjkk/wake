import { useState, useEffect, lazy, Suspense } from "react";
import { useAccount, useConnect, useDisconnect, useEnsName } from "wagmi";
import { Zap, ChevronDown, ChevronRight, X, Check, ServerOff, RefreshCw, AlertTriangle, Info } from "lucide-react";
import {
  getOrderBooks,
  getAccountByL1Address,
  registerFollower,
  listFollowsForFollower,
  createFollow,
  setFollowPaused,
  deleteFollow,
  registerLeader,
  setNetwork as setLighterNetwork,
  type LighterAccount,
  type LighterNetwork,
  type OrderBook,
} from "./lib/lighter";
import { LIGHTER_NETWORK } from "./lib/config";
import { backendJson, errorText, probeBackend, type BackendHealth } from "./lib/backend";
import { NavTab } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { Tab } from "./components/types";
import { TelegramLogin } from "./components/TelegramLogin";
import { verifyTelegramLogin, type TelegramUser } from "./lib/telegram";
import { connectTelegramMiniApp, isTelegramWebView, type TelegramProfile } from "./lib/telegram";
import { categorizeMarket, avatarColor, shortHandle, usd, fmt } from "./components/utils";
import type { Leader, Following, Subscription } from "./components/types";

const Dashboard = lazy(() => import("./components/Dashboard"));
const Terminal = lazy(() => import("./components/Terminal"));
const Discover = lazy(() => import("./components/Discover"));
const Portfolio = lazy(() => import("./components/Portfolio"));
const Earn = lazy(() => import("./components/Earn"));
const Predict = lazy(() => import("./components/Predict"));
const Agent = lazy(() => import("./components/Agent"));
const Risk = lazy(() => import("./components/Risk"));
const Funding = lazy(() => import("./components/Funding"));

export default function App() {
  const { address, isConnected } = useAccount();
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [tab, setTab] = useState<Tab>("dashboard");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [lighterAccount, setLighterAccount] = useState<LighterAccount | null>(null);
  const [lighterChecked, setLighterChecked] = useState(false);

  const [asset, setAsset] = useState<string>("BTC");
  const [network, setNetwork] = useState<LighterNetwork>(LIGHTER_NETWORK);
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const [marketSearch, setMarketSearch] = useState("");
  const [marketCategory, setMarketCategory] = useState<string>("Все");
  const [markets, setMarkets] = useState<OrderBook[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const [isCopyable, setIsCopyable] = useState(false);
  const [following, setFollowing] = useState<Following[]>([]);
  const [copyModal, setCopyModal] = useState<Leader | null>(null);
  const [allocation, setAllocation] = useState(250);
  const [copyLeverage, setCopyLeverage] = useState(3);

  const [followerId, setFollowerId] = useState<string | null>(null);
  const [backend, setBackend] = useState<BackendHealth | null>(null);
  const [backendChecked, setBackendChecked] = useState(false);
  const [authSource, setAuthSource] = useState<"wallet" | "telegram" | null>(null);
  const [telegramUser, setTelegramUser] = useState<TelegramProfile | null>(null);
  const [miniAppBusy, setMiniAppBusy] = useState(false);

  const backendUp = backend !== null;

  function checkBackend() {
    setBackendChecked(false);
    probeBackend()
      .then(setBackend)
      .catch(() => setBackend(null))
      .finally(() => setBackendChecked(true));
  }

  useEffect(checkBackend, []);

  useEffect(() => {
    if (!address) return;
    registerFollower(address)
      .then((id) => {
        setFollowerId(id);
        setAuthSource("wallet");
      })
      .catch((e) => setToast(`Кошелёк подключён, но Wake его не записал: ${errorText(e)}`));
  }, [address]);

  useEffect(() => {
    if (!followerId) {
      setFollowing([]);
      return;
    }
    listFollowsForFollower(followerId)
      .then((rows) => {
        setFollowing(
          rows.map((r) => ({
            followId: r.id,
            leaderId: r.leader_id,
            handle: r.leader_handle ?? "",
            allocationUsd: r.allocation_usd,
            maxLeverage: r.max_leverage,
            mirroredSize: r.current_mirrored_size,
            paused: !!r.paused,
          }))
        );
      })
      // Пустой список при отказе — не «подписок нет», а «мы их не видим»: список
      // ниже по этому пути даёт кнопки pause/unfollow, а бэкенд их не подтвердил.
      .catch(() => setFollowing([]));
  }, [followerId]);

  const [toast, setToastState] = useState<{ msg: string; variant: "success" | "error" | "info"; ts: number } | null>(null);

  function setToast(msg: string | null) {
    if (msg === null) {
      setToastState(null);
      return;
    }
    const variant = msg.includes("не удалось") || msg.includes("не отправлен") || msg.includes("ошибка") || msg.includes("error")
      ? "error"
      : msg.includes("отправлен") || msg.includes("успешно") || msg.includes("добавлен")
      ? "success"
      : "info";
    setToastState({ msg, variant, ts: Date.now() });
  }

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
  }, [address, network]);

  useEffect(() => {
    setDataError(null);
    function load() {
      getOrderBooks("all").then(setMarkets).catch((e) => setDataError(errorText(e)));
    }
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [network]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") {
        setConnectPickerOpen(false);
        setMarketPickerOpen(false);
        setWalletMenuOpen(false);
        setCopyModal(null);
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const tabMap: Record<string, Tab> = {
          "1": "dashboard",
          "2": "terminal",
          "3": "discover",
          "4": "portfolio",
          "5": "earn",
          "6": "predict",
          "7": "agent",
          "8": "risk",
          "9": "funding",
        };
        if (tabMap[e.key]) {
          e.preventDefault();
          setTab(tabMap[e.key]);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  function switchNetwork(next: LighterNetwork) {
    setLighterNetwork(next);
    setNetwork(next);
  }

  const currentMarket = markets.find((m) => m.symbol === asset);

  const filteredMarkets = markets
    .filter((m) => marketCategory === "Все" || categorizeMarket(m) === marketCategory)
    .filter((m) => {
      const q = marketSearch.trim().toUpperCase();
      return !q || m.symbol.toUpperCase().includes(q);
    })
    .slice(0, 200);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(id);
  }, [toast]);

  // Оба Telegram-входа сходятся в одну точку: profile приходит уже от бэкенда,
  // проверившего подпись, поэтому имя в шапке — то, что подтвердил сервер.
  function signInAsTelegram(profile: TelegramProfile) {
    setFollowerId(profile.user_id);
    setAuthSource("telegram");
    setTelegramUser(profile);
    setConnectPickerOpen(false);
  }

  async function handleTelegramLogin(user: TelegramUser) {
    try {
      signInAsTelegram(await verifyTelegramLogin(user));
      setToast(`Добро пожаловать, ${user.first_name}!`);
    } catch (e) {
      setToast(`Telegram не подтвердил вход: ${errorText(e)}`);
    }
  }

  // auto=true — молчаливая попытка на старте внутри мини-аппа: вне Telegram она
  // возвращает null и не должна ничего показывать, окно выбора само всё объяснит.
  async function loginFromMiniApp(auto: boolean) {
    setMiniAppBusy(true);
    try {
      const profile = await connectTelegramMiniApp();
      if (profile) {
        signInAsTelegram(profile);
        if (!auto) setToast(`Вошёл как @${profile.username ?? profile.first_name}`);
      } else if (!auto) {
        setToast("Telegram не передал подписанную initData — войди через виджет или кошелёк");
      }
    } catch (e) {
      setToast(`Telegram не подтвердил вход: ${errorText(e)}`);
    } finally {
      setMiniAppBusy(false);
    }
  }

  useEffect(() => {
    // Кнопка «Открыть Wake» в боте ведёт сюда же, на обычный сайт: внутри Telegram
    // вход идёт по initData, а не по виджету, который вебвью почти всегда не показывает.
    if (isTelegramWebView()) void loginFromMiniApp(true);
  }, []);

  function signOut() {
    if (isConnected) disconnect();
    setFollowerId(null);
    setAuthSource(null);
    setTelegramUser(null);
    setFollowing([]);
    setSubscription(null);
    setIsCopyable(false);
    setLeaderId(null);
    setWalletMenuOpen(false);
  }

  async function confirmCopy() {
    if (!copyModal) return;
    if (!followerId) {
      setToast("Сначала войди через Telegram или кошелёк — подписка пишется на твой аккаунт");
      return;
    }
    try {
      const followId = await createFollow(followerId, copyModal.id, allocation, copyLeverage);
      setFollowing((f) => [
        ...f,
        {
          followId,
          leaderId: copyModal.id,
          handle: copyModal.handle,
          allocationUsd: allocation,
          maxLeverage: copyLeverage,
          mirroredSize: 0,
          paused: false,
        },
      ]);
      setToast(`Подписка на ${copyModal.handle} записана в таблицу follows`);
    } catch (e) {
      setToast(`Бэкенд отклонил подписку: ${errorText(e)}`);
      return;
    }
    setCopyModal(null);
    setAllocation(250);
    setCopyLeverage(3);
  }

  function togglePause(followId: string) {
    const target = following.find((t) => t.followId === followId);
    if (!target || !followerId) return;
    const next = !target.paused;
    setFollowing((f) => f.map((t) => (t.followId === followId ? { ...t, paused: next } : t)));
    setFollowPaused(followId, next, followerId).catch((e) => setToast(`Пауза не записана в базу: ${errorText(e)}`));
  }

  function unfollow(followId: string) {
    if (!followerId) return;
    setFollowing((f) => f.filter((t) => t.followId !== followId));
    deleteFollow(followId, followerId).catch((e) => setToast(`Не удалось отписать: ${errorText(e)}`));
  }

  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [leaderFeeBps, setLeaderFeeBps] = useState(8);

  async function toggleCopyable() {
    const next = !isCopyable;
    setIsCopyable(next);
    if (!next) {
      setLeaderId(null);
      return;
    }
    if (!backendUp) {
      setToast("Бэкенд не отвечает — подписки не запишутся");
      return;
    }
    if (lighterAccountIndex == null) {
      setToast("Нет аккаунта Lighter по этому адресу — лидер публикуется по index аккаунта");
      return;
    }
    try {
      const id = await registerLeader(lighterAccountIndex, ensName ?? `${address?.slice(0, 6)}...${address?.slice(-4)}`, leaderFeeBps);
      setLeaderId(id);
      setToast(`Стал лидером: индекс Lighter #${lighterAccountIndex}, комиссия ${(leaderFeeBps / 100).toFixed(2)}% за сделку`);
    } catch (e) {
      setToast(`Не удалось записаться в leaders: ${errorText(e)}`);
    }
  }

  const lighterAccountIndex: number | null = lighterAccount?.accountIndex ?? null;

  const [subscription, setSubscription] = useState<Subscription | null>(null);

  useEffect(() => {
    if (!followerId) return;
    backendJson<Subscription>(`/subscription/${followerId}`)
      .then(setSubscription)
      .catch(() => setSubscription(null));
  }, [followerId]);

  async function startTrial() {
    if (!followerId) {
      setToast("Сначала войди через Telegram или кошелёк");
      return;
    }
    try {
      await backendJson(`/subscription/${followerId}/start-trial`, { method: "POST" });
      setSubscription(await backendJson<Subscription>(`/subscription/${followerId}`));
      setToast("Пробный период начат — 14 дней");
    } catch (e) {
      setToast(`Бэкенд не отвечает: ${errorText(e)}`);
    }
  }

  const identityLabel =
    authSource === "telegram" && telegramUser
      ? telegramUser.username
        ? `@${telegramUser.username}`
        : telegramUser.first_name
      : address
      ? ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}`
      : null;

  return (
    <div className="min-h-screen w-full font-sans">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5">
        <div className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-[#ff6b35] to-[#ff8c5a] flex items-center justify-center glow-logo shadow-lg shadow-[#ff6b35]/20">
                <Zap className="w-5 h-5 text-[#0a0a0a]" strokeWidth={2.5} />
              </div>
              <span className="text-white font-bold tracking-tight text-xl" style={{ fontFamily: "Space Grotesk" }}>Wake</span>
              <div className="flex items-center gap-1.5 ml-2">
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] transition-colors">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#ff6b35] live-indicator"></div>
                  <span className="text-[11px] font-mono text-[#888] uppercase tracking-wide">Lighter</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] transition-colors">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#10b981] live-indicator"></div>
                  <span className="text-[11px] font-mono text-[#888] uppercase tracking-wide">Arcus</span>
                </div>
              </div>
              <div className="flex rounded-lg border border-[#2a2a2a] overflow-hidden ml-2 bg-[#0a0a0a]">
                {(["mainnet", "testnet"] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => switchNetwork(n)}
                    title={n === "mainnet" ? "Реальные рынки Lighter и Arcus, реальные цены" : "Тестовая сеть — тот же код, другие market ids"}
                    className={`px-3 py-2 text-[11px] font-mono uppercase tracking-wide transition-all min-h-[36px] ${
                      network === n
                        ? "bg-[#1a1a1a] text-[#ff6b35] font-semibold shadow-inner"
                        : "text-[#666] hover:text-[#888] hover:bg-[#141414]"
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              {address || followerId ? (
                <button
                  onClick={() => setWalletMenuOpen((v) => !v)}
                  className="flex items-center gap-2 bg-gradient-to-r from-[#1a1a1a] to-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] hover:shadow-lg hover:shadow-black/20 rounded-full pl-1.5 pr-3 py-2 text-sm text-[#ccc] font-mono transition-all min-h-[40px]"
                >
                  <span
                    className={`w-6 h-6 rounded-full ${
                      authSource === "telegram" ? "bg-gradient-to-br from-[#ff6b35] to-[#ff8c5a]" : "bg-gradient-to-br from-[#10b981] to-[#34d399]"
                    } flex items-center justify-center text-[#0a0a0a] text-xs font-bold shadow-sm`}
                  >
                    {(identityLabel ?? "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
                  </span>
                  {identityLabel ?? "Кошелёк подключён"}
                  <ChevronDown className="w-3.5 h-3.5 text-[#666]" />
                </button>
              ) : (
                <button onClick={() => setConnectPickerOpen(true)} className="btn-primary shadow-lg shadow-[#3b82f6]/20 hover:shadow-[#3b82f6]/30 hover:scale-[1.02] transition-all">
                  Войти через TG или кошелёк
                </button>
              )}

              {walletMenuOpen && (address || followerId) && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setWalletMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-72 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 z-50 shadow-2xl animate-scale-in">
                    <div className="text-xs text-[#666] mb-1">Вход через {authSource === "telegram" ? "Telegram" : "кошелёк"}</div>
                    <div className="text-sm text-[#ccc] font-medium mb-3">{identityLabel ?? "—"}</div>
                    {address && (
                      <>
                        <div className="text-xs text-[#666] mb-1">Ethereum-адрес</div>
                        <div className="text-sm text-[#ccc] font-mono mb-3 break-all">{address}</div>
                      </>
                    )}
                    <div className="text-xs text-[#888] mb-2">
                      {!address
                        ? "Кошелёк не подключён — позиции Lighter по адресу не видны, подключи его в этом меню."
                        : !lighterChecked
                        ? "Проверяю аккаунт на Lighter…"
                        : lighterAccountIndex != null
                        ? `Lighter account index: ${lighterAccountIndex}`
                        : "Аккаунт на Lighter не найден — зарегистрируйся на app.lighter.xyz"}
                    </div>
                    <div className="text-xs text-[#666] mb-4 font-mono">
                      {followerId ? `follower_id: ${followerId}` : backendUp ? "" : "Бэкенд Wake не отвечает — подписки не запишутся"}
                    </div>
                    {backend && (
                      <div className="text-xs text-[#666] mb-3 font-mono">
                        бэкенд: {backend.network} · {backend.dry_run ? "dry-run — ордера не отправляются" : "реальные ордера"}
                      </div>
                    )}
                    {address && !followerId && (
                      <button
                        onClick={() => setConnectPickerOpen(true)}
                        className="w-full text-center text-sm text-[#ccc] border border-[#2a2a2a] rounded py-2 mb-2 transition-colors hover:bg-[#141414]"
                      >
                        Войти через Telegram
                      </button>
                    )}
                    <button
                      onClick={signOut}
                      className="w-full text-center text-sm text-[#ef4444] hover:text-red-400 border border-red-900/50 rounded py-2 transition-colors hover:bg-[#141414]"
                    >
                      Выйти
                    </button>
                  </div>
                </>
              )}

              {connectPickerOpen && (
                <div
                  className="fixed inset-0 flex items-center justify-center z-50 p-4 animate-fade-in"
                  style={{ backgroundColor: "rgba(0,0,0,0.7)" }}
                  onClick={() => setConnectPickerOpen(false)}
                >
                  <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-6 animate-scale-in" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-white font-semibold text-lg">Войти в Wake</h3>
                      <button onClick={() => setConnectPickerOpen(false)} className="text-[#666] hover:text-[#888] transition-colors" aria-label="Закрыть">
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="text-xs text-[#888] uppercase tracking-wide font-medium mb-2">Через Telegram</div>
                      {isTelegramWebView() ? (
                        <>
                          <button
                            onClick={() => {
                              void loginFromMiniApp(false);
                            }}
                            disabled={miniAppBusy}
                            className="btn-action w-full bg-[#ff6b35] hover:bg-orange-500 text-[#0a0a0a]"
                          >
                            {miniAppBusy ? "Проверяю initData…" : "Войти через Telegram"}
                          </button>
                          <p className="text-xs text-[#666] leading-relaxed font-mono">
                            Страница открыта внутри Telegram, поэтому вход идёт по подписанной <code className="text-[#888]">initData</code>: её
                            целиком проверяет <code className="text-[#888]">POST /auth/telegram/init</code> на токене бота. Login-виджет здесь не
                            нужен — Telegram его в вебвью обычно не рендерит.
                          </p>
                        </>
                      ) : (
                        <>
                          <TelegramLogin onLogin={(u) => void handleTelegramLogin(u)} />
                          <p className="text-xs text-[#666] leading-relaxed font-mono">
                            Виджет отдаёт подпись HMAC-SHA256; её проверяет <code className="text-[#888]">POST /auth/telegram</code> на токене бота, а
                            не браузер. Без <code className="text-[#888]">TELEGRAM_BOT_TOKEN</code> на бэкенде кнопка сознательно не появляется.
                          </p>
                        </>
                      )}

                      <div className="relative my-4">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-[#2a2a2a]"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-[#1a1a1a] px-2 text-[#666]">или</span>
                        </div>
                      </div>

                      <div className="text-xs text-[#888] uppercase tracking-wide font-medium mb-2">Через кошелёк</div>
                      <div className="space-y-2">
                        {connectors.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => {
                              connectAsync({ connector: c })
                                .then(() => setConnectPickerOpen(false))
                                .catch((e) => setToast(`Кошелёк не подключился: ${errorText(e)}`));
                            }}
                            disabled={isPending}
                            className="w-full flex items-center justify-between bg-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded px-4 py-3 transition-colors"
                          >
                            <span className="text-[#ccc] text-sm font-medium">{c.name}</span>
                            <ChevronRight className="w-4 h-4 text-[#666]" />
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-[#666] leading-relaxed font-mono">
                        Список — то, что реально нашлось в этом окне. QR-подключение (WalletConnect) появляется только когда фронт собран с{" "}
                        <code className="text-[#888]">VITE_WALLETCONNECT_PROJECT_ID</code>: без project id AppKit при старте ловит 400/403, поэтому
                        коннектор не добавляется.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="relative -mx-3 px-3 sm:mx-0 sm:px-0">
            <nav className="glass-panel flex items-center gap-1 overflow-x-auto pb-0.5 rounded-lg px-2 py-1 shadow-sm scrollbar-hide" aria-label="Основная навигация" style={{ WebkitOverflowScrolling: "touch" }}>
              <NavTab active={tab === "dashboard"} onClick={() => setTab("dashboard")} label="Обзор" live />
              <NavTab active={tab === "terminal"} onClick={() => setTab("terminal")} label="Терминал" live />
              <NavTab active={tab === "discover"} onClick={() => setTab("discover")} label="Discover" />
              <NavTab active={tab === "portfolio"} onClick={() => setTab("portfolio")} label="Портфель" />
              <NavTab active={tab === "earn"} onClick={() => setTab("earn")} label="Earn" />
              <NavTab active={tab === "predict"} onClick={() => setTab("predict")} label="Predict" />
              <NavTab active={tab === "agent"} onClick={() => setTab("agent")} label="Агент" />
              <NavTab active={tab === "risk"} onClick={() => setTab("risk")} label="Risk" />
              <NavTab active={tab === "funding"} onClick={() => setTab("funding")} label="Funding" />
            </nav>
          </div>
        </div>

        {backendChecked && !backend && (
          <div className="mb-5 terminal-panel rounded-lg px-4 py-3.5 animate-fade-in border border-[#2a2a2a] bg-gradient-to-r from-[#1a1a1a] to-[#141414]">
            <div className="flex items-start gap-3">
              <ServerOff className="w-4 h-4 text-[#ff6b35] shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm text-[#ccc] font-medium">
                  Бэкенд Wake не подключён
                </div>
                <p className="text-xs text-[#888] leading-relaxed mt-1.5 mb-2">
                  Сайт — статика на Cloudflare Pages, Wake-бэкенд — отдельный сервис. Сейчас работают панели, которые говорят с публичным API Lighter напрямую:
                  «Терминал» — стакан, свечи и лента сделок; «Funding» — ставки Lighter рядом с Binance, Bybit и Hyperliquid; «Портфель» —
                  позиции по адресу. Остальные хранят состояние в базе Wake — копи-трейд, Predict, агент, риск-расчёты и обзор рынка с
                  ранжированием по 24-часовому обороту.
                </p>
                <button
                  onClick={checkBackend}
                  className="text-xs text-[#ccc] hover:text-white border border-[#2a2a2a] hover:border-[#3a3a3a] rounded px-3 py-1.5 transition-all inline-flex items-center gap-1.5 hover:shadow-sm"
                >
                  <RefreshCw className="w-3 h-3" />
                  Проверить снова
                </button>
              </div>
            </div>
          </div>
        )}

        {backend && backend.network !== network && (
          <div className="mb-5 text-xs text-amber-300/90 leading-relaxed px-1">
            Бэкенд Wake работает в сети <code className="font-mono">{backend.network}</code>, а сайт переключён в{" "}
            <code className="font-mono">{network}</code>: обзор рынка, Predict и копи-трейд приходят из{" "}
            <code className="font-mono">{backend.network}</code> — сеть у бэкенда задаётся одной переменной{" "}
            <code className="font-mono">WAKE_LIGHTER_NETWORK</code> и не переключается с фронтенда.
          </div>
        )}

        {/* перемонтирование по сети: панели иначе держат данные со старой сети до следующего опроса */}
        <Suspense fallback={
          <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "16px" }}>
            <div style={{ display: "flex", gap: "12px" }}>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} style={{ flex: 1, height: "80px", background: "#111", borderRadius: "6px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
              <div style={{ height: "400px", background: "#111", borderRadius: "6px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
              <div style={{ height: "400px", background: "#111", borderRadius: "6px", animation: "wakeShimmer 1.6s ease-in-out infinite" }} />
            </div>
          </div>
        }>
          <div key={network}>
            {tab === "dashboard" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Dashboard. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Dashboard setTab={setTab} setAsset={setAsset} />
              </ErrorBoundary>
            )}

            {tab === "terminal" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Terminal. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Terminal
                  asset={asset}
                  setAsset={setAsset}
                  markets={markets}
                  dataError={dataError}
                  setToast={setToast}
                  isCopyable={isCopyable}
                  toggleCopyable={() => void toggleCopyable()}
                  setMarketPickerOpen={setMarketPickerOpen}
                  network={network}
                  accountEquityUsd={lighterAccount?.equityUsd}
                />
              </ErrorBoundary>
            )}

            {tab === "discover" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Discover. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Discover setCopyModal={setCopyModal} />
              </ErrorBoundary>
            )}

            {tab === "portfolio" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Portfolio. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Portfolio
                  following={following}
                  setTab={setTab}
                  togglePause={togglePause}
                  unfollow={unfollow}
                  followerId={followerId}
                  lighterAccountIndex={lighterAccountIndex}
                  hasWallet={!!address}
                  markets={markets}
                />
              </ErrorBoundary>
            )}

            {tab === "earn" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Earn. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Earn
                  isCopyable={isCopyable}
                  setTab={setTab}
                  leaderId={leaderId}
                  leaderFeeBps={leaderFeeBps}
                  setLeaderFeeBps={setLeaderFeeBps}
                  lighterAccountIndex={lighterAccountIndex}
                />
              </ErrorBoundary>
            )}

            {tab === "predict" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Predict. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Predict followerId={followerId} setToast={setToast} onConnect={() => setConnectPickerOpen(true)} />
              </ErrorBoundary>
            )}

            {tab === "agent" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Agent. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Agent
                  followerId={followerId}
                  subscription={subscription}
                  currentMarket={currentMarket}
                  setToast={setToast}
                  startTrial={() => void startTrial()}
                />
              </ErrorBoundary>
            )}

            {tab === "risk" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Risk. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Risk markets={markets} setToast={setToast} />
              </ErrorBoundary>
            )}

            {tab === "funding" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Funding. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Funding markets={markets} setToast={setToast} />
              </ErrorBoundary>
            )}
          </div>
        </Suspense>
      </div>

      {marketPickerOpen && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          onClick={() => setMarketPickerOpen(false)}
        >
          <div
            className="w-full max-w-md bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 flex flex-col"
            style={{ maxHeight: "min(560px, 85vh)", overflow: "hidden", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Выбор рынка</h3>
              <button onClick={() => setMarketPickerOpen(false)} className="text-[#666] hover:text-[#888]" aria-label="Закрыть">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={marketSearch}
              onChange={(e) => setMarketSearch(e.target.value)}
              placeholder="Поиск по символу…"
              autoFocus
              className="input-mono bg-[#141414] border border-[#2a2a2a] rounded px-3 py-2 mb-3 outline-none w-full"
            />
            <div className="flex gap-1.5 mb-3 overflow-x-auto">
              {(["Все", "Crypto", "Spot", "Stocks", "Forex", "Commodities"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setMarketCategory(c)}
                  className={`px-2.5 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${
                    marketCategory === c ? "bg-[#ff6b35] text-[#0a0a0a]" : "bg-[#141414] text-[#888] border border-[#2a2a2a]"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {filteredMarkets.length === 0 && <p className="text-[#666] text-sm text-center py-8 font-mono">Ничего не найдено</p>}
              {filteredMarkets.map((m) => (
                <button
                  key={m.market_id}
                  onClick={() => {
                    setAsset(m.symbol);
                    setMarketPickerOpen(false);
                    setMarketSearch("");
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded text-left transition-colors ${
                    m.symbol === asset ? "bg-[#141414] border border-[#ff6b35]" : "hover:bg-[#141414] border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[#ccc] text-sm font-medium font-mono">{m.symbol}</span>
                    <span className="text-[#666] text-xs">{categorizeMarket(m)}</span>
                  </div>
                  <span className="text-[#666] text-xs font-mono">{m.market_type}</span>
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
          <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div
                  className={`w-9 h-9 rounded-full ${avatarColor(copyModal.handle)} flex items-center justify-center text-sm font-bold text-white`}
                >
                  {shortHandle(copyModal.handle)}
                </div>
                <div>
                  <div className="text-white font-medium text-sm">{copyModal.handle}</div>
                  <div className="text-[#666] text-xs font-mono">Lighter #{copyModal.lighterAccountIndex}</div>
                </div>
              </div>
              <button onClick={() => setCopyModal(null)} className="text-[#666] hover:text-[#888]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 text-sm font-mono">
              <div>
                <div className="stat-label">Комиссия</div>
                <div className="text-[#ccc]">{(copyModal.feeBps / 100).toFixed(2)}% за сделку</div>
              </div>
              <div>
                <div className="stat-label">Реализованный PnL</div>
                <div className={copyModal.exchange ? (copyModal.exchange.realizedPnlUsd >= 0 ? "text-positive" : "text-negative") : "text-[#666]"}>
                  {copyModal.exchange ? `${copyModal.exchange.realizedPnlUsd >= 0 ? "+" : ""}${usd(copyModal.exchange.realizedPnlUsd, 0)}` : "нет ответа Lighter"}
                </div>
              </div>
              <div>
                <div className="stat-label">Подписчиков</div>
                <div className="text-[#ccc]">{fmt(copyModal.followers)}</div>
              </div>
              <div>
                <div className="stat-label">Открытых позиций</div>
                <div className="text-[#ccc]">{copyModal.exchange ? fmt(copyModal.exchange.openPositions.length) : "—"}</div>
              </div>
            </div>

            <label className="stat-label mb-1 block">Аллокация — сколько твоих денег участвует в копировании</label>
            <div className="flex items-center bg-[#141414] border border-[#2a2a2a] rounded px-3 py-2 mb-3">
              <span className="text-[#666] mr-1 font-mono text-sm">$</span>
              <input
                type="number"
                min={10}
                value={allocation}
                onChange={(e) => setAllocation(Number(e.target.value))}
                className="input-mono bg-transparent outline-none w-full"
              />
            </div>

            <div className="mb-4">
              <div className="flex justify-between mb-1">
                <span className="stat-label">Максимальное плечо по копии</span>
                <span className="stat-value text-sm">{copyLeverage}x</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                value={copyLeverage}
                onChange={(e) => setCopyLeverage(Number(e.target.value))}
                className="w-full accent-[#ff6b35]"
              />
            </div>

            <button
              onClick={() => void confirmCopy()}
              disabled={allocation <= 0}
              className="btn-action w-full bg-[#ff6b35] hover:bg-orange-500 disabled:opacity-50 text-[#0a0a0a] py-3 rounded"
            >
              Подписаться
            </button>
            <p className="text-xs text-[#666] mt-3 leading-relaxed font-mono">
              Подписка пишется в таблицу <code className="text-[#888]">follows</code> и становится входом для{" "}
              <code className="text-[#888]">mirror_engine</code>. Дальше всё зависит от того, как запущен{" "}
              <code className="text-[#888]">leader_listener.py</code>: по умолчанию <code className="text-[#888]">WAKE_DRY_RUN=true</code> —
              решение считается и пишется в <code className="text-[#888]">mirror_log</code> со статусом <code className="text-[#888]">dry_run</code>,
              ордер на Lighter не уходит. Каждый исход виден во вкладке «Портфель».
            </p>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 bg-[#1a1a1a] border rounded-full px-5 py-3 shadow-2xl flex items-center gap-3 z-50 sm:max-w-md animate-slide-up"
          style={{ borderColor: toast.variant === "error" ? "#ef4444" : toast.variant === "success" ? "#10b981" : "#3b82f6" }}
        >
          {toast.variant === "error" ? (
            <AlertTriangle className="w-4 h-4 text-[#ef4444] shrink-0" />
          ) : toast.variant === "success" ? (
            <Check className="w-4 h-4 text-[#10b981] shrink-0" />
          ) : (
            <Info className="w-4 h-4 text-[#3b82f6] shrink-0" />
          )}
          <span className="text-sm text-[#ccc]">{toast.msg}</span>
          <button
            onClick={() => setToastState(null)}
            className="ml-2 text-[#666] hover:text-[#ccc] transition-colors p-2 -m-2"
            aria-label="Закрыть уведомление"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
