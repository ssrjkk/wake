import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Agent from "./Agent";
import Earn from "./Earn";

afterEach(() => cleanup());

describe("resource error states", () => {
  it("shows a leader lookup failure instead of publication-off", () => {
    render(
      <Earn
        isCopyable={false}
        setTab={() => {}}
        leaderId={null}
        leaderError="backend unavailable"
        leaderFeeBps={8}
        setLeaderFeeBps={() => {}}
        lighterAccountIndex={null}
      />,
    );
    expect(screen.getByText(/Не удалось прочитать состояние публикации/)).toBeTruthy();
    expect(screen.getByText(/backend unavailable/)).toBeTruthy();
    expect(screen.queryByText("Публикация выключена")).toBeNull();
  });

  it("shows a subscription lookup failure instead of a trial offer", () => {
    render(
      <Agent
        signedIn={false}
        subscription={null}
        subscriptionError="backend unavailable"
        currentMarket={undefined}
        setToast={() => {}}
        startTrial={() => {}}
      />,
    );
    expect(screen.getByText(/Не удалось прочитать подписку/)).toBeTruthy();
    expect(screen.getByText("backend unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Начать 14-дневный trial" })).toBeNull();
  });
});
