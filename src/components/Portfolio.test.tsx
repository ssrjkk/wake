import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Portfolio from "./Portfolio";
import type { MirrorLogRow } from "../lib/lighter";
import type { Following } from "./types";

/* Журнал копи-движка — единственное место, где подписчик видит, что его деньги
   сделали на площадке. Формы строк взяты из ответа `/mirror-log` (ключи — поля
   `MirrorLogRow`, значения — из test_leader_listener.py, где движок прогоняется
   на фикстурах ленты). Проверяются три инварианта:
     1. исполненный размер показан отделным числом от заказанного — иначе
        частичный филл выглядит полным;
     2. у непрочитанной сверки (`filled_base_amount = null`) числа нет вовсе:
        «неизвестно» не имеет права печататься как «исполнилось 0.0000»;
     3. `sent` и `filled` — разные статусы: первый значит «заявка принята»,
        второй — «площадка подтвердила сделку».
*/

afterEach(() => cleanup());

const row = (over: Partial<MirrorLogRow>): MirrorLogRow => ({
  id: "ml-1",
  follow_id: "follow-1",
  market_id: 0,
  side: "long",
  base_amount: 0.01,
  filled_base_amount: null,
  reduce_only: 0,
  status: "sent",
  reason: null,
  tx_hash: null,
  created_at: 1_762_000_000,
  leader_handle: "@fields",
  ...over,
});

const follow: Following = {
  followId: "follow-1",
  leaderId: "leader-1",
  handle: "@fields",
  allocationUsd: 400,
  maxLeverage: 3,
  mirroredSize: 0,
  paused: false,
};

function mount(rows: MirrorLogRow[], accountLookupError: string | null = null) {
  const respond = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/mirror-log")) {
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    );
  });
  vi.stubGlobal("fetch", respond);
  return render(
    <Portfolio
      following={[follow]}
      followsError={null}
      setTab={() => {}}
      togglePause={() => {}}
      unfollow={() => {}}
      signedIn
      lighterAccountIndex={null}
      accountLookupError={accountLookupError}
      hasWallet
      markets={[]}
    />
  );
}

beforeEach(() => {
  window.localStorage.clear();
  /* Окно журнала считает высоту строк через ResizeObserver — в jsdom его нет,
     и монтирование падало бы до первого ассерта. Заглушка ровно та же, что в
     App.test.tsx: размеры в тестовой среде не проверяются, проверяется
     содержимое таблицы. */
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("журнал копи-движка", () => {
  it("показывает исполненный размер рядом с заказанным", async () => {
    mount([row({ status: "partially_filled", base_amount: 0.01, filled_base_amount: 0.004 })]);
    await screen.findByText("partially_filled");
    expect(screen.getByText("0.0100", { exact: false })).toBeTruthy();
    // Число площадки — отдельным текстом, а не «0.0100» из колонки «Заявлено».
    expect(screen.getByText(/исполнено 0\.0040/)).toBeTruthy();
  });

  it("у снятого с цены IOC исполненный размер — ноль, и он напечатан", async () => {
    mount([row({ status: "unfilled", base_amount: 0.01, filled_base_amount: 0 })]);
    await screen.findByText("unfilled");
    expect(screen.getByText(/исполнено 0\.0000/)).toBeTruthy();
  });

  it("непрочитанная сверка не имеет права выглядеть нулём", async () => {
    mount([row({ status: "unconfirmed", base_amount: 0.01, filled_base_amount: null })]);
    await screen.findByText("unconfirmed");
    expect(screen.queryByText(/исполнено 0\.0000/)).toBeNull();
    expect(screen.queryByText(/исполнено/)).toBeNull();
  });

  it("sent и filled — разные статусы, и оба читаются", async () => {
    mount([
      row({ id: "ml-sent", status: "sent", filled_base_amount: null }),
      row({ id: "ml-filled", status: "filled", base_amount: 0.01, filled_base_amount: 0.01 }),
    ]);
    await screen.findByText("sent");
    expect(screen.getByText("filled")).toBeTruthy();
    // Разные статусы — разные чипы: «заявка принята» и «сделка есть» не имеют
    // права краситься в один цвет, это ровно та подмена, из-за которой снятый
    // с цены IOC выглядел исполненным. Оттенки переехали в тему, поэтому
    // здесь проверяется класс состояния, а не инлайн-фон строки: что классы
    // чипов действительно дают разные подложки, меряет e2e-гейт.
    const pill = (status: string) => screen.getByText(status);
    expect(pill("sent").classList).toContain("chip-info");
    expect(pill("filled").classList).toContain("chip-up");
    expect(pill("sent").className).not.toBe(pill("filled").className);
    // Подтверждённое исполнение целого ордера тоже называется числом: на «sent»
    // числа нет, и по одному только хэшу эти строки не развести.
    await waitFor(() => expect(screen.getByText(/исполнено 0\.0100/)).toBeTruthy());
  });
});

describe("состояние счёта Lighter", () => {
  it("не выдаёт ошибку поиска аккаунта за отсутствие аккаунта", async () => {
    mount([], "Lighter API 503");
    await act(async () => {});
    expect(screen.getByText(/Не удалось проверить аккаунт Lighter/)).toBeTruthy();
    expect(screen.getByText("Lighter API 503")).toBeTruthy();
    expect(screen.queryByText("Аккаунт на Lighter не найден")).toBeNull();
  });
});
