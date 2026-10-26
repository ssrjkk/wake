import {
  useState,
  useEffect,
  useEffectEvent,
  useRef,
  lazy,
  Suspense,
} from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useEnsName,
  useSignMessage,
} from "wagmi";
import {
  Zap,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  ServerOff,
  RefreshCw,
  AlertTriangle,
  Info,
  MessageSquareText,
} from "lucide-react";
import {
  getOrderBooks,
  getAccountByL1Address,
  listOwnFollows,
  createFollow,
  setFollowPaused,
  deleteFollow,
  registerLeader,
  getMyLeader,
  setLeaderActive,
  setNetwork as setLighterNetwork,
  type LighterAccount,
  type LighterNetwork,
  type OrderBook,
} from "./lib/lighter";
import { LIGHTER_NETWORK, TELEGRAM_BOT_NAME } from "./lib/config";
import { readEntryFromSearch } from "./lib/deeplink";
import { useRowWindow } from "./lib/useRowWindow";
import { TABS } from "./lib/tabs";
import { setNetwork as setArcusNetwork } from "./lib/arcus";
import {
  backendJson,
  errorText,
  probeBackend,
  SIGNED_OUT_EVENT,
  type BackendHealth,
} from "./lib/backend";
import {
  clearSession,
  getSession,
  saveSession,
  type Session,
  type SignInResponse,
} from "./lib/session";
import { verifyWalletOwnership } from "./lib/wallet";
import { closeTopLayer, onLayerDepth } from "./lib/layers";
import { Modal, NavTab, ToastProvider } from "./components/ui";
import { ErrorBoundary } from "./components/ErrorBoundary";
import type { Tab } from "./components/types";
import { TelegramLogin } from "./components/TelegramLogin";
import {
  connectTelegramMiniApp,
  ensureTelegramChrome,
  isTelegramWebView,
  miniAppDisplayName,
  openExternally,
  setTelegramBackHandler,
  telegramNotify,
  verifyTelegramLogin,
  type TelegramUser,
} from "./lib/telegram";
import {
  categorizeMarket,
  avatarColor,
  shortHandle,
  toastVariant,
  usd,
  fmt,
} from "./components/utils";
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

// Вкладки, которым нужна книга Lighter: Терминал и Портфель (символы и decimals
// строк), Risk и Funding (отбор кандидатов и спот-ноги), Агент (currentMarket).
// Обзор, Discover, Earn и Predict её не читают — там свои источники.
const MARKETS_TABS: readonly Tab[] = [
  "terminal",
  "portfolio",
  "risk",
  "funding",
  "agent",
];

// Шаг строки окна выбора рынка: 46 px самой строки (.picker-row) плюс 4 px
// зазора (.picker-list). Виртуализация считает позиции арифметикой, поэтому
// высота обязана быть одной и той же с обеих сторон — проверяется гейтом
// e2e/render-budget.spec.ts, который меряет смещение последней видимой строки.
const PICKER_ROW_PITCH = 50;

