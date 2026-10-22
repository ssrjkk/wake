import { StrictMode } from "react";
import { render, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramLogin } from "./TelegramLogin";

const config = vi.hoisted(() => ({ botName: "" }));
vi.mock("../lib/config", () => ({ get TELEGRAM_BOT_NAME() { return config.botName; } }));

beforeEach(() => { config.botName = ""; });
afterEach(cleanup);

const user = { id: 123, first_name: "Trader", auth_date: 1000, hash: "signed" };

describe("TelegramLogin", () => {
  it("explains missing configuration without loading the widget", () => {
    const onMissingConfig = vi.fn();
    const { container, getByText } = render(<TelegramLogin onLogin={vi.fn()} onMissingConfig={onMissingConfig} />);
    expect(getByText(/Вход через Telegram выключен/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(onMissingConfig).toHaveBeenCalledOnce();
  });

  it("mounts exactly one configured widget under StrictMode", () => {
    config.botName = "waketrade_bot";
    const onLogin = vi.fn();
    const { container } = render(<StrictMode><TelegramLogin onLogin={onLogin} /></StrictMode>);
    const scripts = container.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("data-telegram-login")).toBe("waketrade_bot");
    window.onTelegramAuth?.(user);
    expect(onLogin).toHaveBeenCalledWith(user);
  });

  it("uses the current callback without remounting the widget", () => {
    config.botName = "waketrade_bot";
    const previous = vi.fn();
    const current = vi.fn();
    const { container, rerender } = render(<TelegramLogin onLogin={previous} />);
    const script = container.querySelector("script");
    rerender(<TelegramLogin onLogin={current} />);
    expect(container.querySelector("script")).toBe(script);
    window.onTelegramAuth?.(user);
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith(user);
  });

  it("removes the callback and widget when unmounted", () => {
    config.botName = "waketrade_bot";
    const { container, unmount } = render(<TelegramLogin onLogin={vi.fn()} />);
    unmount();
    expect(window.onTelegramAuth).toBeUndefined();
    expect(container.querySelector("script")).toBeNull();
  });
});
