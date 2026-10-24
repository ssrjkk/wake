// Вход и окно Telegram Mini App.
//
// Здесь два разных входа, и оба идут через бэкенд, потому что любой, кто откроет
// консоль, может подменить initDataUnsafe.user:
//
//   - мини-апп (вебвью Telegram) отдаёт подписанную строку initData целиком, её
//     разбирает и проверяет POST /auth/telegram/init;
//   - Login Widget в обычном браузере отдаёт набор полей id/first_name/username/
//     auth_date/hash, и его проверяет POST /auth/telegram.
//
// Формы у них разные именно потому, что Telegram подписывает конкретный набор
// полей: в initData пользователь лежит внутри параметра user (JSON), а виджет
// отдаёт поля раздельно и user не отдаёт вовсе. Склеить их в один запрос можно
// было бы только дописав в строку виджета свой user — и подпись перестала бы
// сходиться. Поэтому фронт ничего не додумывает: отдаёт то, что ему дали.
//
// Ответ любого входа — SignInResponse из lib/session.ts: user_id, токен и срок.
// Сохраняет его приложение (App.tsx), а не эта функция: входы различаются способом
// подтвердить личность, а дальше обязаны сделать одно и то же.
//
// Вторая половина модуля — окно мини-аппа: ready/expand, цвета, выемки экрана,
// кнопка «назад» и вибрация. Telegram не делает этого за страницу.
import { backendJson } from "./backend";
import type { SignInResponse } from "./session";

// Поля, которые реально подписывает Login Widget. photo_url виджет тоже отдаёт, но
// в подпись Telegram его не включает — «vk.com/id123», скажем, — и вместе с ним не
// сходится check_string, поэтому сюда он не попадает.
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  auth_date: number;
  hash: string;
}

interface SafeArea {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

interface BackButton {
  show?: () => void;
  hide?: () => void;
  onPress?: (handler: () => void) => void;
  offPress?: (handler: () => void) => void;
}

// Срез window.Telegram.WebApp, которым пользуется приложение. Поля необязательные:
// набор различается между версиями SDK и между iOS, Android и десктопом, и
// отсутствие метода означает «этот клиент так не умеет», а не ошибку страницы.
export type TelegramSdk = {
  initData?: string;
  initDataUnsafe?: { user?: TelegramUser };
  ready?: () => void;
  expand?: () => void;
  setColorScheme?: (scheme: "light" | "dark" | "auto") => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
  safeAreaInset?: SafeArea;
  BackButton?: BackButton;
  HapticFeedback?: {
    impactOccurred?: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred?: (kind: "error" | "success" | "warning") => void;
  };
  onEvent?: (event: "backButtonClicked", handler: () => void) => void;
  offEvent?: (event: "backButtonClicked", handler: () => void) => void;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramSdk };
  }
}

export interface MiniAppOptions {
  userAgent?: string;
  // Сюда подкладывается window.Telegram.WebApp; параметр нужен тестам, которые
  // проверяют обвязку окна, не подсовывая SDK всему документу.
  sdk?: TelegramSdk | null;
}

const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

export function isTelegramWebView(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /telegram/i.test(ua);
}

let sdkPromise: Promise<TelegramSdk | null> | null = null;

