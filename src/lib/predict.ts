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
// Размер страницы витрины. Бэкенд ограничивает ответ (GET /predict/markets,
// limit ≤ 200) и порядок — по дедлайну, поэтому первая страница это «что
// закрывается раньше», а не «что случайнее».
export const PREDICT_PAGE_SIZE = 50;

export function getPredictMarkets(
  status: PredictStatus = "open",
  offset = 0,
  limit = PREDICT_PAGE_SIZE,
): Promise<PredictMarket[]> {
  return backendJson<PredictMarket[]>(
    `/predict/markets?status=${status}&limit=${limit}&offset=${offset}`,
  );
}

// Позиции юзера: бэкенд отдаёт только строки с shares > 0, поэтому полностью
// проданная позиция исчезает из списка — это не ошибка выборки, а следствие того,
// что держать нечего. Чей это список, решает токен в заголовке, а не user_id в
// адресе: позиции видны в публичной статистике рынка, и до перехода на сессию
// их можно было прочитать и сыграть на чужом месте одной подменой query.
export function getPredictPositions(): Promise<PredictPosition[]> {
  return backendJson<PredictPosition[]>("/predict/positions");
}

export function previewPredictTrade(marketId: string, outcome: "yes" | "no", shares: number): Promise<{ cost_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/preview?outcome=${outcome}&shares=${shares}`);
}

// shares < 0 — продажа части позиции; бэкенд считает по той же LMSR-кривой и
// возвращает отрицательный cost, то есть деньги возвращаются юзеру.
//
// limitPrice — худшая цена одной доли, которую человек согласен принять. Поле
// бэкенда обязательно и лежит в (0, 1], поэтому у вызова нет значения по
// умолчанию: «забыли посчитать предел» не должно означать «проскальзывание не
// ограничено».
export function tradePredictMarket(
  marketId: string,
  outcome: "yes" | "no",
  shares: number,
  limitPrice: number,
): Promise<{ cost_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/trade`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome, shares, limit_price: limitPrice }),
  });
}

// Запас на движение пула между /preview и POST, в долях от цены. 1% — не
// выученное число: типичный LMSR-шаг на одной сделке в 10 доли рынка с b=100
// около 0.05 цента на долю, то есть для доли около 0.5 это ~0.01%, и запас в
// 0.01 остаётся на два порядка больше обычного хода, но всё ещё далеко от
// номинала. Без запаса собственный клик почти всегда получал бы отказ.
export const PREDICT_SLIPPAGE_TOLERANCE = 0.01;

// Разряд предела: 1e-6 — то же число знаков, которым бэкенд печатает отказ
// (`:.6f`), поэтому человек видит в карточке ровно те цифры, что попадут в
// запрос и в текст отказа.
const PRICE_STEP = 1e6;

/** Худшая цена одной доли по счёту из /preview.
 *
 * cost — положительный у покупки, отрицательный у продажи; shares — тот же
 * знак, с которым пойдёт запрос. Предел берётся из той же цифры, что показана
 * человеку, и двигается в сторону невыгоды: покупателю вверх, продавцу вниз.
 * Однополее округление отклоняло бы как раз выгодные сделки, а предела вообще
 * без направления не существует.
 *
 * Требование к входу: cost и shares конечны и shares ≠ 0. Вызов это и гарантирует
 * — кнопка подтверждения выключена, пока карточка не посчитана. */
export function worstSharePrice(cost: number, shares: number): number {
  const avg = Math.abs(cost) / Math.abs(shares);
  const bound =
    shares > 0
      ? avg * (1 + PREDICT_SLIPPAGE_TOLERANCE)
      : avg * (1 - PREDICT_SLIPPAGE_TOLERANCE);
  return shares > 0
    ? Math.min(1, Math.ceil(bound * PRICE_STEP) / PRICE_STEP)
    : Math.max(1 / PRICE_STEP, Math.floor(bound * PRICE_STEP) / PRICE_STEP);
}

// Выплата идёт субъекту токена: до сессии сюда приезжал user_id, и, зная чужой
// id, можно было забрать чужой выигрыш.
export function claimPredictMarket(marketId: string): Promise<{ payout_usd: number }> {
  return backendJson(`/predict/markets/${encodeURIComponent(marketId)}/claim`, { method: "POST" });
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
