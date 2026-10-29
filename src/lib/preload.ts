// Новый деплой стирает старые файлы чанков, а открытая вкладка помнит старые
// имена. Клик по ленивой панели превращается в import(), который отвечает не
// модулем, а страницей 404 или index.html с 200 (так устроен catch-all в
// public/_redirects), и ErrorBoundary закрывает весь экран сообщением «Что-то
// пошло не так».
//
// Vite на такую неудачу шлёт событие vite:preloadError. Один перезаход забирает
// свежий index.html с новыми хэшами и возвращает человека туда, где он был; без
// него единственный выход — вручную нажать «Обновить страницу».
//
// Петля исключена временной меткой: если перезаход уже был меньше минуты назад,
// значит и новый бандл не грузится (не сеть, а сломанный деплой), и вместо
// бесконечной перезагрузки остаётся честный экран ошибки. Хранилище недоступно
// (приватный режим) — тоже без перезахода: метку некуда записать, а перезагружать
// вслепую значит не иметь защиты от петли вовсе.

const RELOAD_KEY = "wake.preload-reloaded-at";
const RELOAD_COOLDOWN_MS = 60_000;

export function installPreloadRecovery(win: Window = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    const now = Date.now();
    let last: number;
    try {
      last = Number(win.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    } catch {
      last = 0;
    }
    if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return;
    try {
      win.sessionStorage.setItem(RELOAD_KEY, String(now));
    } catch {
      return;
    }
    event.preventDefault();
    win.location.reload();
  });
}
