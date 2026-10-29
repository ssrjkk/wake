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

describe("setIntervalWhenVisible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (Document.prototype as unknown as { hidden?: unknown }).hidden;
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
});
