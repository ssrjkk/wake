import { describe, it, expect } from 'vitest'
import { leaderFromHydrated, positionsWithSize } from './leaders'
import type { HydratedLeaderRow } from './lighter'

// Карточка лидера собирается в одном месте, чтобы Discover и Earn не разъехались
// в цифрах одного и того же трейдера. Здесь проверяется то, что нельзя увидеть
// глазами в тесте компонента: граница между «Lighter не ответил» и «у лидера ноль».
function row(account: HydratedLeaderRow['account']): HydratedLeaderRow {
  return {
    id: 'ldr_1',
    lighter_account_index: 8,
    handle: '@north',
    fee_bps: 10,
    created_at: 1_700_000_000,
    follower_count: 3,
    total_aum_usd: 1500,
    account,
  }
}

describe('leaderFromHydrated', () => {
  it('keeps an unreadable account as null, not as zeros', () => {
    // «$0 капитала» и «капитал неизвестен» — разные утверждения для человека,
    // который выбирает, у кого копировать: нули выглядели бы как факт о счёте.
    const leader = leaderFromHydrated(row(null))
    expect(leader.exchange).toBeNull()
    expect(leader.followers).toBe(3)
    expect(leader.aumUsd).toBe(1500)
  })

  it('maps every field of a readable account', () => {
    const leader = leaderFromHydrated(
      row({
        equity_usd: 42000,
        realized_pnl_usd: 310,
        positions: [
          {
            market_id: 1,
            symbol: 'BTC',
            size: 0.5,
            avg_entry: 60000,
            value: 30000,
            unrealized_pnl: 12,
            realized_pnl: 5,
            liquidation_price: 40000,
          },
        ],
      })
    )
    expect(leader.exchange).toEqual({
      equityUsd: 42000,
      realizedPnlUsd: 310,
      openPositions: [
        {
          marketId: 1,
          symbol: 'BTC',
          size: 0.5,
          avgEntry: 60000,
          value: 30000,
          unrealizedPnl: 12,
          realizedPnl: 5,
          liquidationPrice: 40000,
        },
      ],
    })
  })
})

describe('positionsWithSize', () => {
  const position = (size: number) => ({
    marketId: 1,
    symbol: 'BTC',
    size,
    avgEntry: 1,
    value: 1,
    unrealizedPnl: 0,
    realizedPnl: 0,
    liquidationPrice: 0,
  })

  it('drops closed rows and keeps both directions', () => {
    // Lighter отдаёт строку на каждый рынок, которого аккаунт касался; закрытая
    // позиция остаётся с size 0 и не имеет права считаться открытой.
    expect(positionsWithSize([position(0), position(0.5), position(-2)])).toEqual([
      position(0.5),
      position(-2),
    ])
  })

  it('keeps a tiny non-zero size: rounding it away needs market decimals this module does not have', () => {
    expect(positionsWithSize([position(1e-12)])).toEqual([position(1e-12)])
  })
})
