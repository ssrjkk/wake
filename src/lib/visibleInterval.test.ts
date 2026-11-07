import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setIntervalWhenVisible } from "./visibleInterval";

// Скрытость страницы в jsdom — геттер на прототипе, а не обычное поле: его надо
// переопределять, иначе присваивание молча создаёт своё свойство на экземпляре,
// и проверка работала бы с одним значением всегда.
function setHidden(hidden: boolean) {
  Object.defineProperty(Document.prototype, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

// Мини-апп Telegram: страница «видима» для браузера, а человек уже в чате.
// Состояние приходит только полем isActive и событием activated.
function installTelegram(isActive: boolean) {
  const handlers = new Map<string, () => void>();
  const webApp = {
    isActive,
    onEvent: (event: string, handler: () => void) => {
      handlers.set(event, handler);
    },
    offEvent: (event: string) => {
      handlers.delete(event);
    },
  };
  window.Telegram = { WebApp: webApp };
  return {
    activate() {
      webApp.isActive = true;
      handlers.get("activated")?.();
    },
    handlers,
  };
}

describe("setIntervalWhenVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (Document.prototype as unknown as { hidden?: unknown }).hidden;
    delete (window as { Telegram?: unknown }).Telegram;
  });

  function visibilityChange() {
    document.dispatchEvent(new Event("visibilitychange"));
  }

  it("тикает по расписанию, пока страницу видно", () => {
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 1000);
    vi.advanceTimersByTime(3000);
    stop();
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("не тратит ни одного запроса, пока вкладка скрыта", () => {
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 1000);
    setHidden(true);
    vi.advanceTimersByTime(10_000);
    stop();
    expect(tick).not.toHaveBeenCalled();
  });

  it("обновляет сразу при возврате из фона, не дожидаясь полного периода", () => {
    // Человек обязан увидеть свежие числа в тот момент, когда он снова смотрит
    // на экран: следующий тик через 20–60 с был бы «загружаю…» на открытых
    // глазах.
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 5000);
    setHidden(true);
    vi.advanceTimersByTime(20_000);
    setHidden(false);
    visibilityChange();
    stop();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("не реагирует на событие, когда страница всё ещё скрыта", () => {
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 1000);
    setHidden(true);
    visibilityChange();
    stop();
    expect(tick).not.toHaveBeenCalled();
  });

  it("после stop() не оставляет ни таймера, ни слушателя", () => {
    // Счётчик слушателей на document — единственная проверка, что снятие
    // действительно снимает: без removeEventListener панель, открытая сорок раз,
    // оставила бы сорок живых колбэков на одном документе.
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 1000);
    expect(add).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    stop();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    setHidden(false);
    visibilityChange();
    vi.advanceTimersByTime(5000);
    add.mockRestore();
    remove.mockRestore();
    expect(tick).not.toHaveBeenCalled();
  });

  it("не опрашивает свёрнутый мини-апп, хотя вкладка «видима»", () => {
    // document.hidden в вебвью Telegram остаётся false, когда человек ушёл в
    // чат: единственный признак — isActive из Bot API 8.0.
    installTelegram(false);
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 1000);
    vi.advanceTimersByTime(10_000);
    stop();
    expect(tick).not.toHaveBeenCalled();
  });

  it("обновляет сразу при разворачивании мини-аппа", () => {
    const telegram = installTelegram(false);
    const tick = vi.fn();
    const stop = setIntervalWhenVisible(tick, 5000);
    vi.advanceTimersByTime(20_000);
    expect(tick).not.toHaveBeenCalled();
    telegram.activate();
    stop();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("снимает подписку на activated вместе с интервалом", () => {
    const telegram = installTelegram(true);
    const stop = setIntervalWhenVisible(vi.fn(), 1000);
    expect(telegram.handlers.has("activated"), "подписка создана").toBe(true);
    stop();
    expect(telegram.handlers.has("activated"), "подписка снята").toBe(false);
  });
});
