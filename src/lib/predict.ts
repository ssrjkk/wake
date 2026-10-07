// Predict-данные в одном месте: обзор и вкладка Predict читают одни и те же
// эндпоинты через один типизированный слой. Два одинаковых fetch с разными
// фильтрами расходились бы по числам на одной странице, а список полей рынка
// здесь ещё и зафиксирован типом — бэкенд отдаёт именно их (api/predict.py).
import { backendJson } from "./backend";

export type PredictStatus = "open" | "resolved" | "all";

export type PredictMarket = {
  id: string;
  kind: "price" | "event";
  question: string;
  lighter_market_id: number | null;
  threshold: number | null;
  comparator: string | null;
  resolve_at: number;
  b: number;
  status: "open" | "resolved";
  outcome: string | null;
  // Кто закрыл: авто-резолвер пишет "auto:lighter_mark_price", куратор — свой id.
  // Поле из той же таблицы predict_markets, и по нему видно, чьё решение — машина
  // или человек.
  resolved_by: string | null;
  evidence_url: string | null;
  price_yes: number;
  price_no: number;
  // volume_usd — сумма |cost| сделок через Wake, а не рыночный объём LMSR-пула.
  volume_usd: number;
  trade_count: number;
};

export type PredictPosition = {
  market_id: string;
  question: string;
  kind: "price" | "event";
  market_status: "open" | "resolved";
  market_outcome: string | null;
  resolve_at: number;
  outcome: "yes" | "no";
  shares: number;
  net_cost_usd: number;
  avg_entry_usd: number;
  mark_price: number;
  mark_value_usd: number;
  claimable_usd: number;
  claimed: boolean;
};

// Все запросы идут через backendJson (lib/backend.ts): там различены «бэкенд не
// отвечает», «бэкенд вернул ошибку» и «бэкенда нет вовсе» — на хостинге SPA-заглушка
// отвечает 200 + HTML, и голый res.json() печатал бы SyntaxError вместо причины.
export function getPredictMarkets(status: PredictStatus = "open"): Promise<PredictMarket[]> {
  return backendJson<PredictMarket[]>(`/predict/markets?status=${status}`);
}

// Позиции юзера: бэкенд отдаёт только строки с shares > 0, поэтому полностью
// проданная позиция исчезает из списка — это не ошибка выборки, а следствие того,
// что держать нечего.
export function getPredictPositions(userId: string): Promise<PredictPosition[]> {
  return backendJson<PredictPosition[]>(`/predict/positions?user_id=${encodeURIComponent(userId)}`);
}

export function previewPredictTrade(marketId: string, outcome: "yes" | "no", shares: number): Promise<{ cost_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/preview?outcome=${outcome}&shares=${shares}`);
}

// shares < 0 — продажа части позиции; бэкенд считает по той же LMSR-кривой и
// возвращает отрицательный cost, то есть деньги возвращаются юзеру.
export function tradePredictMarket(marketId: string, userId: string, outcome: "yes" | "no", shares: number): Promise<{ cost_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, outcome, shares }),
  });
}

export function claimPredictMarket(marketId: string, userId: string): Promise<{ payout_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/claim?user_id=${encodeURIComponent(userId)}`, { method: "POST" });
}

// Доля от $1: share победившего исхода стоит $1 после резолюции, проигравшего — $0.
export function predictOutcomeWorth(outcome: string | null, positionOutcome: "yes" | "no"): number {
  if (outcome == null) return 0;
  return outcome === positionOutcome ? 1 : 0;
}

// Тот же текст, что печатает бот по /predict: дни и часы, минуты только внутри
// суток. Отдельная функция, потому что «осталось 3д» и «осталось 72ч» — это один
// и тот же срок в разных местах экрана, и расходиться они не должны.
export function predictTimeLeft(resolveAt: number, now: Date = new Date()): string {
  const total = Math.floor((resolveAt * 1000 - now.getTime()) / 1000);
  if (total <= 0) return "срок истёк";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `осталось ${days}д ${hours}ч`;
  if (hours) return `осталось ${hours}ч ${minutes}м`;
  return `осталось ${minutes}м`;
}
