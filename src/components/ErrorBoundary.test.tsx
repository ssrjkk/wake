import type { ReactElement, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

// Sentry подменяется целиком: настоящий SDK в тесте тянет сеть и инициализацию,
// а проверяется здесь только то, что ошибка до него дошла.
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("@sentry/react", () => sentry);

// React печатает пойманную ошибку сам — это не сбой теста, а его предмет.
let logged: MockInstance<typeof console.error>;

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  sentry.captureException.mockClear();
  logged.mockRestore();
});

function Boom({ message = "свеча погасла" }: { message?: string }): ReactElement {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  it("не трогает содержимое, пока дети не падают", () => {
    render(
      <ErrorBoundary>
        <p>терминал</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("терминал")).toBeTruthy();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("гасит упавшего ребёнка и показывает панель", () => {
    render(
      <ErrorBoundary>
        <Boom />
        <p>терминал</p>
      </ErrorBoundary>,
    );
    expect(screen.queryByText("терминал")).toBeNull();
    expect(screen.getByText("Что-то пошло не так")).toBeTruthy();
    expect(screen.getByText(/Попробуй обновить страницу/)).toBeTruthy();
    expect(screen.getByText("свеча погасла")).toBeTruthy();
  });

  it("ставит свой fallback вместо панели", () => {
    const fallback: ReactNode = <p>свой экран</p>;
    render(
      <ErrorBoundary fallback={fallback}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("свой экран")).toBeTruthy();
    expect(screen.queryByText("Что-то пошло не так")).toBeNull();
  });

  it("отдаёт в Sentry ошибку и стек компонентов", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = sentry.captureException.mock.calls[0] as [
      Error,
      { extra: { componentStack: string } },
    ];
    expect(error.message).toBe("свеча погасла");
    expect(context.extra.componentStack).toContain("Boom");
  });

  it("кнопка перезагружает страницу", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { reload },
    });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Обновить страницу/ }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