export default function App() {
  const { address, isConnected } = useAccount();
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();

  /* Точка входа: ?tab=…&asset=… (ссылка из Telegram-бота или расшаренный экран).
     Считается один раз до рендера — иначе переключение вкладок затрёт то, с чего
     начали. */
  const [entry] = useState(() =>
    readEntryFromSearch(window.location.search, {
      tab: "dashboard",
      asset: "BTC",
      market: null,
    }),
  );
  const [tab, setTab] = useState<Tab>(entry.tab);
  const navRef = useRef<HTMLElement>(null);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [connectPickerOpen, setConnectPickerOpen] = useState(false);
  const [accountResult, setAccountResult] = useState<{
    key: string;
    account: LighterAccount | null;
  } | null>(null);

  const [asset, setAsset] = useState<string>(entry.asset);
  const [network, setNetwork] = useState<LighterNetwork>(LIGHTER_NETWORK);
  const [marketPickerOpen, setMarketPickerOpen] = useState(false);
  const [marketSearch, setMarketSearch] = useState("");
  const [marketCategory, setMarketCategory] = useState<string>("Все");
  const [markets, setMarkets] = useState<OrderBook[]>([]);
  const [dataError, setDataError] = useState<string | null>(null);
  const [isCopyable, setIsCopyable] = useState(false);
  const [copySwitchBusy, setCopySwitchBusy] = useState(false);
  const [following, setFollowing] = useState<Following[]>([]);
  // «Нет подписок» и «бэкенд не отдал подписки» — разные ответы: во втором
  // Portfolio печатал бы пустой список, и человек подписался бы второй раз,
  // получив 409 вместо объяснения.
  const [followsError, setFollowsError] = useState<string | null>(null);
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
  const lighterAccount =
    accountResult?.key === accountKey ? accountResult.account : null;
  const lighterChecked = !!address && accountResult?.key === accountKey;
  const userId = session?.userId ?? null;
  const signedIn = session !== null;
  const backendUp = backend !== null;

  // Один вариант ответа «бэкенда нет» на весь файл: состояние выставляет только
  // этот путь, и кнопка «Проверить», и загрузка страницы не могут разойтись в
  // том, что значит «не отвечает».
  function probeBackendState() {
    probeBackend()
      .then(setBackend)
      .catch(() => setBackend(null))
      .finally(() => setBackendChecked(true));
  }

  function checkBackend() {
    setBackendChecked(false);
    probeBackendState();
  }

  useEffect(() => {
    probeBackendState();
  }, []);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    listOwnFollows()
      .then((rows) => {
        if (!live) return;
        setFollowsError(null);
        setFollowing(
          rows.map((r) => ({
            followId: r.id,
            leaderId: r.leader_id,
            handle: r.leader_handle ?? "",
            allocationUsd: r.allocation_usd,
            maxLeverage: r.max_leverage,
            mirroredSize: r.current_mirrored_size,
            paused: !!r.paused,
          })),
        );
      })
      .catch((e) => {
        if (!live) return;
        setFollowing([]);
        setFollowsError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [userId]);

  // Положение рубильника публикации живёт в базе (leaders.active), а не в памяти
  // вкладки: перезагрузка страницы обязана показать то же, что видит copy-движок.
  // Публичный GET /leaders для этого не годится — он отдаёт только активных, и
  // «выключен» сливался бы с «никогда не публиковался».
  //
  // Входа нет — и читать нечего: состояние уже пусто, его обнуляют applySignIn,
  // signOut и обработчик 401. Эффект не должен чинить то, что починили они, —
  // иначе из его тела торчит синхронный setState.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    getMyLeader()
      .then((row) => {
        if (!live) return;
        setLeaderId(row ? row.id : null);
        setIsCopyable(!!row && row.active);
        if (row) setLeaderFeeBps(row.fee_bps);
      })
      .catch(() => {
        if (!live) return;
        setIsCopyable(false);
        setLeaderId(null);
      });
    return () => {
      live = false;
    };
  }, [userId]);

  const [toast, setToastState] = useState<{
    msg: string;
    variant: "success" | "error" | "info";
    ts: number;
  } | null>(null);

  function setToast(msg: string | null) {
    if (msg === null) {
      setToastState(null);
      return;
    }
    const variant = toastVariant(msg);
    setToastState({ msg, variant, ts: Date.now() });
    // Тот же итог, что и строка внизу экрана, но в руке: в мини-аппе человек
    // смотрит на график, а не вниз, и исход ордера обязан ощущаться.
    telegramNotify(variant);
  }

  useEffect(() => {
    if (!address) return;
    let live = true;
    getAccountByL1Address(address)
      .then((account) => {
        if (live) setAccountResult({ key: accountKey, account });
      })
      .catch(() => {
        if (live) setAccountResult({ key: accountKey, account: null });
      });
    return () => {
      live = false;
    };
  }, [address, accountKey]);

  // needsMarkets, а не tab: эффект перезапускается только когда в книге
  // появляется нужда, а не на каждом переключении между вкладками, где её не
  // смотрят. Скрытое окно — тоже не зритель: 4 запроса в минуту на всю жизнь
  // страницы уходили в то число, которое никто не читает.
  const needsMarkets = MARKETS_TABS.includes(tab);
  useEffect(() => {
    let live = true;
    function load() {
      getOrderBooks("all")
        .then((rows) => {
          if (live) {
            setMarkets(rows);
            setDataError(null);
          }
        })
        .catch((e) => {
          if (live) setDataError(errorText(e));
        });
    }
    load();
    const id = setInterval(() => {
      if (document.hidden || !needsMarkets) return;
      load();
    }, 15000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [network, needsMarkets]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setConnectPickerOpen(false);
        setMarketPickerOpen(false);
        setWalletMenuOpen(false);
        setCopyModal(null);
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const index = Number(e.key) - 1;
        if (e.key >= "1" && e.key <= "9" && index < TABS.length) {
          e.preventDefault();
          setTab(TABS[index].id);
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // Активная вкладка остаётся в поле зрения ленты. Девять подписей не влезают в
  // узкое окно, и переход по Alt-цифре или по ссылке из бота иначе показывал бы
  // экран без того, где сейчас человек.
  useEffect(() => {
    const bar = navRef.current;
    const active = bar?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!bar || !active) return;
    bar.scrollLeft = Math.max(
      0,
      active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2,
    );
  }, [tab]);

  function switchNetwork(next: LighterNetwork) {
    setLighterNetwork(next);
    setArcusNetwork(next);
    setMarkets([]);
    setDataError(null);
    setNetwork(next);
  }

  const currentMarket = markets.find((m) => m.symbol === asset);

  const filteredMarkets = markets
    .filter(
      (m) => marketCategory === "Все" || categorizeMarket(m) === marketCategory,
    )
    .filter((m) => {
      const q = marketSearch.trim().toUpperCase();
      return !q || m.symbol.toUpperCase().includes(q);
    })
    .slice(0, 200);

  // Книга Lighter отдаёт 246 строк (226 активных), и в mounted-виде это стоило
  // 1 018 узлов и 615 мс на открытие окна (замер e2e/render-budget.spec.ts).
  // Поиск по этому списку перерисовывал все двести кнопок на каждый keystroke.
  const { attach: attachPicker, ...pickerWindow } = useRowWindow<HTMLDivElement>(
    filteredMarkets.length,
    PICKER_ROW_PITCH,
  );

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(id);
  }, [toast]);

  // Три входа сходятся в одну точку. Личность определяет ответ бэкенда,
  // проверившего подпись (Telegram-виджет, initData мини-аппа, подпись кошелька),
  // а label — только надпись в шапке: по ней ничего не разрешается.
  function applySignIn(
    res: SignInResponse,
    via: "wallet" | "telegram",
    label: string | null,
  ) {
    setSession(saveSession(res, { via, label }));
    setFollowing([]);
    setFollowsError(null);
    setSubscription(null);
    setLeaderId(null);
    setIsCopyable(false);
    setCopyModal(null);
    setConnectPickerOpen(false);
  }

  async function handleTelegramLogin(user: TelegramUser) {
    try {
      const res = await verifyTelegramLogin(user);
      applySignIn(
        res,
        "telegram",
        user.username ? `@${user.username}` : user.first_name,
      );
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
        const label = tg
          ? tg.username
            ? `@${tg.username}`
            : tg.first_name
          : null;
        applySignIn(res, "telegram", label);
        setToast(`Вошёл как ${label ?? res.user_id}`);
      } else {
        setToast(
          "Telegram не передал подписанную initData — войди через виджет или кошелёк",
        );
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
      const res = await verifyWalletOwnership(address, (message) =>
        signMessageAsync({ message }),
      );
      applySignIn(res, "wallet", label);
      setToast(
        res.lighter_account_index == null
          ? `Кошелёк подтверждён: ${label}. Аккаунт Lighter по нему не найден — публикации лидера не будет`
          : `Кошелёк подтверждён: ${label}, Lighter #${res.lighter_account_index}`,
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
      applySignIn(
        res,
        "telegram",
        tg ? (tg.username ? `@${tg.username}` : tg.first_name) : null,
      );
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
      .then((res) => {
        if (live) onAutoLogin(res);
      })
      .catch((error) => {
        if (live) onAutoLoginError(error);
      });
    return () => {
      live = false;
    };
  }, []);

  // Окно мини-аппа настраивает сама страница: без ready() Telegram держит
  // экран-заглушку, без expand() приложение остаётся половиной высоты, а шапка
  // окна — светлой над тёмным интерфейсом.
  useEffect(() => {
    if (!isTelegramWebView()) return;
    void ensureTelegramChrome();
  }, []);

  // Глубина стека модалок: торговые панели монтируют свои внутри своих вкладок,
  // и здесь им не нужно ни знать про них, ни пробрасывать onClose наверх.
  const [layerDepth, setLayerDepth] = useState(0);
  useEffect(() => onLayerDepth(setLayerDepth), []);

  // Стрелка «назад» в шапке Telegram закрывает верхнюю панель: сначала модалку
  // (выбор рынка, подтверждение ордера, окно входа), затем — меню профиля. Без
  // этого единственная «назад» в окне вела бы сразу к закрытию мини-аппа.
  const overlayOpen =
    layerDepth > 0 ||
    walletMenuOpen ||
    connectPickerOpen ||
    marketPickerOpen ||
    copyModal !== null;
  useEffect(() => {
    if (!isTelegramWebView()) return;
    setTelegramBackHandler(overlayOpen, () => {
      if (closeTopLayer()) return;
      setWalletMenuOpen(false);
    });
    return () => setTelegramBackHandler(false, () => {});
  }, [overlayOpen]);

  useEffect(() => {
    // 401 из backendJson означает «этот токен больше не действителен», и приложение
    // обязано показать не пустые панели, а предложение войти заново.
    function onSignedOut() {
      setSession(null);
      setFollowing([]);
      setFollowsError(null);
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
    setFollowsError(null);
    setSubscription(null);
    setIsCopyable(false);
    setLeaderId(null);
    setWalletMenuOpen(false);
  }

  async function confirmCopy() {
    if (!copyModal) return;
    if (!signedIn) {
      setToast(
        "Сначала войди через Telegram или кошелёк — подписка пишется на твой аккаунт",
      );
      return;
    }
    // Сервер отказывает на этом же условии (POST /follows →
    // LIGHTER_ACCOUNT_NOT_LINKED): без подтверждённого индекса нечего зеркалить,
    // и строка follows осталась бы пустой записью с обещанием копирования.
    if (session?.lighterAccountIndex == null) {
      setToast(
        "Нужен индекс аккаунта Lighter: подтверди вход кошельком в меню профиля",
      );
      return;
    }
    try {
      const followId = await createFollow(
        copyModal.id,
        allocation,
        copyLeverage,
      );
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
      .then(() =>
        setFollowing((f) =>
          f.map((t) => (t.followId === followId ? { ...t, paused: next } : t)),
        ),
      )
      .catch((e) => setToast(`Пауза не записана в базу: ${errorText(e)}`));
  }

  function unfollow(followId: string) {
    if (!userId) return;
    deleteFollow(followId)
      .then(() => setFollowing((f) => f.filter((t) => t.followId !== followId)))
      .catch((e) => setToast(`Не удалось отписать: ${errorText(e)}`));
  }

  async function toggleCopyable() {
    if (copySwitchBusy) return;
    // Выключение — запись в базу, а не сброс useState: строка leaders это то,
    // что читает copy-движок, и без PATCH /leaders/{id}/active выключенный
    // лидер продолжал бы двигать счета своих подписчиков.
    if (isCopyable && leaderId) {
      setCopySwitchBusy(true);
      try {
        await setLeaderActive(leaderId, false);
        setIsCopyable(false);
        setToast(
          "Публикация выключена: mirror_engine больше не строит план по твоим сделкам",
        );
      } catch (e) {
        setToast(`Бэкенд не принял выключение: ${errorText(e)}`);
      } finally {
        setCopySwitchBusy(false);
      }
      return;
    }
    // Переключатель не включается, пока публикация заранее обречена: бэкенд берёт
    // индекс Lighter из своей записи, а не из тела запроса.
    if (!signedIn) {
      setToast(
        "Лидер публикуется на подтверждённый вход — войди через Telegram или кошелёк",
      );
      return;
    }
    if (!backendUp) {
      setToast("Бэкенд не отвечает — подписки не запишутся");
      return;
    }
    if (session?.lighterAccountIndex == null) {
      setToast(
        "Нужен индекс аккаунта Lighter: подтверди вход кошельком в меню профиля",
      );
      return;
    }
    setCopySwitchBusy(true);
    try {
      const id = await registerLeader(
        identityLabel ?? userId ?? "wake",
        leaderFeeBps,
      );
      setLeaderId(id);
      setIsCopyable(true);
      setToast(
        `Публикация включена: индекс Lighter #${session.lighterAccountIndex}, комиссия ${(leaderFeeBps / 100).toFixed(2)}% за сделку`,
      );
    } catch (e) {
      setIsCopyable(false);
      setToast(`Не удалось записаться в leaders: ${errorText(e)}`);
    } finally {
      setCopySwitchBusy(false);
    }
  }

  const lighterAccountIndex: number | null =
    lighterAccount?.accountIndex ?? null;

  // Субъект здесь — токен: /subscription и /subscription/trial не берут id ни из
  // пути, ни из тела. Смена входа (или 401) перечитывает подписку заново.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    backendJson<Subscription>("/subscription")
      .then((data) => {
        if (live) setSubscription(data);
      })
      .catch(() => {
        if (live) setSubscription(null);
      });
    return () => {
      live = false;
    };
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

  const identityLabel =
    session?.label ??
    (address
      ? (ensName ?? `${address.slice(0, 6)}...${address.slice(-4)}`)
      : null);
  const toastView = toast && (
    <div
      role="status"
      aria-live="polite"
      className="toast animate-fade-in"
      data-variant={toast.variant}
    >
      {toast.variant === "error" ? (
        <AlertTriangle />
      ) : toast.variant === "success" ? (
        <Check />
      ) : (
        <Info />
      )}
      <span>{toast.msg}</span>
      <button
        onClick={() => setToastState(null)}
        className="overlay-close push-right"
        aria-label="Закрыть уведомление"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <ToastProvider toast={toastView}>
      <div className="min-h-screen w-full font-sans">
        <div className="app-shell max-w-6xl mx-auto px-3 sm:px-6">
          <div className="mb-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 mb-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-[5px] bg-[var(--accent)] flex items-center justify-center">
                    <Zap
                      className="w-4 h-4 text-[color:var(--on-accent)]"
                      strokeWidth={2.5}
                    />
                  </div>
                  <span className="wordmark">Wake</span>
                </div>

                <div
                  className="seg"
                  role="group"
                  aria-label="Сеть Lighter и Arcus"
                >
                  {(["mainnet", "testnet"] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => switchNetwork(n)}
                      aria-pressed={network === n}
                      title={
                        n === "mainnet"
                          ? "Реальные рынки Lighter и Arcus, реальные цены"
                          : "Тестовая сеть — тот же код, другие market ids"
                      }
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
                    className={
                      backend
                        ? backend.dry_run
                          ? "chip chip-warn"
                          : "chip chip-down"
                        : "chip chip-info"
                    }
                    title={
                      backend
                        ? "Сеть бэкенда и режим отправки ордеров"
                        : "Панели, которым нужна база, сейчас не работают"
                    }
                  >
                    {backend
                      ? `бэкенд · ${backend.network} · ${backend.dry_run ? "dry-run" : "live"}`
                      : backendChecked
                        ? "бэкенд недоступен"
                        : "бэкенд: проверяю…"}
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
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[color:var(--on-accent)] text-[10px] font-bold ${
                        session?.via === "telegram"
                          ? "bg-[var(--accent)]"
                          : "bg-[var(--up)]"
                      }`}
                    >
                      {(identityLabel ?? "?")
                        .replace(/^@/, "")
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    {identityLabel ?? "Кошелёк подключён"}
                    {!signedIn && (
                      <span
                        className="w-1.5 h-1.5 rounded-full bg-[var(--warn)]"
                        title="Вход не подтверждён"
                      />
                    )}
                    <ChevronDown className="w-3.5 h-3.5 text-[var(--fg-3)]" />
                  </button>
                ) : (
                  <button
                    onClick={() => setConnectPickerOpen(true)}
                    className="btn-primary"
                  >
                    {/* На телефоне шапка и так съедает четверть экрана: длинная
                      подпись уводила кнопку входа на вторую строку. Полный
                      вариант остаётся на широком экране и в описании модального
                      окна, куда кнопка открывает. */}
                    <span className="hidden sm:inline">
                      Войти через TG или кошелёк
                    </span>
                    <span className="sm:hidden">Войти</span>
                  </button>
                )}

                {walletMenuOpen && (signedIn || address) && (
                  <>
                    <div
                      className="fixed inset-0 z-40"
                      onClick={() => setWalletMenuOpen(false)}
                    />
                    <div className="menu-card animate-fade-in">
                      <div className="text-xs text-[color:var(--text-muted)] mb-1">
                        {signedIn
                          ? `Вход через ${session?.via === "telegram" ? "Telegram" : "кошелёк"}`
                          : "Кошелёк подключён, вход не подтверждён"}
                      </div>
                      <div className="text-sm text-[color:var(--fg-2)] font-medium mb-3">
                        {identityLabel ?? "—"}
                      </div>
                      {address && (
                        <>
                          <div className="text-xs text-[color:var(--text-muted)] mb-1">
                            Ethereum-адрес
                          </div>
                          <div className="text-sm text-[color:var(--fg-2)] font-mono mb-3 break-all">
                            {address}
                          </div>
                        </>
                      )}
                      <div className="text-xs text-[color:var(--fg-3)] mb-2">
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
                          бэкенд: {backend.network} ·{" "}
                          {backend.dry_run
                            ? "dry-run — ордера не отправляются"
                            : "реальные ордера"}
                        </div>
                      )}
                      {TELEGRAM_BOT_NAME && (
                        <a
                          href={`https://t.me/${TELEGRAM_BOT_NAME}?startapp`}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={(e) => {
                            // Изнутри Telegram ссылка обязана уйти в сам клиент, а
                            // не открыть второе вебвью поверх этого.
                            if (isTelegramWebView()) {
                              e.preventDefault();
                              openExternally(
                                `https://t.me/${TELEGRAM_BOT_NAME}`,
                              );
                            }
                          }}
                          className="flex items-center gap-2 text-xs text-[color:var(--fg-2)] hover:text-[var(--accent)] mb-3 transition-colors"
                        >
                          <MessageSquareText className="w-3.5 h-3.5 shrink-0" />
                          @{TELEGRAM_BOT_NAME} — карточки рынков командой и
                          тикером
                        </a>
                      )}
                      {address && session?.via !== "wallet" && (
                        <>
                          <button
                            onClick={() => void signInWithWallet()}
                            disabled={walletBusy}
                            className="btn-action btn-up mb-2"
                          >
                            {walletBusy
                              ? "Жду подпись в кошельке…"
                              : "Подписать вход кошельком"}
                          </button>
                          <div className="text-xs text-[color:var(--text-muted)] leading-relaxed mb-3 font-mono">
                            Это другой аккаунт Wake: бэкенд заводит запись по
                            адресу, поэтому подписки Telegram-входа здесь не
                            появятся. Нужен он для публикации лидера — индекс
                            Lighter берётся из подтверждённого адреса.
                          </div>
                        </>
                      )}
                      {!signedIn && (
                        <button
                          onClick={() => setConnectPickerOpen(true)}
                          className="btn-secondary mb-2"
                        >
                          Войти через Telegram
                        </button>
                      )}
                      {signedIn ? (
                        <button onClick={signOut} className="btn-danger">
                          Выйти
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            disconnect();
                            setWalletMenuOpen(false);
                          }}
                          className="btn-secondary"
                        >
                          Отключить кошелёк
                        </button>
                      )}
                    </div>
                  </>
                )}

                {connectPickerOpen && (
                  <Modal
                    label="Войти в Wake"
                    onClose={() => setConnectPickerOpen(false)}
                  >
                    <div
                      className="overlay-shell animate-fade-in"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between mb-5">
                        <h3 className="overlay-title">Войти в Wake</h3>
                        <button
                          onClick={() => setConnectPickerOpen(false)}
                          className="overlay-close"
                          aria-label="Закрыть"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>

                      <div className="space-y-3">
                        <div className="stat-label">Через Telegram</div>
                        {isTelegramWebView() ? (
                          <>
                            <button
                              onClick={() => {
                                void loginFromMiniApp();
                              }}
                              disabled={miniAppBusy}
                              className="btn-action btn-accent w-full"
                            >
                              {miniAppBusy
                                ? "Проверяю initData…"
                                : "Войти через Telegram"}
                            </button>
                            <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                              Страница открыта внутри Telegram, поэтому вход
                              идёт по подписанной{" "}
                              <code className="text-[color:var(--fg-3)]">
                                initData
                              </code>
                              : её целиком проверяет{" "}
                              <code className="text-[color:var(--fg-3)]">
                                POST /auth/telegram/init
                              </code>{" "}
                              на токене бота. Login-виджет здесь не нужен —
                              Telegram его в вебвью обычно не рендерит.
                            </p>
                          </>
                        ) : (
                          <>
                            <TelegramLogin
                              onLogin={(u) => void handleTelegramLogin(u)}
                            />
                            <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                              Виджет отдаёт подпись HMAC-SHA256; её проверяет{" "}
                              <code className="text-[color:var(--fg-3)]">
                                POST /auth/telegram
                              </code>{" "}
                              на токене бота, а не браузер. Без{" "}
                              <code className="text-[color:var(--fg-3)]">
                                TELEGRAM_BOT_TOKEN
                              </code>{" "}
                              на бэкенде кнопка сознательно не появляется.
                            </p>
                          </>
                        )}

                        <div className="relative my-4">
                          <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-[color:var(--line)]"></div>
                          </div>
                          <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-[color:var(--bg-1)] px-2 text-[color:var(--text-muted)]">
                              или
                            </span>
                          </div>
                        </div>

                        <div className="stat-label">Через кошелёк</div>
                        {address ? (
                          <>
                            <button
                              onClick={() => void signInWithWallet()}
                              disabled={walletBusy}
                              className="row-button"
                            >
                              <span className="font-medium">
                                {walletBusy
                                  ? "Жду подпись в кошельке…"
                                  : "Подписать вход кошельком"}
                              </span>
                              <span className="text-[color:var(--text-muted)] text-xs font-mono">{`${address.slice(0, 6)}…${address.slice(-4)}`}</span>
                            </button>
                            <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                              Одного подключённого адреса мало: его может
                              назвать любой. Бэкенд выдаёт одноразовый текст,
                              кошелёк подписывает его по{" "}
                              <code className="text-[color:var(--fg-3)]">
                                personal_sign
                              </code>
                              , а{" "}
                              <code className="text-[color:var(--fg-3)]">
                                POST /auth/wallet/verify
                              </code>{" "}
                              восстанавливает из подписи адрес и сверяет с
                              заявленным.
                            </p>
                          </>
                        ) : (
                          <>
                            <div className="space-y-2">
                              {connectors.map((c) => (
                                <button
                                  key={c.id}
                                  onClick={() => {
                                    connectAsync({ connector: c }).catch((e) =>
                                      setToast(
                                        `Кошелёк не подключился: ${errorText(e)}`,
                                      ),
                                    );
                                  }}
                                  disabled={isPending}
                                  className="row-button"
                                >
                                  <span className="font-medium">{c.name}</span>
                                  <ChevronRight className="w-4 h-4 text-[color:var(--text-muted)]" />
                                </button>
                              ))}
                            </div>
                            <p className="text-xs text-[color:var(--text-muted)] leading-relaxed font-mono">
                              Список — то, что реально нашлось в этом окне.
                              QR-подключение (WalletConnect) появляется только
                              когда фронт собран с{" "}
                              <code className="text-[color:var(--fg-3)]">
                                VITE_WALLETCONNECT_PROJECT_ID
                              </code>
                              : без project id AppKit при старте ловит 400/403,
                              поэтому коннектор не добавляется. После
                              подключения здесь же появится шаг с подписью.
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </Modal>
                )}
              </div>
            </div>

            <nav
              ref={navRef}
              className="tabbar scrollbar-hide"
              aria-label="Основная навигация"
            >
              {TABS.map((t) => (
                <NavTab
                  key={t.id}
                  icon={t.icon}
                  active={tab === t.id}
                  onClick={() => setTab(t.id)}
                  label={t.label}
                  live={t.live}
                />
              ))}
            </nav>
          </div>

          {backendChecked && !backend && (
            <div className="notice animate-fade-in">
              <ServerOff className="w-3.5 h-3.5 shrink-0" />
              <span>
                Бэкенд Wake недоступен: работают Терминал, Funding и Портфель —
                они читают публичный API Lighter. Копи-трейд, Predict, агент и
                обзор рынка хранят состояние в базе Wake.
              </span>
              <details className="notice-more">
                <summary>Почему так</summary>
                <p>
                  Сайт — статика на Cloudflare Pages, Wake-бэкенд — отдельный
                  сервис: он подписывает ордера, ведёт базу и проверяет вход.
                  Без него панели, которым нужна база, честно показывают эту
                  строку, а не пустые таблицы.
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
                Бэкенд работает в сети{" "}
                <code className="num">{backend.network}</code>, а сайт
                переключён в <code className="num">{network}</code>: обзор
                рынка, Predict и копи-трейд приходят из{" "}
                <code className="num">{backend.network}</code>. Сеть у бэкенда
                задаёт <code className="num">WAKE_LIGHTER_NETWORK</code>, с
                фронтенда она не переключается.
              </span>
            </div>
          )}

          {/* перемонтирование по сети: панели иначе держат данные со старой сети до следующего опроса */}
          <Suspense
            fallback={
              <div
                style={{
                  padding: "24px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "16px",
                }}
              >
                <div className="skeleton-row">
                  {[1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className="skeleton"
                      style={{ flex: 1, height: "80px" }}
                    />
                  ))}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                    gap: "16px",
                  }}
                >
                  <div className="skeleton" style={{ height: "400px" }} />
                  <div className="skeleton" style={{ height: "400px" }} />
                </div>
              </div>
            }
          >
            <div key={network}>
              {tab === "dashboard" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Dashboard.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Dashboard
                    key={network}
                    setTab={setTab}
                    setAsset={setAsset}
                  />
                </ErrorBoundary>
              )}

              {tab === "terminal" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Terminal.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Terminal
                    key={`${network}:${asset}:${currentMarket?.market_id}`}
                    asset={asset}
                    setAsset={setAsset}
                    markets={markets}
                    dataError={dataError}
                    setToast={setToast}
                    isCopyable={isCopyable}
                    copySwitchBusy={copySwitchBusy}
                    toggleCopyable={() => void toggleCopyable()}
                    setMarketPickerOpen={setMarketPickerOpen}
                    network={network}
                    accountEquityUsd={lighterAccount?.equityUsd}
                  />
                </ErrorBoundary>
              )}

              {tab === "discover" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Discover.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Discover setCopyModal={setCopyModal} />
                </ErrorBoundary>
              )}

              {tab === "portfolio" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Portfolio.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Portfolio
                    key={`${userId}:${network}:${lighterAccountIndex}`}
                    following={following}
                    followsError={followsError}
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
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Earn.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
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
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Predict.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Predict
                    key={userId ?? "signed-out"}
                    signedIn={signedIn}
                    setToast={setToast}
                    onConnect={() => setConnectPickerOpen(true)}
                    focusMarket={entry.market}
                  />
                </ErrorBoundary>
              )}

              {tab === "agent" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Agent.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
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
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Risk.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Risk markets={markets} setToast={setToast} />
                </ErrorBoundary>
              )}

              {tab === "funding" && (
                <ErrorBoundary
                  fallback={
                    <div className="panel-error">
                      Ошибка загрузки Funding.{" "}
                      <button
                        className="link-action"
                        onClick={() => window.location.reload()}
                      >
                        Обновить
                      </button>
                    </div>
                  }
                >
                  <Funding markets={markets} setToast={setToast} />
                </ErrorBoundary>
              )}
            </div>
          </Suspense>
        </div>

        {marketPickerOpen && (
          <Modal label="Выбор рынка" onClose={() => setMarketPickerOpen(false)}>
            <div
              className="overlay-shell overlay-shell--wide overlay-shell--flush"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="overlay-title">Выбор рынка</h3>
                <button
                  onClick={() => setMarketPickerOpen(false)}
                  className="overlay-close"
                  aria-label="Закрыть"
                >
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
                className="input-mono mb-3 w-full"
              />
              <div
                className="seg mb-3 overflow-x-auto"
                role="group"
                aria-label="Категория рынка"
              >
                {(
                  [
                    "Все",
                    "Crypto",
                    "Spot",
                    "Stocks",
                    "Forex",
                    "Commodities",
                  ] as const
                ).map((c) => (
                  <button
                    key={c}
                    onClick={() => setMarketCategory(c)}
                    aria-pressed={marketCategory === c}
                    className="whitespace-nowrap"
                  >
                    {c}
                  </button>
                ))}
              </div>
              <p
                style={{
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Категория определяется по списку тикеров: у книги Lighter нет
                поля «тип инструмента». Всё, чего в списке нет, показывается как
                Crypto — для отдельной строки это допущение, а не факт.
              </p>
              <div
                ref={attachPicker}
                className="overflow-y-auto picker-list"
              >
                {filteredMarkets.length === 0 && (
                  <p className="picker-empty">
                    Ничего не найдено
                  </p>
                )}
                <div style={{ height: pickerWindow.padTop }} />
                {filteredMarkets
                  .slice(pickerWindow.start, pickerWindow.end)
                  .map((m) => (
                    <button
                      key={m.market_id}
                      onClick={() => {
                        setAsset(m.symbol);
                        setMarketPickerOpen(false);
                        setMarketSearch("");
                      }}
                      className="row-button picker-row"
                      aria-current={m.symbol === asset ? "true" : undefined}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium font-mono">{m.symbol}</span>
                        <span className="text-[color:var(--text-muted)] text-xs">
                          {categorizeMarket(m)}
                        </span>
                      </div>
                      <span className="text-[color:var(--text-muted)] text-xs font-mono">
                        {m.market_type}
                      </span>
                    </button>
                  ))}
                <div style={{ height: pickerWindow.padBottom }} />
              </div>
            </div>
          </Modal>
        )}

        {copyModal && (
          <Modal
            label={`Копировать ${copyModal.handle}`}
            onClose={() => setCopyModal(null)}
          >
            <div className="overlay-shell" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white"
                    style={{ background: avatarColor(copyModal.handle) }}
                  >
                    {shortHandle(copyModal.handle)}
                  </div>
                  <div>
                    <div className="font-medium text-sm">
                      {copyModal.handle}
                    </div>
                    <div className="text-[color:var(--text-muted)] text-xs font-mono">
                      Lighter #{copyModal.lighterAccountIndex}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => setCopyModal(null)}
                  className="overlay-close"
                  aria-label="Закрыть"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-4 text-sm font-mono">
                <div>
                  <div className="stat-label">Комиссия</div>
                  <div className="text-[color:var(--fg-2)]">
                    {(copyModal.feeBps / 100).toFixed(2)}% за сделку
                  </div>
                </div>
                <div>
                  <div className="stat-label">Реализованный PnL</div>
                  <div
                    className={
                      copyModal.exchange
                        ? copyModal.exchange.realizedPnlUsd >= 0
                          ? "text-positive"
                          : "text-negative"
                        : "text-[color:var(--text-muted)]"
                    }
                  >
                    {copyModal.exchange
                      ? `${copyModal.exchange.realizedPnlUsd >= 0 ? "+" : ""}${usd(copyModal.exchange.realizedPnlUsd, 0)}`
                      : "нет ответа Lighter"}
                  </div>
                </div>
                <div>
                  <div className="stat-label">Подписчиков</div>
                  <div className="text-[color:var(--fg-2)]">
                    {fmt(copyModal.followers)}
                  </div>
                </div>
                <div>
                  <div className="stat-label">Открытых позиций</div>
                  <div className="text-[color:var(--fg-2)]">
                    {copyModal.exchange
                      ? fmt(copyModal.exchange.openPositions.length)
                      : "—"}
                  </div>
                </div>
              </div>

              <label
                htmlFor="copy-allocation"
                className="stat-label mb-1 block"
              >
                Аллокация — сколько твоих денег участвует в копировании
              </label>
              <div className="field-box mb-3">
                <span className="text-[color:var(--text-muted)] mr-1 font-mono text-sm">
                  $
                </span>
                <input
                  id="copy-allocation"
                  type="number"
                  min={1}
                  step={1}
                  value={allocation}
                  onChange={(e) => {
                    // valueAsNumber, а не Number(...): у «1e» и «-» это NaN, и NaN
                    // проходил бы в запрос, где бэкенд отбивает его валидацией —
                    // человек получил бы 422 вместо понятного «сумма не число».
                    const raw = e.target.valueAsNumber;
                    setAllocation(Number.isFinite(raw) ? Math.max(0, raw) : 0);
                  }}
                  className="input-mono bg-transparent w-full"
                />
              </div>

              <div className="mb-4">
                <div className="flex justify-between mb-1">
                  <span className="stat-label">
                    Максимальное плечо по копии
                  </span>
                  <span className="stat-value text-sm">{copyLeverage}x</span>
                </div>
                <input
                  type="range"
                  aria-label="Максимальное плечо по копии"
                  min="1"
                  max="20"
                  value={copyLeverage}
                  onChange={(e) => setCopyLeverage(Number(e.target.value))}
                  className="range"
                />
              </div>

              <button
                onClick={() => void confirmCopy()}
                disabled={allocation <= 0}
                className="btn-action btn-accent w-full"
              >
                Подписаться
              </button>
              <p className="text-xs text-[color:var(--text-muted)] mt-3 leading-relaxed font-mono">
                Подписка пишется в таблицу{" "}
                <code className="text-[color:var(--fg-3)]">follows</code> и
                становится входом для{" "}
                <code className="text-[color:var(--fg-3)]">mirror_engine</code>.
                Дальше всё зависит от того, как запущен{" "}
                <code className="text-[color:var(--fg-3)]">
                  leader_listener.py
                </code>
                : по умолчанию{" "}
                <code className="text-[color:var(--fg-3)]">
                  WAKE_DRY_RUN=true
                </code>{" "}
                — решение считается и пишется в{" "}
                <code className="text-[color:var(--fg-3)]">mirror_log</code> со
                статусом{" "}
                <code className="text-[color:var(--fg-3)]">dry_run</code>, ордер
                на Lighter не уходит. Каждый исход виден во вкладке «Портфель».
              </p>
            </div>
          </Modal>
        )}

        {!connectPickerOpen && !marketPickerOpen && !copyModal && toastView}
      </div>
    </ToastProvider>
  );
}
