import { useState, useEffect, useEffectEvent, lazy, Suspense } from "react";
import { useAccount, useConnect, useDisconnect, useEnsName, useSignMessage } from "wagmi";
import { Zap, ChevronDown, ChevronRight, X, Check, ServerOff, RefreshCw, AlertTriangle, Info } from "lucide-react";
import {
  getOrderBooks,
  getAccountByL1Address,
  listOwnFollows,
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
import { setNetwork as setArcusNetwork } from "./lib/arcus";
import { backendJson, errorText, probeBackend, SIGNED_OUT_EVENT, type BackendHealth } from "./lib/backend";
import { clearSession, getSession, saveSession, type Session, type SignInResponse } from "./lib/session";
import { verifyWalletOwnership } from "./lib/wallet";
import { Modal, NavTab, ToastProvider } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { Tab } from "./components/types";
import { TelegramLogin } from "./components/TelegramLogin";
import { connectTelegramMiniApp, isTelegramWebView, miniAppDisplayName, verifyTelegramLogin, type TelegramUser } from "./lib/telegram";
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
  const { signMessageAsync } = useSignMessage();

  const [tab, setTab] = useState<Tab>("dashboard");
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [accountResult, setAccountResult] = useState<{ key: string; account: LighterAccount | null } | null>(null);

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

  // Единственный источник «кто сейчас в сайте». Читается из хранилища при первом
  // рендере: токен переживает перезагрузку страницы, а 401 от бэкенда его стирает.
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [backend, setBackend] = useState<BackendHealth | null>(null);
  const [backendChecked, setBackendChecked] = useState(false);
  const [miniAppBusy, setMiniAppBusy] = useState(() => isTelegramWebView());
  const [walletBusy, setWalletBusy] = useState(false);
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [leaderFeeBps, setLeaderFeeBps] = useState(8);
  const [subscription, setSubscription] = useState<Subscription | null>(null);

  const accountKey = `${network}:${address ?? ""}`;
  const lighterAccount = accountResult?.key === accountKey ? accountResult.account : null;
  const lighterChecked = !!address && accountResult?.key === accountKey;
  const userId = session?.userId ?? null;
  const signedIn = session !== null;
  const backendUp = backend !== null;

  function checkBackend() {
    setBackendChecked(false);
    probeBackend()
      .then(setBackend)
      .catch(() => setBackend(null))
      .finally(() => setBackendChecked(true));
  }

  useEffect(() => {
    probeBackend().then(setBackend).catch(() => setBackend(null)).finally(() => setBackendChecked(true));
  }, []);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    listOwnFollows()
      .then((rows) => {
        if (!live) return;
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
      .catch(() => { if (live) setFollowing([]); });
    return () => { live = false; };
  }, [userId]);

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
    if (!address) return;
    let live = true;
    getAccountByL1Address(address)
      .then((account) => { if (live) setAccountResult({ key: accountKey, account }); })
      .catch(() => { if (live) setAccountResult({ key: accountKey, account: null }); });
    return () => { live = false; };
  }, [address, accountKey]);

  useEffect(() => {
    let live = true;
    function load() {
      getOrderBooks("all")
        .then((rows) => { if (live) { setMarkets(rows); setDataError(null); } })
        .catch((e) => { if (live) setDataError(errorText(e)); });
    }
    load();
    const id = setInterval(load, 15000);
    return () => { live = false; clearInterval(id); };
  }, [network]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setConnectPickerOpen(false);
        setMarketPickerOpen(false);
        setWalletMenuOpen(false);
        setCopyModal(null);
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
    setArcusNetwork(next);
    setMarkets([]);
    setDataError(null);
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

  // Три входа сходятся в одну точку. Личность определяет ответ бэкенда,
  // проверившего подпись (Telegram-виджет, initData мини-аппа, подпись кошелька),
  // а label — только надпись в шапке: по ней ничего не разрешается.
  function applySignIn(res: SignInResponse, via: "wallet" | "telegram", label: string | null) {
    setSession(saveSession(res, { via, label }));
    setFollowing([]);
    setSubscription(null);
    setLeaderId(null);
    setIsCopyable(false);
    setCopyModal(null);
    setConnectPickerOpen(false);
  }

  async function handleTelegramLogin(user: TelegramUser) {
    try {
      const res = await verifyTelegramLogin(user);
      applySignIn(res, "telegram", user.username ? `@${user.username}` : user.first_name);
      setToast(`Добро пожаловать, ${user.first_name}!`);
    } catch (e) {
      setToast(`Telegram не подтвердил вход: ${errorText(e)}`);
    }
  }

  async function loginFromMiniApp() {
    setMiniAppBusy(true);
    try {
      const res = await connectTelegramMiniApp();
      if (res) {
        const tg = miniAppDisplayName();
        const label = tg ? (tg.username ? `@${tg.username}` : tg.first_name) : null;
        applySignIn(res, "telegram", label);
        setToast(`Вошёл как ${label ?? res.user_id}`);
      } else {
        setToast("Telegram не передал подписанную initData — войди через виджет или кошелёк");
      }
    } catch (e) {
      setToast(`Telegram не подтвердил вход: ${errorText(e)}`);
    } finally {
      setMiniAppBusy(false);
    }
  }

  // Кошелёк подключён — это ещё не вход: адрес в браузере может назвать любой.
  // Входом становится только подпись challenge, которую бэкенд восстановил в адрес.
  async function signInWithWallet() {
    if (!address) {
      setToast("Сначала подключи кошелёк");
      return;
    }
    setWalletBusy(true);
    const label = ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}`;
    try {
      const res = await verifyWalletOwnership(address, (message) => signMessageAsync({ message }));
      applySignIn(res, "wallet", label);
      setToast(
        res.lighter_account_index == null
          ? `Кошелёк подтверждён: ${label}. Аккаунт Lighter по нему не найден — публикации лидера не будет`
          : `Кошелёк подтверждён: ${label}, Lighter #${res.lighter_account_index}`
      );
    } catch (e) {
      setToast(`Кошелёк не подтверждён: ${errorText(e)}`);
    } finally {
      setWalletBusy(false);
    }
  }

  const onAutoLogin = useEffectEvent((res: SignInResponse | null) => {
    if (res) {
      const tg = miniAppDisplayName();
      applySignIn(res, "telegram", tg ? (tg.username ? `@${tg.username}` : tg.first_name) : null);
    }
    setMiniAppBusy(false);
  });
  const onAutoLoginError = useEffectEvent((error: unknown) => {
    setToast(`Telegram не подтвердил вход: ${errorText(error)}`);
    setMiniAppBusy(false);
  });

  useEffect(() => {
    if (!isTelegramWebView()) return;
    let live = true;
    connectTelegramMiniApp()
      .then((res) => { if (live) onAutoLogin(res); })
      .catch((error) => { if (live) onAutoLoginError(error); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    // 401 из backendJson означает «этот токен больше не действителен», и приложение
    // обязано показать не пустые панели, а предложение войти заново.
    function onSignedOut() {
      setSession(null);
      setFollowing([]);
      setSubscription(null);
      setIsCopyable(false);
      setLeaderId(null);
    }
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  function signOut() {
    // Отзыва на сервере нет (токен подписан и живёт свой срок), поэтому выход
    // честен ровно на этом устройстве: здесь его перестают принимать за тебя.
    clearSession();
    if (isConnected) disconnect();
    setSession(null);
    setFollowing([]);
    setSubscription(null);
    setIsCopyable(false);
    setLeaderId(null);
    setWalletMenuOpen(false);
  }

  async function confirmCopy() {
    if (!copyModal) return;
    if (!signedIn) {
      setToast("Сначала войди через Telegram или кошелёк — подписка пишется на твой аккаунт");
      return;
    }
    try {
      const followId = await createFollow(copyModal.id, allocation, copyLeverage);
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

  // Переключение применяется к списку только после ответа бэкенда: пауза, которую
  // база не приняла, не должна выглядеть записанной.
  function togglePause(followId: string) {
    const target = following.find((t) => t.followId === followId);
    if (!target || !userId) return;
    const next = !target.paused;
    setFollowPaused(followId, next)
      .then(() => setFollowing((f) => f.map((t) => (t.followId === followId ? { ...t, paused: next } : t))))
      .catch((e) => setToast(`Пауза не записана в базу: ${errorText(e)}`));
  }

  function unfollow(followId: string) {
    if (!userId) return;
    deleteFollow(followId)
      .then(() => setFollowing((f) => f.filter((t) => t.followId !== followId)))
      .catch((e) => setToast(`Не удалось отписать: ${errorText(e)}`));
  }

  async function toggleCopyable() {
    if (isCopyable) {
      setIsCopyable(false);
      setLeaderId(null);
      return;
    }
    // Переключатель не включается, пока публикация заранее обречена: бэкенд берёт
    // индекс Lighter из своей записи, а не из тела запроса.
    if (!signedIn) {
      setToast("Лидер публикуется на подтверждённый вход — войди через Telegram или кошелёк");
      return;
    }
    if (!backendUp) {
      setToast("Бэкенд не отвечает — подписки не запишутся");
      return;
    }
    if (session?.lighterAccountIndex == null) {
      setToast("Нужен индекс аккаунта Lighter: подтверди вход кошельком в меню профиля");
      return;
    }
    setIsCopyable(true);
    try {
      const id = await registerLeader(identityLabel ?? userId ?? "wake", leaderFeeBps);
      setLeaderId(id);
      setToast(`Стал лидером: индекс Lighter #${session.lighterAccountIndex}, комиссия ${(leaderFeeBps / 100).toFixed(2)}% за сделку`);
    } catch (e) {
      setIsCopyable(false);
      setToast(`Не удалось записаться в leaders: ${errorText(e)}`);
    }
  }

  const lighterAccountIndex: number | null = lighterAccount?.accountIndex ?? null;

  // Субъект здесь — токен: /subscription и /subscription/trial не берут id ни из
  // пути, ни из тела. Смена входа (или 401) перечитывает подписку заново.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    backendJson<Subscription>("/subscription")
      .then((data) => { if (live) setSubscription(data); })
      .catch(() => { if (live) setSubscription(null); });
    return () => { live = false; };
  }, [userId]);

  async function startTrial() {
    if (!userId) {
      setToast("Сначала войди через Telegram или кошелёк");
      return;
    }
    try {
      await backendJson("/subscription/trial", { method: "POST" });
      setSubscription(await backendJson<Subscription>("/subscription"));
      setToast("Пробный период начат — 14 дней");
    } catch (e) {
      setToast(`Бэкенд не отвечает: ${errorText(e)}`);
    }
  }

  const identityLabel = session?.label ?? (address ? ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}` : null);
  const toastView = toast && (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 bg-[#1a1a1a] border rounded-full px-5 py-3 shadow-2xl flex items-center gap-3 z-50 sm:max-w-md animate-fade-in"
      style={{ borderColor: toast.variant === "error" ? "#ef4444" : toast.variant === "success" ? "#10b981" : "#3b82f6" }}
    >
      {toast.variant === "error" ? <AlertTriangle className="w-4 h-4 text-[#ef4444] shrink-0" />
        : toast.variant === "success" ? <Check className="w-4 h-4 text-[#10b981] shrink-0" />
        : <Info className="w-4 h-4 text-[#3b82f6] shrink-0" />}
      <span className="text-sm text-[#ccc]">{toast.msg}</span>
      <button onClick={() => setToastState(null)} className="ml-2 text-[color:var(--text-muted)] hover:text-[#ccc] transition-colors p-2 -m-2" aria-label="Закрыть уведомление">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <ToastProvider toast={toastView}>
    <div className="min-h-screen w-full font-sans">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5">
        <div className="mb-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-[5px] bg-[var(--accent)] flex items-center justify-center">
                  <Zap className="w-4 h-4 text-[#0a0a0a]" strokeWidth={2.5} />
                </div>
                <span className="text-[17px] font-bold tracking-[-0.02em] text-[var(--fg)]">Wake</span>
              </div>

              <div className="seg" role="group" aria-label="Сеть Lighter и Arcus">
                {(["mainnet", "testnet"] as const).map((n) => (
                  <button
                    key={n}
                    onClick={() => switchNetwork(n)}
                    aria-pressed={network === n}
                    title={n === "mainnet" ? "Реальные рынки Lighter и Arcus, реальные цены" : "Тестовая сеть — тот же код, другие market ids"}
                    className="font-mono uppercase tracking-[0.06em]"
                  >
                    {n}
                  </button>
                ))}
              </div>

              <div className="hidden md:flex items-center gap-1.5">
                <span className="chip">Lighter</span>
                <span className="chip">Arcus</span>
                <span
                  className={backend ? (backend.dry_run ? "chip chip-warn" : "chip chip-down") : "chip chip-info"}
                  title={backend ? "Сеть бэкенда и режим отправки ордеров" : "Панели, которым нужна база, сейчас не работают"}
                >
                  {backend ? `бэкенд · ${backend.network} · ${backend.dry_run ? "dry-run" : "live"}` : backendChecked ? "бэкенд недоступен" : "бэкенд: проверяю…"}
                </span>
              </div>
            </div>

            <div className="relative">
              {signedIn || address ? (
                <button
                  onClick={() => setWalletMenuOpen((v) => !v)}
                  aria-expanded={walletMenuOpen}
                  className="btn-ghost !py-1.5 !pl-1.5 font-mono"
                >
                  <span
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[#0a0a0a] text-[10px] font-bold ${
                      session?.via === "telegram" ? "bg-[var(--accent)]" : "bg-[var(--up)]"
                    }`}
                  >
                    {(identityLabel ?? "?").replace(/^@/, "").slice(0, 1).toUpperCase()}
                  </span>
                  {identityLabel ?? "Кошелёк подключён"}
                  {!signedIn && <span className="w-1.5 h-1.5 rounded-full bg-[var(--warn)]" title="Вход не подтверждён" />}
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--fg-3)]" />
                </button>
              ) : (
                <button onClick={() => setConnectPickerOpen(true)} className="btn-primary">
                  Войти через TG или кошелёк
                </button>
              )}

              {walletMenuOpen && (signedIn || address) && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setWalletMenuOpen(false)} />
                  <div className="absolute right-0 mt-2 w-72 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 z-50 shadow-2xl animate-fade-in">
                    <div className="text-xs text-[color:var(--text-muted)] mb-1">
                      {signedIn ? `Вход через ${session?.via === "telegram" ? "Telegram" : "кошелёк"}` : "Кошелёк подключён, вход не подтверждён"}
                    </div>
                    <div className="text-sm text-[#ccc] font-medium mb-3">{identityLabel ?? "—"}</div>
                    {address && (
                      <>
                        <div className="text-xs text-[color:var(--text-muted)] mb-1">Ethereum-адрес</div>
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
                    <div className="text-xs text-[color:var(--text-muted)] mb-4 font-mono">
                      {session
                        ? `user_id: ${session.userId}`
                        : backendUp
                        ? "Бэкенд не подписывает вход по одному подключённому адресу."
                        : "Бэкенд Wake не отвечает — подписки не запишутся"}
                    </div>
                    {backend && (
                      <div className="text-xs text-[color:var(--text-muted)] mb-3 font-mono">
                        бэкенд: {backend.network} · {backend.dry_run ? "dry-run — ордера не отправляются" : "реальные ордера"}
                      </div>
                    )}
                    {address && session?.via !== "wallet" && (
                      <>
                        <button
                          onClick={() => void signInWithWallet()}
                          disabled={walletBusy}
                          className="w-full text-center text-sm text-[#0a0a0a] bg-[#10b981] hover:bg-emerald-400 disabled:opacity-50 rounded py-2 mb-2 transition-colors"
                        >
                          {walletBusy ? "Жду подпись в кошельке…" : "Подписать вход кошельком"}
                        </button>
                        <div className="text-xs text-[color:var(--text-muted)] leading-relaxed mb-3 font-mono">
                          Это другой аккаунт Wake: бэкенд заводит запись по адресу, поэтому подписки Telegram-входа здесь не появятся. Нужен он для
                          публикации лидера — индекс Lighter берётся из подтверждённого адреса.
                        </div>
                      </>
                    )}
                    {!signedIn && (
                      <button
                        onClick={() => setConnectPickerOpen(true)}
                        className="w-full text-center text-sm text-[#ccc] border border-[#2a2a2a] rounded py-2 mb-2 transition-colors hover:bg-[#141414]"
                      >
                        Войти через Telegram
                      </button>
                    )}
                    {signedIn ? (
                      <button
                        onClick={signOut}
                        className="w-full text-center text-sm text-[#ef4444] hover:text-red-400 border border-red-900/50 rounded py-2 transition-colors hover:bg-[#141414]"
                      >
                        Выйти
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          disconnect();
                          setWalletMenuOpen(false);
                        }}
                        className="w-full text-center text-sm text-[#888] hover:text-[#ccc] border border-[#2a2a2a] rounded py-2 transition-colors hover:bg-[#141414]"
                      >
                        Отключить кошелёк
                      </button>
                    )}
                  </div>
                </>
              )}

              {connectPickerOpen && (
                <Modal label="Войти в Wake" onClose={() => setConnectPickerOpen(false)}>
                  <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-6 max-h-[85dvh] overflow-y-auto animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-5">
                      <h3 className="text-white font-semibold text-lg">Войти в Wake</h3>
                      <button onClick={() => setConnectPickerOpen(false)} className="text-[color:var(--text-muted)] hover:text-[#888] transition-colors" aria-label="Закрыть">
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    <div className="space-y-3">
                      <div className="text-xs text-[#888] uppercase tracking-wide font-medium mb-2">Через Telegram</div>
                      {isTelegramWebView() ? (
                        <>
                          <button
                            onClick={() => {
                              void loginFromMiniApp();
                            }}
                            disabled={miniAppBusy}
                            className="btn-action w-full bg-[#ff6b35] hover:bg-[#ff8c5a] text-[#0a0a0a]"
                          >
                            {miniAppBusy ? "Проверяю initData…" : "Войти через Telegram"}
                          </button>
                          <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                            Страница открыта внутри Telegram, поэтому вход идёт по подписанной <code className="text-[#888]">initData</code>: её
                            целиком проверяет <code className="text-[#888]">POST /auth/telegram/init</code> на токене бота. Login-виджет здесь не
                            нужен — Telegram его в вебвью обычно не рендерит.
                          </p>
                        </>
                      ) : (
                        <>
                          <TelegramLogin onLogin={(u) => void handleTelegramLogin(u)} />
                          <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
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
                          <span className="bg-[#1a1a1a] px-2 text-[color:var(--text-muted)]">или</span>
                        </div>
                      </div>

                      <div className="text-xs text-[#888] uppercase tracking-wide font-medium mb-2">Через кошелёк</div>
                      {address ? (
                        <>
                          <button
                            onClick={() => void signInWithWallet()}
                            disabled={walletBusy}
                            className="w-full flex items-center justify-between bg-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] disabled:opacity-50 rounded px-4 py-3 transition-colors"
                          >
                            <span className="text-[#ccc] text-sm font-medium">{walletBusy ? "Жду подпись в кошельке…" : "Подписать вход кошельком"}</span>
                            <span className="text-[color:var(--text-muted)] text-xs font-mono">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
                          </button>
                          <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                            Одного подключённого адреса мало: его может назвать любой. Бэкенд выдаёт одноразовый текст, кошелёк подписывает его по{" "}
                            <code className="text-[#888]">personal_sign</code>, а <code className="text-[#888]">POST /auth/wallet/verify</code>{" "}
                            восстанавливает из подписи адрес и сверяет с заявленным.
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="space-y-2">
                            {connectors.map((c) => (
                              <button
                                key={c.id}
                                onClick={() => {
                                  connectAsync({ connector: c }).catch((e) => setToast(`Кошелёк не подключился: ${errorText(e)}`));
                                }}
                                disabled={isPending}
                                className="w-full flex items-center justify-between bg-[#141414] border border-[#2a2a2a] hover:border-[#3a3a3a] rounded px-4 py-3 transition-colors"
                              >
                                <span className="text-[#ccc] text-sm font-medium">{c.name}</span>
                                <ChevronRight className="w-4 h-4 text-[color:var(--text-muted)]" />
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                            Список — то, что реально нашлось в этом окне. QR-подключение (WalletConnect) появляется только когда фронт собран с{" "}
                            <code className="text-[#888]">VITE_WALLETCONNECT_PROJECT_ID</code>: без project id AppKit при старте ловит 400/403, поэтому
                            коннектор не добавляется. После подключения здесь же появится шаг с подписью.
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                </Modal>
              )}
            </div>
          </div>

          <div className="relative -mx-3 px-3 sm:mx-0 sm:px-0">
            <nav className="flex items-center gap-0.5 overflow-x-auto border-b border-[var(--line)] px-1 scrollbar-hide" aria-label="Основная навигация" style={{ WebkitOverflowScrolling: "touch" }}>
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
          <div className="notice animate-fade-in">
            <ServerOff className="w-3.5 h-3.5 shrink-0" />
            <span>
              Бэкенд Wake недоступен: работают Терминал, Funding и Портфель — они читают публичный API Lighter.
              Копи-трейд, Predict, агент и обзор рынка хранят состояние в базе Wake.
            </span>
            <details className="notice-more">
              <summary>Почему так</summary>
              <p>
                Сайт — статика на Cloudflare Pages, Wake-бэкенд — отдельный сервис: он подписывает ордера,
                ведёт базу и проверяет вход. Без него панели, которым нужна база, честно показывают эту строку,
                а не пустые таблицы.
              </p>
            </details>
            <button onClick={checkBackend} className="btn-ghost shrink-0">
              <RefreshCw className="w-3 h-3" />
              Проверить
            </button>
          </div>
        )}

        {backend && backend.network !== network && (
          <div className="notice notice-warn animate-fade-in">
            <span>
              Бэкенд работает в сети <code className="num">{backend.network}</code>, а сайт переключён в{" "}
              <code className="num">{network}</code>: обзор рынка, Predict и копи-трейд приходят из{" "}
              <code className="num">{backend.network}</code>. Сеть у бэкенда задаёт{" "}
              <code className="num">WAKE_LIGHTER_NETWORK</code>, с фронтенда она не переключается.
            </span>
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
                <Dashboard key={network} setTab={setTab} setAsset={setAsset} />
              </ErrorBoundary>
            )}

            {tab === "terminal" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Terminal. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Terminal
                  key={`${network}:${asset}:${currentMarket?.market_id}`}
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
                  key={`${userId}:${network}:${lighterAccountIndex}`}
                  following={following}
                  setTab={setTab}
                  togglePause={togglePause}
                  unfollow={unfollow}
                  signedIn={signedIn}
                  lighterAccountIndex={lighterAccountIndex}
                  hasWallet={!!address}
                  markets={markets}
                />
              </ErrorBoundary>
            )}

            {tab === "earn" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Earn. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Earn
                  key={leaderId ?? "no-leader"}
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
                <Predict key={userId ?? "signed-out"} signedIn={signedIn} setToast={setToast} onConnect={() => setConnectPickerOpen(true)} />
              </ErrorBoundary>
            )}

            {tab === "agent" && (
              <ErrorBoundary fallback={<div style={{ padding: "24px", color: "#ef4444" }}>Ошибка загрузки Agent. <button onClick={() => window.location.reload()} style={{ color: "#3b82f6", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Обновить</button></div>}>
                <Agent
                  key={`${userId}:${network}:${asset}`}
                  signedIn={signedIn}
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
        <Modal label="Выбор рынка" onClose={() => setMarketPickerOpen(false)}>
          <div
            className="w-full max-w-md bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4 flex flex-col"
            style={{ maxHeight: "min(560px, 85dvh)", overflow: "hidden", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold text-sm">Выбор рынка</h3>
              <button onClick={() => setMarketPickerOpen(false)} className="text-[color:var(--text-muted)] hover:text-[#888]" aria-label="Закрыть">
                <X className="w-5 h-5" />
              </button>
            </div>
            <input
              type="text"
              value={marketSearch}
              onChange={(e) => setMarketSearch(e.target.value)}
              placeholder="Поиск по символу…"
              aria-label="Поиск рынка"
              data-autofocus=""
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
              {filteredMarkets.length === 0 && <p className="text-[color:var(--text-muted)] text-sm text-center py-8 font-mono">Ничего не найдено</p>}
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
                    <span className="text-[color:var(--text-muted)] text-xs">{categorizeMarket(m)}</span>
                  </div>
                  <span className="text-[color:var(--text-muted)] text-xs font-mono">{m.market_type}</span>
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {copyModal && (
        <Modal label={`Копировать ${copyModal.handle}`} onClose={() => setCopyModal(null)}>
          <div className="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-5 max-h-[85dvh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div
                  className={`w-9 h-9 rounded-full ${avatarColor(copyModal.handle)} flex items-center justify-center text-sm font-bold text-white`}
                >
                  {shortHandle(copyModal.handle)}
                </div>
                <div>
                  <div className="text-white font-medium text-sm">{copyModal.handle}</div>
                  <div className="text-[color:var(--text-muted)] text-xs font-mono">Lighter #{copyModal.lighterAccountIndex}</div>
                </div>
              </div>
              <button onClick={() => setCopyModal(null)} className="text-[color:var(--text-muted)] hover:text-[#888]" aria-label="Закрыть">
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
                <div className={copyModal.exchange ? (copyModal.exchange.realizedPnlUsd >= 0 ? "text-positive" : "text-negative") : "text-[color:var(--text-muted)]"}>
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

            <label htmlFor="copy-allocation" className="stat-label mb-1 block">Аллокация — сколько твоих денег участвует в копировании</label>
            <div className="flex items-center bg-[#141414] border border-[#2a2a2a] rounded px-3 py-2 mb-3">
              <span className="text-[color:var(--text-muted)] mr-1 font-mono text-sm">$</span>
              <input
                id="copy-allocation"
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
                aria-label="Максимальное плечо по копии"
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
              className="btn-action w-full bg-[#ff6b35] hover:bg-[#ff8c5a] disabled:opacity-50 text-[#0a0a0a] py-3 rounded"
            >
              Подписаться
            </button>
            <p className="text-xs text-[color:var(--text-muted)] mt-3 leading-relaxed font-mono">
              Подписка пишется в таблицу <code className="text-[#888]">follows</code> и становится входом для{" "}
              <code className="text-[#888]">mirror_engine</code>. Дальше всё зависит от того, как запущен{" "}
              <code className="text-[#888]">leader_listener.py</code>: по умолчанию <code className="text-[#888]">WAKE_DRY_RUN=true</code> —
              решение считается и пишется в <code className="text-[#888]">mirror_log</code> со статусом <code className="text-[#888]">dry_run</code>,
              ордер на Lighter не уходит. Каждый исход виден во вкладке «Портфель».
            </p>
          </div>
        </Modal>
      )}

      {!connectPickerOpen && !marketPickerOpen && !copyModal && toastView}
    </div>
    </ToastProvider>
  );
}
