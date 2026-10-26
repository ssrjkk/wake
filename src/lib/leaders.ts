// One leader, assembled the same way everywhere it is shown: Wake's own DB rows
// (leaders + follows) for identity/fee/subscribers, Lighter's public account
// endpoint for capital and realised PnL. Discover and Earn must not disagree
// about the same trader, so the join lives here rather than in each component.
//
// Two ways to get there, and the difference is only who pays for it:
//   leaderFromHydrated — the server already joined everything (GET
//     /leaders/hydrated); the list of leaders costs one request.
//   buildLeader        — the client joins one leader by hand; used where a
//     single row is needed and it may be unpublished (Earn shows your own
//     leader even with the switch off, and /leaders hides inactive ones).
import {
  getAccountByIndex,
  getLeaderStats,
  type HydratedLeaderRow,
  type LeaderRow,
  type LighterPosition,
} from "./lighter";
import type { Leader, LeaderExchange } from "../components/types";

// Lighter answers with one row per market the account ever touched, most of them
// zero-size; "open positions" means the non-zero ones only.
export function positionsWithSize(positions: LighterPosition[]): LighterPosition[] {
  return positions.filter((p) => Math.abs(p.size) > 0);
}

export async function buildLeader(row: LeaderRow): Promise<Leader> {
  const [stats, account] = await Promise.all([
    getLeaderStats(row.id).catch(() => ({ follower_count: 0, total_aum_usd: 0 })),
    getAccountByIndex(row.lighter_account_index).catch(() => null),
  ]);
  const exchange: LeaderExchange | null = account
    ? {
        equityUsd: account.equityUsd,
        realizedPnlUsd: account.realizedPnlUsd,
        openPositions: positionsWithSize(account.positions),
      }
    : null;
  return {
    id: row.id,
    handle: row.handle,
    feeBps: row.fee_bps,
    lighterAccountIndex: row.lighter_account_index,
    since: row.created_at,
    followers: stats.follower_count,
    aumUsd: stats.total_aum_usd,
    exchange,
  };
}

/** Карточка из уже собранной сервером строки: ни одного лишнего запроса. */
export function leaderFromHydrated(row: HydratedLeaderRow): Leader {
  return {
    id: row.id,
    handle: row.handle,
    feeBps: row.fee_bps,
    lighterAccountIndex: row.lighter_account_index,
    since: row.created_at,
    followers: row.follower_count,
    aumUsd: row.total_aum_usd,
    // account: null — Lighter не ответил по этому счёту; карточка обязана
    // показать прочерк, а не нули: «$0 капитала» и «капитал неизвестен» для
    // человека, выбирающего у кого копировать, — это разные утверждения.
    exchange: row.account
      ? {
          equityUsd: row.account.equity_usd,
          realizedPnlUsd: row.account.realized_pnl_usd,
          openPositions: row.account.positions.map((p) => ({
            marketId: p.market_id,
            symbol: p.symbol,
            size: p.size,
            avgEntry: p.avg_entry,
            value: p.value,
            unrealizedPnl: p.unrealized_pnl,
            realizedPnl: p.realized_pnl,
            liquidationPrice: p.liquidation_price,
          })),
        }
      : null,
  };
}
