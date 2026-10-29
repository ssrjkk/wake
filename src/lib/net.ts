// Таймауты наружных запросов.
//
// Без них у фронтенда есть состояние «висит вечно»: TCP-соединение установлено,
// ответ не приходит, промис не исполняется никогда. Панель в этом случае держит
// «загружаю…», а интервалы опроса (15–60 с) добавляют поверх висящих запросов
// новые. Таймаут превращает это в строку ошибки, которую видно.
//
// Значения разные для разных источников намеренно: Wake-бэкенд держит базу и
// успевает ответить быстрее, чем публичный REST биржи, а /markets/overview
// заведомо дороже одного RTT (там 18 свечных запросов на сервере).

/** Сколько ждать ответ публичного REST (Lighter, Arcus). */
export const PUBLIC_TIMEOUT_MS = 10_000;

/** Сколько ждать ответ бэкенда Wake. */
export const BACKEND_TIMEOUT_MS = 15_000;

export function isTimeoutError(e: unknown): boolean {
  return errorName(e) === "TimeoutError";
}

/** Отменённый самим вызывающим запрос. Отдельно от таймаута нарочно: «нет
 *  ответа за 15 с» и «ты же сам отменил» — разные вещи, а name у обеих
 *  DOMException различается только этим. */
export function isAbortError(e: unknown): boolean {
  return errorName(e) === "AbortError";
}

function errorName(e: unknown): string {
  return e instanceof Error || e instanceof DOMException ? e.name : "";
}

/** Человек читает «нет ответа за 10 с», а не техническое "signal timed out". */
export function timeoutText(ms: number): string {
  return `нет ответа за ${Math.round(ms / 1000)} с`;
}

/** GET с таймаутом: висящее соединение обязано превратиться в ошибку, а не в
 *  вечный скелетон. */
export async function timedFetch(url: string, ms: number = PUBLIC_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw isTimeoutError(e) ? new Error(timeoutText(ms), { cause: e }) : e;
  }
}
