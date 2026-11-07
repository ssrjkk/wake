import { afterEach, describe, expect, it, vi } from "vitest";
import { installPreloadRecovery } from "./preload";

// Настоящая навигация в jsdom не реализована, поэтому окно подменяется ровно
// тем срезом, который читает обработчик: слушатель, хранилище и reload.
function fakeWindow(storage: Storage | null = window.sessionStorage) {
  const listeners = new Map<string, EventListener>();
  const reload = vi.fn();
  const win = {
    addEventListener: (type: string, handler: EventListener) => listeners.set(type, handler),
    sessionStorage: storage,
    location: { reload },
  } as unknown as Window;
  return {
    win,
    reload,
    fail(): Event {
      const event = new Event("vite:preloadError", { cancelable: true });
      listeners.get("vite:preloadError")?.(event);
      return event;
    },
  };
}

describe("installPreloadRecovery", () => {
  afterEach(() => {
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  it("перезагружает страницу и гасит ошибку чанка", () => {
    const probe = fakeWindow();
    installPreloadRecovery(probe.win);
    const event = probe.fail();
    expect(probe.reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented, "ошибка не всплывает до ErrorBoundary").toBe(true);
  });

  it("второй сбой за минуту не перезагружает — иначе сломанный деплой крутил бы петлю", () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00Z") });
    const probe = fakeWindow();
    installPreloadRecovery(probe.win);
    probe.fail();
    vi.advanceTimersByTime(30_000);
    const second = probe.fail();
    expect(probe.reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented, "второй сбой обязан дойти до ErrorBoundary").toBe(false);
  });

  it("после минуты новый деплой снова даёт один перезаход", () => {
    vi.useFakeTimers({ now: new Date("2026-10-29T12:00:00Z") });
    const probe = fakeWindow();
    installPreloadRecovery(probe.win);
    probe.fail();
    vi.advanceTimersByTime(61_000);
    probe.fail();
    expect(probe.reload).toHaveBeenCalledTimes(2);
  });

  it("без работающего sessionStorage не перезагружает: метки нет, петлю нечем остановить", () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    const probe = fakeWindow(broken);
    installPreloadRecovery(probe.win);
    const event = probe.fail();
    expect(probe.reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
