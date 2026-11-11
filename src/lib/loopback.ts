// Единственный владелец правила «этот адрес — сама машина».
//
// Про петлю спрашивают два места и обязаны отвечать одинаково: сборка (боевая
// сборка с петлёй в VITE_BACKEND_URL уезжает на прод молча — каждый посетитель
// стучался бы в собственную машину, а чип бэкенда честно писал бы «недоступен»)
// и текст ошибки в панели (адрес машины в продакшене выглядит непрофессионально,
// поэтому на машине говорят про сервер, а вне неё называют адрес).
//
// Написаний у петли больше, чем два литерала: localhost, весь 127.0.0.0/8 и ::1.
// Разбирает адрес в src/lib/url.ts, поэтому регистр хоста, скобки IPv6 и форма
// «host:port без схемы» (её `new URL` читает как схему «localhost:» с пустым
// хостом, и проверка петли на ней просто молчала) дают один и тот же ответ.
// Слово «localhost» в пути или в query чужого адреса местным его не делает.

import { urlHost } from "./url";

/** Уже разобранное имя хоста: петля это она или нет. */
export function isLoopbackHost(host: string | null): boolean {
  if (host === null) return false;
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

export function isLoopbackBackend(url: string): boolean {
  return isLoopbackHost(urlHost(url));
}

/** Причина, по которой сборка на этом адресе не состоится, или null. */
export function loopbackBuildProblem(mode: string, backend: string | undefined): string | null {
  if (mode !== "production" || !backend || !isLoopbackBackend(backend)) return null;
  return (
    `VITE_BACKEND_URL=${backend}: боевая сборка не может указывать фронтенд на loopback — ` +
    "каждый посетитель будет стучаться в собственную машину. Убери переменную " +
    "(дефолт в src/lib/config.ts — развёрнутый бэкенд) или поставь боевой адрес."
  );
}
