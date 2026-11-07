// Интервал, который стоит, пока страницу не видно.
//
// Повод: панели опрашивают Lighter, Arcus и бэкенд по своим таймерам (лента
// сделок — каждые 4 с), и до этого правила каждый такой таймер жил, пока жива
// вкладка. В Telegram-мини-аппе вебвью не закрывается, когда пользователь
// уходит в чат: страница остаётся видимой для браузера и невидимой для человека,
// и часы опроса идут в пустоту — трафик к публичному REST биржи и к бэкенду,
// который никто не читает. Поэтому «скрыто» здесь — это два независимых сигнала:
// document.hidden для вкладки и isActive из Telegram SDK (Bot API 8.0+) для
// свёрнутого мини-аппа.
//
// На возврате из фона тик исполняется сразу: человек, открывший вкладку или
// развернувший мини-апп, обязан увидеть свежие числа, а не ждать очередного
// полного периода.

import { ensureTelegramSdk, isTelegramInactive, isTelegramWebView, type TelegramSdk } from "./telegram";

function isHidden(): boolean {
  if (typeof document !== "undefined" && document.hidden) return true;
  return isTelegramInactive();
}

/** Запустить опрос; вернуть функцию остановки. Обязанность вызывающего —
 *  снять его при размонтировании, иначе слушатели висят на документе и на
 *  Telegram SDK навсегда.
 *
 *  `tick` может быть асинхронным: панели поднимают запрос и не ждут ответа —
 *  результат им приходит через then/catch, а ожидание в интервале означало бы
 *  наложение ответа на новый тик. */
export function setIntervalWhenVisible(tick: () => void | Promise<unknown>, ms: number): () => void {
  const id = setInterval(() => {
    // void: обещание здесь не ждут намеренно — панель получает результат через
    // свои then/catch, а ожидание внутри интервала накладывало бы ответ на
    // следующий тик.
    if (!isHidden()) void tick();
  }, ms);

  const onVisible = () => {
    if (!isHidden()) void tick();
  };
  document.addEventListener("visibilitychange", onVisible);

  // Мини-апп разворачивается без visibilitychange: страница всё это время была
  // видимой, менялось только поле isActive. Событие activated есть там же, где и
  // isActive, — с Bot API 8.0. На старых клиентах слушателя просто не будет, а
  // isActive останется undefined, то есть опрос продолжится как раньше.
  let cancelled = false;
  let detachTelegram: (() => void) | null = null;
  const attach = (sdk: TelegramSdk | null) => {
    if (cancelled || !sdk?.onEvent) return;
    sdk.onEvent("activated", onVisible);
    detachTelegram = () => sdk.offEvent?.("activated", onVisible);
  };
  // SDK к этому моменту может быть уже загружен (панель открыта не первой) или
  // ещё грузиться (первый экран мини-аппа). Ждать его вне Telegram нечего.
  if (window.Telegram?.WebApp) attach(window.Telegram.WebApp);
  else if (isTelegramWebView()) {
    void ensureTelegramSdk().then((sdk) => {
      if (cancelled) return;
      attach(sdk);
    });
  }

  return () => {
    cancelled = true;
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
    detachTelegram?.();
    detachTelegram = null;
  };
}
