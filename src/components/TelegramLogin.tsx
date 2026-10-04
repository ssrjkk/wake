import { useEffect, useRef, useState } from "react";
import { TELEGRAM_BOT_NAME } from "../lib/config";
import type { TelegramUser } from "../lib/telegram";

// Telegram Login Widget объявляет колбэк на window по data-onauth; window в
// lib.dom не знает про него — расширяем тип, чтобы не гасить no-explicit-any.
declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramUser) => void;
  }
}

interface TelegramLoginProps {
  onLogin: (user: TelegramUser) => void;
  onMissingConfig?: () => void;
}

// telegram-widget.js renders its button in place of the <script> tag, so the script has to
// be injected inside this component's own container — appending it to <body> would put the
// button outside the modal. The latest callbacks are kept in a ref so the widget mounts once
// and is not re-created on every parent re-render (a re-mount visibly reloads the button).
export function TelegramLogin({ onLogin, onMissingConfig }: TelegramLoginProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onLogin, onMissingConfig });
  callbacks.current = { onLogin, onMissingConfig };
  const [missingConfig, setMissingConfig] = useState(false);

  useEffect(() => {
    if (!TELEGRAM_BOT_NAME) {
      setMissingConfig(true);
      onMissingConfig?.();
      return;
    }

    const container = containerRef.current;
    if (!container || container.hasChildNodes()) return;

    window.onTelegramAuth = (user: TelegramUser) => callbacks.current.onLogin(user);

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", TELEGRAM_BOT_NAME);
    script.setAttribute("data-size", "large");
    // data-request-* намеренно нет: виджет подписывает только те поля, что реально
    // запросил, а /auth/telegram пересобирает check-строку по модели TelegramAuthData.
    // Любое лишнее поле в payload (name, email, phone) ломает сравнение HMAC — вход
    // падал бы с 401 при полностью корректной подписи Telegram.
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.async = true;
    container.appendChild(script);

    return () => {
      delete window.onTelegramAuth;
      container.replaceChildren();
    };
  }, []);

  if (missingConfig) {
    return (
      <div className="text-xs text-text-tertiary text-center py-3 px-4 bg-surface-50 border border-border rounded-xl">
        Вход через Telegram выключен: собери фронт с <code className="text-text-secondary">VITE_TELEGRAM_BOT_NAME</code> (имя бота без «@») и задай{" "}
        <code className="text-text-secondary">TELEGRAM_BOT_TOKEN</code> на бэкенде — иначе подпись пользователя нечем проверить.
      </div>
    );
  }

  return <div ref={containerRef} className="flex justify-center" />;
}
