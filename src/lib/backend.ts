// Единственная точка, через которую фронтенд ходит в бэкенд Wake (backend/app.py).
//
// Повод появиться: «бэкенда нет» — штатное состояние сайта, а не редкая поломка.
// Фронтенд лежит на Cloudflare Pages и отдаёт index.html на любой путь (public/_redirects),
// поэтому запрос к API без развернутого бэкенда приходит обратно на сам сайт: 200 + HTML.
// Наивный res.json() на этом отвечает SyntaxError с куском разметки в тексте, и это
// сообщение юзер видит в панели вместо внятной причины.
import { BACKEND_URL } from "./config";
import { authHeader, clearSession } from "./session";
import { BACKEND_TIMEOUT_MS, isAbortError, isTimeoutError, timeoutText } from "./net";

// Событие уходит, когда бэкенд отверг токен: приложение чистит состояние входа,
// а не ждёт, пока пользователь сам сообразит, почему панели пустые.
export const SIGNED_OUT_EVENT = "wake:signed-out";

function signedOut() {
  clearSession();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

// message из {error: {code, message}} — то, что бэкенд написал для человека;
// голый JSON в тосте читается как поломка клиента.
const STARLETTE_DEFAULTS = new Set(["Not Found", "Method Not Allowed"]);

function backendMessage(body: string, status: number, path: string): string {
  let detail: string | null = null;
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; message?: string };
      detail?: unknown;
    };
    if (parsed.error?.message) {
      return parsed.error.code ? `${parsed.error.message} (${parsed.error.code})` : parsed.error.message;
    }
    // Тело без нашего конверта: {"detail": "..."} у сервиса старше единого
    // формата ошибок и массив деталей у валидации FastAPI. Оба разбираются в
    // человеческую строку, иначе панель печатает сырой JSON.
    if (typeof parsed.detail === "string") detail = parsed.detail;
    else if (Array.isArray(parsed.detail)) {
      const msgs = parsed.detail
        .map((item) => (item && typeof item === "object" && "msg" in item ? String((item as { msg: unknown }).msg) : ""))
        .filter(Boolean);
      if (msgs.length) detail = msgs.slice(0, 2).join("; ");
    }
  } catch {
    // тело не JSON (прокси, страница ошибки хостинга) — показываем его как есть
  }
  // 404/405 на известный маршруту — это не «данных нет», а расхождение версий:
  // сайт собран новее сервиса, который стоит по этому адресу. Дефолтная фраза
  // Starlette («Not Found») ничего человеку не объясняет, а осмысленный detail
  // (например «нет ставок funding по символу X») остаётся собой.
  if ((status === 404 || status === 405) && (detail === null || STARLETTE_DEFAULTS.has(detail))) {
    return `Бэкенд Wake не знает маршрут ${path} (${status}): сервис по этому адресу старше сборки сайта — обновите его или укажите другой адрес.`;
  }
  if (detail) return detail;
  return body || `Бэкенд Wake ${status}`;
}

export async function backendJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  // Не показываем localhost URL пользователю — это выглядит непрофессионально на продакшене
  const isLocalhost = BACKEND_URL.includes("localhost") || BACKEND_URL.includes("127.0.0.1");
  try {
    // Токен подмешивается сюда, а не в каждый вызов: иначе из десяти мест один
    // обязательно забыл бы заголовок, и ошибка выглядела бы как «нет данных».
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(authHeader())) headers.set(key, value);
    // Свой сигнал у вызывающего есть не всегда, а висящее соединение без ответа
    // — это «загружаю…» до конца открытия вкладки. probeBackend передаёт свой,
    // более короткий: он опрашивает сервис, который может быть не поднят.
    res = await fetch(`${BACKEND_URL}${path}`, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(BACKEND_TIMEOUT_MS) });
  } catch (e) {
    // Отмена по сигналу вызывающего — не ошибка сервиса: пусть тот, кто
    // отменил, разбирается с результатом сам.
    if (isAbortError(e)) throw e;
    if (isTimeoutError(e)) {
      // DOMException с "signal timed out" в тосте не читается как объяснение.
      throw new Error(
        isLocalhost
          ? `Бэкенд Wake ${timeoutText(BACKEND_TIMEOUT_MS)}. Функция требует подключённый сервер.`
          : `Бэкенд Wake ${timeoutText(BACKEND_TIMEOUT_MS)}: ${BACKEND_URL}`,
        { cause: e }
      );
    }
    const message = isLocalhost
      ? "Сервер недоступен. Функция требует подключённый бэкенд Wake."
      : `${BACKEND_URL} не отвечает (${e instanceof Error ? e.message : String(e)}). Wake — отдельный сервис, в сборку сайта он не входит.`;
    throw new Error(message, { cause: e });
  }
  if (res.status === 401) {
    // Токен просрочен или подписан другим секретом: держать его дальше нельзя,
    // каждый следующий запрос получил бы тот же 401.
    signedOut();
    throw new Error(backendMessage(await readText(res), res.status, path));
  }
  if (!res.ok) {
    // Текст ошибки от бэкенда говорящий (409 «рынок уже резолвлен», 400 «недостаточно
    // shares»), поэтому он идёт в сообщение, а не голый код состояния.
    throw new Error(backendMessage(await readText(res), res.status, path));
  }
  try {
    return (await res.json()) as T;
  } catch {
    const isLocalhost = BACKEND_URL.includes("localhost") || BACKEND_URL.includes("127.0.0.1");
    if (isLocalhost) {
      throw new Error("Бэкенд Wake не настроен. Функция требует подключённый сервер.");
    }
    throw new Error(`по адресу ${BACKEND_URL} бэкенда Wake нет: вместо JSON вернулась страница сайта.`);
  }
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Текст ошибки для панелей и тостов. String(error) даёт «Error: ...», и этот
// префикс юзер видел в баннере; плюс длинная строка бэкенда растягивает табличную
// ячейку, поэтому срез с многоточием, а не обрыв посреди слова.
export function errorText(e: unknown, max = 140): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export type BackendHealth = { status: "ok"; network: string; dry_run: boolean };

export type BackendReady = { status: string; checks?: Record<string, string> };

export async function probeBackend(): Promise<BackendHealth> {
  const health = await backendJson<BackendHealth>("/health", { signal: AbortSignal.timeout(5000) });
  // /ready читается напрямую, а не через backendJson: его отказ — штатный ответ
  // (503 с перечнем проверок), а не ошибка транспорта, и перечень нужен баннеру,
  // чтобы назвать причину, а не утверждать «недоступен» про отвечающий сервис.
  const res = await fetch(`${BACKEND_URL}/ready`, { signal: AbortSignal.timeout(5000) });
  const ready = (await res.json().catch(() => null)) as BackendReady | null;
  if (!ready || ready.status !== "ready") {
    const failing = Object.entries(ready?.checks ?? {})
      .filter(([, state]) => state !== "ok")
      .map(([name, state]) => `${name}: ${state}`);
    throw new Error(
      failing.length
        ? `Бэкенд Wake отвечает, но не готов — ${failing.join(", ")}`
        : "Бэкенд Wake отвечает, но не готов"
    );
  }
  return health;
}
