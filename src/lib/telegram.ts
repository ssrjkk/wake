// Вход изнутри Telegram Mini App. Отдельно от TelegramLogin.tsx, где живёт виджет
// для обычного браузера: здесь подписанная строка initData уже есть у клиента, и
// задача фронта — отдать её целиком бэкенду и ничего не додумывать.
//
// Проверка подписи живёт на бэкенде (api/auth.py: POST /auth/telegram/init),
// потому что любой, кто откроет консоль, может подменить initDataUnsafe.user.
//
// Ответ любого входа здесь — SignInResponse из lib/session.ts: user_id, токен и
// срок. Сохраняет его приложение (App.tsx), а не эта функция: три входа различаются
// только способом подтвердить личность, а дальше обязаны сделать одно и то же.
import { backendJson } from "./backend";
import type { SignInResponse } from "./session";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// SDK Telegram подсовывает window.Telegram.WebApp. Типизирован минимально: нужен
// ровно initData, а не весь интерфейс мини-аппа.
type MiniApp = { initData?: string; ready?: () => void; initDataUnsafe?: { user?: TelegramUser } };
declare global {
  interface Window {
    Telegram?: { WebApp?: MiniApp };
  }
}

const SDK_SRC = "https://telegram.org/js/telegram-web-app.js";

// initData отсутствует, если мини-апп открыли кнопкой без подписанных данных, и
// не содержит user, когда строка есть, но пользователя в ней нет. В обоих случаях
// входить не по чему — это не ошибка, а «не в телеграмовском контексте».
export function hasMiniAppUser(initData: string | undefined | null): boolean {
  return !!initData && initData.includes("user=") && initData.includes("hash=");
}

export function isTelegramWebView(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /telegram/i.test(ua);
}

let sdkPromise: Promise<MiniApp | null> | null = null;

// Скрипт грузится один раз и только в Telegram: на обычном заходе в браузер
// тянуть чужой домен незачем.
export function ensureTelegramSdk(ua?: string): Promise<MiniApp | null> {
  if (!isTelegramWebView(ua)) return Promise.resolve(null);
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

// Подпись проверяется по initData, а это поле — разбор той же строки на клиенте.
// Годится только как надпись в шапке: личность определяет user_id из ответа
// бэкенда, и подмена имени здесь меняет лишь то, что видит сам подменивший.
export function miniAppDisplayName(): TelegramUser | null {
  return window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;
}

export async function connectTelegramMiniApp(ua?: string): Promise<SignInResponse | null> {
  const app = await ensureTelegramSdk(ua);
  if (!app || !hasMiniAppUser(app.initData)) return null;

  return backendJson<SignInResponse>("/auth/telegram/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: app.initData }),
  });
}

export async function verifyTelegramLogin(user: TelegramUser): Promise<SignInResponse> {
  // Ответ бэкенда — единственное, что показывается в интерфейсе: до проверки подписи
  // поля виджета это ещё данные браузера.
  return backendJson<SignInResponse>("/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(user),
  });
}