// Скрипт грузится один раз и только в Telegram: на обычном заходе в браузер тянуть
// чужой домен незачем.
export function ensureTelegramSdk(userAgent?: string): Promise<TelegramSdk | null> {
  if (!isTelegramWebView(userAgent)) return Promise.resolve(null);
  if (window.Telegram?.WebApp) return Promise.resolve(window.Telegram.WebApp);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    // Метка, чтобы по ней найти уже вставленный тег, а не плодить второй запрос
    // к telegram.org при повторном заходе внутри одной сессии.
    script.dataset.telegramSdk = "1";
    // SDK может не дойти (офлайн, блокировщик) — вход тогда просто не состоится,
    // и это не должно вешать загрузку страницы.
    const settle = () => resolve(window.Telegram?.WebApp ?? null);
    script.onload = settle;
    script.onerror = settle;
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function resolveSdk(options: MiniAppOptions): Promise<TelegramSdk | null> {
  if (options.sdk !== undefined) return Promise.resolve(options.sdk);
  return ensureTelegramSdk(options.userAgent);
}

/** Дождаться SDK и настроить окно: страница обязана сказать Telegram, что она
 * готова, иначе вебвью остаётся недооткрытым. Вне Telegram — ничего не делает. */
export async function ensureTelegramChrome(options: MiniAppOptions = {}): Promise<void> {
  const app = await resolveSdk(options);
  if (app) applyTelegramChrome(app);
}

// Разбор подписанной строки. Telegram кодирует user как percent-encoded JSON и
// держит auth_date/hash рядом — те самые, что входят в подпись.
export function parseInitData(initData: string): { user: TelegramUser; auth_date: number; hash: string } | null {
  const params = new URLSearchParams(initData);
  const rawUser = params.get("user");
  const rawAuthDate = params.get("auth_date");
  const hash = params.get("hash");
  if (!rawUser || !rawAuthDate || !hash) return null;

  const auth_date = Number(rawAuthDate);
  if (!Number.isInteger(auth_date)) return null;

  let user: TelegramUser;
  try {
    user = JSON.parse(rawUser) as TelegramUser;
  } catch {
    return null;
  }
  if (!user || typeof user !== "object" || typeof user.id !== "number") return null;
  return { user, auth_date, hash };
}

// initData отсутствует, если мини-апп открыли кнопкой без подписанных данных, и
// не содержит пользователя, когда строка есть, но она пуста. В обоих случаях
// входить не по чему — это не ошибка, а «мы не в подписанном контексте».
//
// Строка разбирается, а не ищется по подстроке: «user=» встречается и внутри
// чужого значения, и «hash=» без auth_date подписью не является.
export function hasSignedUser(initData: string | undefined | null): boolean {
  return !!initData && parseInitData(initData) !== null;
}

// Надпись в шапке. Личность определяет user_id из ответа бэкенда, и подмена имени
// здесь меняет лишь то, что видит сам подменивший.
export function miniAppDisplayName(options: MiniAppOptions = {}): TelegramUser | null {
  const app = options.sdk ?? window.Telegram?.WebApp;
  return app?.initDataUnsafe?.user ?? null;
}

/**
 * Вход изнутри мини-аппа: отдаём бэкенду initData и входим, ничего не додумывая.
 *
 * null — подписанных данных нет (кнопка без initData, офлайн, блокировщик).
 * Тогда приложение показывает кнопку ручного входа, а не притворяется вошедшим.
 */
export async function connectTelegramMiniApp(options: MiniAppOptions = {}): Promise<SignInResponse | null> {
  const app = await resolveSdk(options);
  if (!app) return null;
  applyTelegramChrome(app);
  if (!hasSignedUser(app.initData)) return null;

  return backendJson<SignInResponse>("/auth/telegram/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: app.initData }),
  });
}

/**
 * Вход по данным Login Widget: уходят ровно те поля, что входят в подпись.
 *
 * Виджет отдаёт ещё и photo_url («https://…jpg»), а Telegram его не подписывает.
 * Вместе с ним check_string расходится, и вход падал бы 401 при полностью
 * корректной подписи — поэтому поле сюда не попадает.
 *
 * Ответ бэкенда — единственное, что показывается в интерфейсе: до проверки подписи
 * поля виджета это ещё данные браузера.
 */
