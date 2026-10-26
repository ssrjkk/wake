import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRowWindow } from "./useRowWindow";

// jsdom не знает ResizeObserver — он появляется только в настоящем браузере.
// Заглушка здесь, а не guard в продакшн-коде: наблюдатель в useRowWindow обязан
// быть, иначе список не пересчитает окно после MEDIA-запроса или разворота
// модалки, и «работает в тесте, падает в браузере» — ровно тот класс обмана,
// который этот файл и должен ловить.
//
// Колбэк вызывается в момент observe(), как это делает браузер (первая доставка
// положена по спецификации и происходит до отрисовки кадра): продакшн-код
// сознательно не измеряет сам контейнер в эффекте и живёт только событиями
// внешней системы.
class StubResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this);
  }

  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

function scrollable(clientHeight: number): HTMLDivElement {
  const node = document.createElement("div");
  Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
  return node;
}

describe("useRowWindow", () => {
  it("до появления контейнера рисует первые строки, а не весь список", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(246, 50));
    expect(result.current.start).toBe(0);
    // Полное окно здесь означало бы, что первый кадр модалки смонтирует все 246
    // строк и сожмётся только после измерения (замер: 413 мс против 40 мс).
    expect(result.current.end).toBeLessThan(30);
    expect(result.current.padBottom).toBe((246 - result.current.end) * 50);
  });

  // Первая версия брала RefObject и измеряла в эффекте с deps [ref, count, ...]:
  // появление модалки не меняет ни одного deps-значения, эффект не запускался, и
  // окно оставалось пустым — 246 строк списка и ноль отрисованных. Проверка
  // именно на этом: attach приходит ПОСЛЕ первого рендера.
  it("пересчитывает окно в момент, когда контейнер появился", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(246, 50));
    act(() => result.current.attach(scrollable(200)));

    // 200 px видимого = 4 строки + запас с обеих сторон, но не весь список
    expect(result.current.end - result.current.start).toBeLessThan(246 / 2);
    expect(result.current.start).toBe(0);
    expect(result.current.padTop).toBe(0);
    expect(result.current.padBottom).toBe((246 - result.current.end) * 50);
  });

  it("окно следует за прокруткой, а пустота сверху равна сдвигу", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(246, 50));
    const node = scrollable(200);
    act(() => result.current.attach(node));

    const first = result.current.start;
    node.scrollTop = 4_000; // 80-я строка
    act(() => {
      node.dispatchEvent(new Event("scroll"));
    });

    expect(result.current.start).toBeGreaterThan(first);
    expect(result.current.padTop).toBe(result.current.start * 50);
    expect(result.current.end).toBeLessThanOrEqual(246);
  });

  it("новое открытие списка не начинает кадр с прокрутки прошлого", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(246, 50));
    const old = scrollable(200);
    act(() => result.current.attach(old));
    old.scrollTop = 4_000;
    act(() => {
      old.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.start).toBeGreaterThan(0);

    // Модалка закрылась и открылась заново: узел другой, прокрутка его — ноль.
    // Без привязки замера к узлу первый кадр нарисовал бы середину прошлого
    // просмотра, а затем дёрнулся бы к началу.
    act(() => result.current.attach(scrollable(200)));
    expect(result.current.start).toBe(0);
    expect(result.current.padTop).toBe(0);
  });

  it("короткий список не получает пустоты под собой", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(3, 50));
    act(() => result.current.attach(scrollable(400)));
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(3);
    expect(result.current.padTop).toBe(0);
    expect(result.current.padBottom).toBe(0);
  });

  it("список короче окна рендерится целиком", () => {
    const { result } = renderHook(() => useRowWindow<HTMLDivElement>(246, 50));
    act(() => result.current.attach(scrollable(50 * 300)));
    expect(result.current.start).toBe(0);
    expect(result.current.end).toBe(246);
  });
});
