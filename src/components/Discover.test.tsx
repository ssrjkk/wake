import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Discover from "./Discover";

/* Витрина лидеров после отказа бэкенда. Заглушки рисуются, пока `leaders ===
   null`, а ошибка этот флаг не сбрасывает: панель успевала написать «список
   лидеров не загружен» и тут же держать три карточки «ещё едет». Живая причина —
   снимок docs/screenshots/discover-1440.png от 2026-11-17: под строкой ошибки
   лежали три пустых карточки, и e2e этого не видел, потому что его гейт ждёт
   `.skeleton`, а эти заглушки собраны руками в обход `ui.tsx`. */

function mountFailing() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch")))
  );
  return render(<Discover setCopyModal={() => {}} />);
}

describe("Discover при отказе бэкенда", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("не держит карточки-заглушки рядом с текстом ошибки", async () => {
    const { container } = mountFailing();
    await waitFor(() =>
      expect(container.textContent).toContain("Список лидеров не загружен")
    );
    expect(container.querySelectorAll(".leader-card")).toHaveLength(0);
  });

  it("называет причину отказа, а не молчит", async () => {
    const { container } = mountFailing();
    await waitFor(() => expect(container.querySelector(".notice-error")).toBeTruthy());
    expect(container.querySelector(".notice-error")?.textContent).toContain("Failed to fetch");
  });
});
