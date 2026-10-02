import { useState, useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useEnsName } from "wagmi";
import { Zap, ChevronDown, ChevronRight, X, Check, ServerOff, RefreshCw } from "lucide-react";
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
  type LighterNetwork,
  type OrderBook,
} from "./lib/lighter";
import { BACKEND_URL, LIGHTER_NETWORK } from "./lib/config";
import { backendJson, errorText, probeBackend, type BackendHealth } from "./lib/backend";
import { NavTab } from "./components/ui";
import type { Tab } from "./components/types";
import { Dashboard } from "./components/Dashboard";
import { Terminal } from "./components/Terminal";
import { Discover } from "./components/Discover";
import { Portfolio } from "./components/Portfolio";
import { Earn } from "./components/Earn";
import { Predict } from "./components/Predict";
import { Agent } from "./components/Agent";
import { Risk } from "./components/Risk";
import { Funding } from "./components/Funding";
import { TelegramLogin, verifyTelegramLogin, type TelegramUser } from "./components/TelegramLogin";
import { connectTelegramMiniApp, isTelegramWebView, type TelegramProfile } from "./lib/telegram";
import { categorizeMarket, avatarColor, shortHandle, usd, fmt } from "./components/utils";
import type { Leader, Following, Subscription } from "./components/types";

