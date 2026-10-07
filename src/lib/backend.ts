// Единственная точка, через которую фронтенд ходит в бэкенд Wake (backend/app.py).
//
// Повод появиться: «бэкенда нет» — штатное состояние сайта, а не редкая поломка.
// Фронтенд лежит на Cloudflare Pages и отдаёт index.html на любой путь (public/_redirects),
// поэтому запрос к API без развернутого бэкенда приходит обратно на сам сайт: 200 + HTML.
// Наивный res.json() на этом отвечает SyntaxError с куском разметки в тексте, и это
// сообщение юзер видит в панели вместо внятной причины.
import { BACKEND_URL } from "./config";

export async function backendJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, init);
  } catch (e) {
    // Не показываем localhost URL пользователю — это выглядит непрофессионально на продакшене
    const isLocalhost = BACKEND_URL.includes("localhost") || BACKEND_URL.includes("127.0.0.1");
    const message = isLocalhost
      ? "Сервер недоступен. Функция требует подключённый бэкенд Wake."
      : `${BACKEND_URL} не отвечает (${e instanceof Error ? e.message : String(e)}). Wake — отдельный сервис, в сборку сайта он не входит.`;
    throw new Error(message);
  }
  if (!res.ok) {
    // Текст ошибки от бэкенда говорящий (409 «рынок уже резолвлен», 400 «недостаточно
    // shares»), поэтому он идёт в сообщение, а не голый код состояния.
    throw new Error((await readText(res)) || `Бэкенд Wake ${res.status}`);
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

// Разведка при старте. /health отдаёт JSON только бэкенд Wake, а Pages на любой
// неизвестный путь отвечает index.html со статусом 200 — так что именно этот
// запрос отличает «бэкенд не развернут» от «бэкенд есть».
export async function probeBackend(): Promise<BackendHealth> {
  return backendJson<BackendHealth>("/health", { signal: AbortSignal.timeout(5000) });
}
