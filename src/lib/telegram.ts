// Вход изнутри Telegram Mini App. Отдельно от TelegramLogin.tsx, где живёт виджет
// для обычного браузера: здесь подписанная строка initData уже есть у клиента, и
// задача фронта — отдать её целиком бэкенду и ничего не додумывать.
//
// Проверка подписи живёт на бэкенде (api/auth.py: POST /auth/telegram/init),
// потому что любой, кто откроет консоль, может подменить initDataUnsafe.user.
import { backendJson } from "./backend";

export interface TelegramProfile {
  user_id: string;
  telegram_id: number;
  username: string | null;
  first_name: string;
}

// SDK Telegram подсовывает window.Telegram.WebApp. Типизирован минимально: нужен
// ровно initData, а не весь интерфейс мини-аппа.
type MiniApp = { initData?: string; ready?: () => void };
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

export async function connectTelegramMiniApp(ua?: string): Promise<TelegramProfile | null> {
  const app = await ensureTelegramSdk(ua);
  if (!app || !hasMiniAppUser(app.initData)) return null;

  return backendJson<TelegramProfile>("/auth/telegram/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: app.initData }),
  });
}