export default function App() {
  const { address, isConnected } = useAccount();
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [tab, setTab] = useState<Tab>("dashboard");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [lighterAccount, setLighterAccount] = useState<any>(null);
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
            handle: r.leader_handle,
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

  const [toast, setToast] = useState<string | null>(null);

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
    if (!target) return;
    const next = !target.paused;
    setFollowing((f) => f.map((t) => (t.followId === followId ? { ...t, paused: next } : t)));
    setFollowPaused(followId, next).catch((e) => setToast(`Пауза не записана в базу: ${errorText(e)}`));
  }

  function unfollow(followId: string) {
    setFollowing((f) => f.filter((t) => t.followId !== followId));
    deleteFollow(followId).catch((e) => setToast(`Не удалось отписать: ${errorText(e)}`));
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

  const lighterAccountIndex: number | null = lighterAccount?.accounts?.[0]?.index ?? null;

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
      <div className="max-w-6xl mx-auto px-6 py-5">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center glow-cyan">
                <Zap className="w-5 h-5 text-white" strokeWidth={2.5} />
              </div>
              <span className="text-white font-bold tracking-tight text-xl gradient-text">Wake</span>
              <div className="flex rounded-full border border-slate-800 overflow-hidden">
                {(["mainnet", "testnet"] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => switchNetwork(n)}
                    title={n === "mainnet" ? "Реальные рынки Lighter, реальные цены" : "Тестовая сеть Lighter — тот же код, другие market ids"}
                    className={`px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide transition-colors ${
                      network === n ? "bg-slate-800 text-cyan-300" : "text-slate-500 hover:text-slate-300"
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
                  className="flex items-center gap-2 bg-slate-900 border border-slate-700 hover:border-slate-600 rounded-full pl-1.5 pr-3 py-1.5 text-sm text-slate-200 font-mono transition-colors"
                >
                  <span
                    className={`w-6 h-6 rounded-full ${
                      authSource === "telegram" ? "bg-sky-500" : "bg-emerald-500"
                    } flex items-center justify-center text-slate-950 text-xs font-bold`}
                  >
                    {(identityLabel ?? "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
                  </span>
                  {identityLabel ?? "Кошелёк подключён"}
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
                </button>
              ) : (
                <button onClick={() => setConnectPickerOpen(true)} className="btn-primary">
                  Войти через TG или кошелёк
                </button>
              )}

              {walletMenuOpen && (address || followerId) && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setWalletMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-72 glass rounded-2xl p-4 z-50 shadow-2xl animate-scale-in">
                    <div className="text-xs text-slate-500 mb-1">Вход через {authSource === "telegram" ? "Telegram" : "кошелёк"}</div>
                    <div className="text-sm text-slate-100 font-medium mb-3">{identityLabel ?? "—"}</div>
                    {address && (
                      <>
                        <div className="text-xs text-slate-500 mb-1">Ethereum-адрес</div>
                        <div className="text-sm text-slate-200 font-mono mb-3 break-all">{address}</div>
                      </>
                    )}
                    <div className="text-xs text-slate-400 mb-2">
                      {!address
                        ? "Кошелёк не подключён — позиции Lighter по адресу не видны, подключи его в этом меню."
                        : !lighterChecked
                        ? "Проверяю аккаунт на Lighter…"
                        : lighterAccountIndex != null
                        ? `Lighter account index: ${lighterAccountIndex}`
                        : "Аккаунт на Lighter не найден — зарегистрируйся на app.lighter.xyz"}
                    </div>
                    <div className="text-xs text-slate-500 mb-4 font-mono">
                      {followerId ? `follower_id: ${followerId}` : backendUp ? "" : "Бэкенд Wake не отвечает — подписки не запишутся"}
                    </div>
                    {backend && (
                      <div className="text-xs text-slate-600 mb-3 font-mono">
                        бэкенд: {backend.network} · {backend.dry_run ? "dry-run — ордера не отправляются" : "реальные ордера"}
                      </div>
                    )}
                    {address && !followerId && (
                      <button
                        onClick={() => setConnectPickerOpen(true)}
                        className="w-full text-center text-sm text-slate-200 border border-slate-700 rounded-xl py-2 mb-2 transition-colors glass-hover"
                      >
                        Войти через Telegram
                      </button>
                    )}
                    <button
                      onClick={signOut}
                      className="w-full text-center text-sm text-red-400 hover:text-red-300 border border-red-900/50 rounded-xl py-2 transition-colors glass-hover"
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
                  <div className="w-full max-w-sm glass rounded-2xl p-6 animate-scale-in" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-white font-semibold text-lg">Войти в Wake</h3>
                      <button onClick={() => setConnectPickerOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors">
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Через Telegram</div>
                      {isTelegramWebView() ? (
                        <>
                          <button
                            onClick={() => loginFromMiniApp(false)}
                            disabled={miniAppBusy}
                            className="btn-primary w-full"
                          >
                            {miniAppBusy ? "Проверяю initData…" : "Войти через Telegram"}
                          </button>
                          <p className="text-xs text-slate-600 leading-relaxed">
                            Страница открыта внутри Telegram, поэтому вход идёт по подписанной <code className="text-slate-400">initData</code>: её
                            целиком проверяет <code className="text-slate-400">POST /auth/telegram/init</code> на токене бота. Login-виджет здесь не
                            нужен — Telegram его в вебвью обычно не рендерит.
                          </p>
                        </>
                      ) : (
                        <>
                          <TelegramLogin onLogin={handleTelegramLogin} />
                          <p className="text-xs text-slate-600 leading-relaxed">
                            Виджет отдаёт подпись HMAC-SHA256; её проверяет <code className="text-slate-400">POST /auth/telegram</code> на токене бота, а
                            не браузер. Без <code className="text-slate-400">TELEGRAM_BOT_TOKEN</code> на бэкенде кнопка сознательно не появляется.
                          </p>
                        </>
                      )}

                      <div className="relative my-4">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-slate-700"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                          <span className="bg-slate-900/50 px-2 text-slate-500">или</span>
                        </div>
                      </div>

                      <div className="text-xs text-slate-400 uppercase tracking-wide font-medium mb-2">Через кошелёк</div>
                      <div className="space-y-2">
                        {connectors.map((c) => (
                          <button
                            key={c.id}
                            onClick={() => {
                              // connectAsync бросает ConnectorNotFoundError, если провайдера в
                              // этом окне нет (в вебвью Telegram — типичный случай). Молча
                              // закрыть пикер означало бы «кнопка не работает», поэтому
                              // причину показываем.
                              connectAsync({ connector: c })
                                .then(() => setConnectPickerOpen(false))
                                .catch((e) => setToast(`Кошелёк не подключился: ${errorText(e)}`));
                            }}
                            disabled={isPending}
                            className="w-full flex items-center justify-between glass-hover rounded-xl px-4 py-3"
                          >
                            <span className="text-slate-200 text-sm font-medium">{c.name}</span>
                            <ChevronRight className="w-4 h-4 text-slate-600" />
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed">
                        Список — то, что реально нашлось в этом окне. QR-подключение (WalletConnect) появляется только когда фронт собран с{" "}
                        <code className="text-slate-400">VITE_WALLETCONNECT_PROJECT_ID</code>: без project id AppKit при старте ловит 400/403, поэтому
                        коннектор не добавляется.
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="relative -mx-6 px-6 sm:mx-0 sm:px-0">
            <nav className="flex items-center gap-1 overflow-x-auto pb-0.5">
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
          <div className="mb-5 glass rounded-2xl px-4 py-3.5 animate-fade-in">
            <div className="flex items-start gap-3">
              <ServerOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-sm text-slate-100 font-medium">
                  Бэкенд Wake к <code className="text-slate-300 font-mono text-xs">{BACKEND_URL}</code> не подключён
                </div>
                <p className="text-xs text-slate-400 leading-relaxed mt-1.5 mb-2">
                  Сайт — статика на Cloudflare Pages, Wake-бэкенд (<code className="text-slate-500 font-mono">backend/app.py</code>) — отдельный
                  сервис, в сборку сайта он не входит. Сейчас работают панели, которые говорят с публичным API Lighter напрямую:
                  «Терминал» — стакан, свечи и лента сделок; «Funding» — ставки Lighter рядом с Binance, Bybit и Hyperliquid; «Портфель» —
                  позиции по адресу. Остальные хранят состояние в базе Wake — копи-трейд, Predict, агент, риск-расчёты и обзор рынка с
                  ранжированием по 24-часовому обороту. Поднять бэкенд локально: <code className="text-slate-500 font-mono">docker compose up app</code>.
                </p>
                <button
                  onClick={checkBackend}
                  className="text-xs text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 rounded-lg px-3 py-1.5 transition-colors inline-flex items-center gap-1.5"
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
        <div key={network}>
          {tab === "dashboard" && <Dashboard setTab={setTab} setAsset={setAsset} />}

          {tab === "terminal" && (
            <Terminal
              asset={asset}
              setAsset={setAsset}
              markets={markets}
              dataError={dataError}
              setToast={setToast}
              isCopyable={isCopyable}
              toggleCopyable={toggleCopyable}
              setMarketPickerOpen={setMarketPickerOpen}
              network={network}
            />
          )}

          {tab === "discover" && <Discover setCopyModal={setCopyModal} />}

          {tab === "portfolio" && (
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
          )}

          {tab === "earn" && (
            <Earn
              isCopyable={isCopyable}
              setTab={setTab}
              leaderId={leaderId}
              leaderFeeBps={leaderFeeBps}
              setLeaderFeeBps={setLeaderFeeBps}
              lighterAccountIndex={lighterAccountIndex}
            />
          )}

          {tab === "predict" && (
            <Predict followerId={followerId} setToast={setToast} onConnect={() => setConnectPickerOpen(true)} />
          )}

          {tab === "agent" && (
            <Agent
              followerId={followerId}
              subscription={subscription}
              currentMarket={currentMarket}
              setToast={setToast}
              startTrial={startTrial}
            />
          )}

          {tab === "risk" && <Risk markets={markets} setToast={setToast} />}

          {tab === "funding" && <Funding markets={markets} setToast={setToast} />}
        </div>
      </div>

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
                <div
                  className={`w-9 h-9 rounded-full ${avatarColor(copyModal.handle)} flex items-center justify-center text-sm font-bold text-white`}
                >
                  {shortHandle(copyModal.handle)}
                </div>
                <div>
                  <div className="text-white font-medium text-sm">{copyModal.handle}</div>
                  <div className="text-slate-500 text-xs font-mono">Lighter #{copyModal.lighterAccountIndex}</div>
                </div>
              </div>
              <button onClick={() => setCopyModal(null)} className="text-slate-500 hover:text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 text-sm font-mono">
              <div>
                <div className="text-xs text-slate-500">Комиссия</div>
                <div className="text-slate-200">{(copyModal.feeBps / 100).toFixed(2)}% за сделку</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Реализованный PnL</div>
                <div className={copyModal.exchange ? (copyModal.exchange.realizedPnlUsd >= 0 ? "text-emerald-400" : "text-red-400") : "text-slate-500"}>
                  {copyModal.exchange ? `${copyModal.exchange.realizedPnlUsd >= 0 ? "+" : ""}${usd(copyModal.exchange.realizedPnlUsd, 0)}` : "нет ответа Lighter"}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Подписчиков</div>
                <div className="text-slate-200">{fmt(copyModal.followers)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500">Открытых позиций</div>
                <div className="text-slate-200">{copyModal.exchange ? fmt(copyModal.exchange.openPositions.length) : "—"}</div>
              </div>
            </div>

            <label className="text-xs text-slate-400 mb-1 block">Аллокация — сколько твоих денег участвует в копировании</label>
            <div className="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 mb-3">
              <span className="text-slate-500 mr-1">$</span>
              <input
                type="number"
                min={10}
                value={allocation}
                onChange={(e) => setAllocation(Number(e.target.value))}
                className="bg-transparent text-white font-mono outline-none w-full"
              />
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Максимальное плечо по копии</span>
                <span className="font-mono text-slate-200">{copyLeverage}x</span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                value={copyLeverage}
                onChange={(e) => setCopyLeverage(Number(e.target.value))}
                className="w-full accent-cyan-500"
              />
            </div>

            <button
              onClick={confirmCopy}
              disabled={allocation <= 0}
              className="w-full bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold rounded-xl py-3 transition-colors"
            >
              Подписаться
            </button>
            <p className="text-xs text-slate-500 mt-3 leading-relaxed">
              Подписка пишется в таблицу <code className="text-slate-400">follows</code> и становится входом для{" "}
              <code className="text-slate-400">mirror_engine</code>. Дальше всё зависит от того, как запущен{" "}
              <code className="text-slate-400">leader_listener.py</code>: по умолчанию <code className="text-slate-400">WAKE_DRY_RUN=true</code> —
              решение считается и пишется в <code className="text-slate-400">mirror_log</code> со статусом <code className="text-slate-400">dry_run</code>,
              ордер на Lighter не уходит. Каждый исход виден во вкладке «Портфель».
            </p>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 glass rounded-full px-5 py-3 shadow-2xl flex items-center gap-2 z-50 max-w-md text-center animate-slide-up glow-cyan">
          <Check className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="text-sm text-slate-100">{toast}</span>
        </div>
      )}
    </div>
  );
}
