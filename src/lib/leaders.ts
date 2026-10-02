// One leader, assembled the same way everywhere it is shown: Wake's own DB rows
// (leaders + follows) for identity/fee/subscribers, Lighter's public account
// endpoint for capital and realised PnL. Discover and Earn must not disagree
// about the same trader, so the join lives here rather than in each component.
import { getAccountByIndex, getLeaderStats, type LeaderRow, type LighterPosition } from "./lighter";
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