export async function verifyTelegramLogin(user: TelegramUser): Promise<SignInResponse> {
  const signed: TelegramUser = {
    id: user.id,
    first_name: user.first_name,
    auth_date: user.auth_date,
    hash: user.hash,
  };
  if (user.last_name !== undefined) signed.last_name = user.last_name;
  if (user.username !== undefined) signed.username = user.username;

  return backendJson<SignInResponse>("/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
}

// ── Обвязка окна мини-аппа ─────────────────────────────────────────────────────
//
// До этого модуля страница читала только initData: без ready() Telegram держит
// экран-заглушку, без expand() мини-апп открывается половиной высоты и терминал
// скроллится внутри узкой щели, шапка окна остаётся светлой над тёмным
// интерфейсом, а нижняя строка телефона ложится поверх панели ордера.
//
// Каждый вызов проверяется по месту (?.).

function cssColor(token: string): string {
  // Значение берётся из токена темы, а не из литерала в этом файле: цвет шапки
  // обязан совпасть с панелью, и вторая правка палитры не должна разъезжаться.
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

export function applyTelegramChrome(app: TelegramSdk | null = window.Telegram?.WebApp ?? null): void {
  if (!app) return;

  app.ready?.();
  app.expand?.();
  // Тема одна — тёмная: setColorScheme влияет и на шапку, и на системные отступы,
  // а «auto» дал бы белую шапку над прибором у того, у кого в Telegram светлая
  // тема.
  app.setColorScheme?.("dark");

  const panel = cssColor("--bg-1");
  if (panel) {
    app.setHeaderColor?.(panel);
    app.setBackgroundColor?.(cssColor("--bg-0") || panel);
  }

  // Выемки Telegram отдаёт своими числами: в его вебвью env(safe-area-inset-*)
  // часто ноль, потому что окно уже обрезано клиентом.
  const inset = app.safeAreaInset;
  if (inset) {
    const root = document.documentElement;
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const px = inset[side];
      if (typeof px === "number" && px > 0) {
        root.style.setProperty(`--tg-safe-${side}`, `${px}px`);
      }
    }
  }
}

// Единственный активный обработчик: нажатие отдаётся одним сигналом, и второй повес
// на то же «backButtonClicked» означал бы два закрытия панели подряд.
let detachBackHandler: (() => void) | null = null;

/**
 * Стрелка «назад» в шапке мини-аппа закрывает открытую панель, а не убивает окно.
 *
 * Вызов вне Telegram — no-op: нечем менять то, чего в обычном браузере нет.
 */
export function setTelegramBackHandler(enabled: boolean, onPress: () => void): void {
  const webApp = window.Telegram?.WebApp;
  const button = webApp?.BackButton;
  detachBackHandler?.();
  detachBackHandler = null;

  if (!enabled) {
    button?.hide?.();
    return;
  }
  if (button?.onPress) {
    button.onPress(onPress);
    detachBackHandler = () => button.offPress?.(onPress);
  } else if (webApp?.onEvent) {
    webApp.onEvent("backButtonClicked", onPress);
    detachBackHandler = () => webApp.offEvent?.("backButtonClicked", onPress);
  } else {
    return;
  }
  button?.show?.();
}

/** Вибрация под итог действия: в телефоне исход ордера должен ощущаться, а не
 * только появляться строкой внизу экрана. Вне Telegram — молча no-op. */
export function telegramNotify(kind: "success" | "error" | "info"): void {
  const haptic = window.Telegram?.WebApp?.HapticFeedback;
  if (!haptic) return;
  if (kind === "error") haptic.notificationOccurred?.("error");
  else if (kind === "success") haptic.notificationOccurred?.("success");
  else haptic.impactOccurred?.("light");
}

/** Ссылка наружу: из вебвью t.me-адрес обязан уйти в сам Telegram, остальные — в
 * его встроенный браузер, а не подменять собой текущий экран. */
export function openExternally(url: string): void {
  const app = window.Telegram?.WebApp;
  if (!app) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  if (url.startsWith("https://t.me/") || url.startsWith("http://t.me/")) {
    app.openTelegramLink?.(url);
    return;
  }
  if (app.openLink) app.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
