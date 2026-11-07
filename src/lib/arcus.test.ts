import { describe, it, expect, vi, afterEach } from 'vitest'
import { setNetwork, getNetwork, getMarkets, getMidPrices, getRecentTrades, isArcusPerp, isArcusOnline, arcusFundingHourly, arcusAnnualizedFunding, type ArcusMarket } from './arcus'

// Фикстуры — форма живого ответа Arcus (замер 2026-11-03: mainnet 81 рынок,
// testnet 79, status только "ONLINE"/"OFFLINE", type только "PERPETUAL",
// quoteAsset только "USD"), а не пересказ документации: именно на расхождении
// с документацией этот слой и ломался.
const LIVE_MARKET: ArcusMarket = {
  marketDisplayName: 'BTC-USD',
  marketId: 1,
  status: 'ONLINE',
  baseAsset: 'BTC',
  quoteAsset: 'USD',
  tickSize: '0.1',
  stepSize: '0.00000001',
  type: 'PERPETUAL',
  category: 'CRYPTO',
  fundingRate: '0.000040365030148886',
  markPrice: '76394.2',
  minOrderNotional: '5',
}

function fetchJson(data: unknown) {
  const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(data) })
  global.fetch = fn
  return fn
}

function initOf(fn: ReturnType<typeof vi.fn>, i = 0): RequestInit {
  return fn.mock.calls[i][1] as RequestInit
}

function urlOf(fn: ReturnType<typeof vi.fn>, i = 0): string {
  return fn.mock.calls[i][0] as string
}

describe('классификация рынков Arcus', () => {
  it('живой статус — ONLINE, и только он значит «торгуется»', () => {
    expect(isArcusOnline(LIVE_MARKET)).toBe(true)
    expect(isArcusOnline({ ...LIVE_MARKET, status: 'OFFLINE' })).toBe(false)
    // "ACTIVE" — форма из более ранней документации. Панель сравнивала статус с
    // ней, и на живом ответе каждый рынок выходил серым «не активен». Если Arcus
    // когда-нибудь переименует значение, этот тест должен упасть, а не молча
    // погасить всю таблицу.
    expect(isArcusOnline({ ...LIVE_MARKET, status: 'ACTIVE' })).toBe(false)
  })

  it('перпом считается и поле type, и суффикс названия', () => {
    expect(isArcusPerp(LIVE_MARKET)).toBe(true)
    expect(isArcusPerp({ ...LIVE_MARKET, type: undefined, marketDisplayName: 'ETH-PERP' })).toBe(true)
    expect(isArcusPerp({ ...LIVE_MARKET, type: 'SPOT', marketDisplayName: 'ETH-USD' })).toBe(false)
  })
})

describe('funding Arcus', () => {
  // Крипта: база 0.01% за 8-часовой период = 0.0000125 в час, и живая ставка ETH
  // именно такая. Годовая по конвенции 24 × 365 — 10.95 %, то, что называют
  // документы; расхождение здесь значит, что мы перестали читать рынок.
  it('крипту annualizes по 24 × 365', () => {
    const eth = { ...LIVE_MARKET, fundingRate: '0.0000125' }
    expect(arcusAnnualizedFunding(eth)).toBeCloseTo(0.1095, 6)
  })

  // RWA: база задаётся как (SOFR + 0.5 %) / 360 / 24, то есть год там 360 дней.
  // Живой AMD отдаёт 0.000005138888888888 в час — это 4.44 % по 360-дневной
  // конвенции и 4.50 % по крипто-конвенции: разница в полпроцента на рынке, где
  // вся ставка меньше одного процента, — та величина, ради которой конвенции не
  // сливают в одну.
  it('RWA annualizes по 24 × 360, а не по крипто-конвенции', () => {
    const amd = { ...LIVE_MARKET, marketDisplayName: 'AMD-USD', category: 'EQUITIES', fundingRate: '0.000005138888888888' }
    const annual = arcusAnnualizedFunding(amd) ?? 0
    expect(annual).toBeCloseTo(0.0444, 4)
    expect(annual).toBeLessThan(0.000005138888888888 * 24 * 365)
  })

  it('почасовая ставка проходит без пересчёта', () => {
    expect(arcusFundingHourly(LIVE_MARKET)).toBeCloseTo(0.000040365030148886, 12)
  })

  it('нулевая ставка — это ноль, а не отсутствие данных', () => {
    // Живой F-USD (рынок выключен) отдаёт fundingRate "0"; молча превратить его
    // в прочерк значит солгать про то, что рынок вообще что-то платит.
    const zero = { ...LIVE_MARKET, fundingRate: '0' }
    expect(arcusFundingHourly(zero)).toBe(0)
    expect(arcusAnnualizedFunding(zero)).toBe(0)
  })

  it('пустое и нечисловое поле — прочерк, а не ноль', () => {
    for (const bad of [undefined, '', '  ', 'not-a-rate']) {
      const m = { ...LIVE_MARKET, fundingRate: bad }
      expect(arcusFundingHourly(m)).toBeNull()
      expect(arcusAnnualizedFunding(m)).toBeNull()
    }
  })
})

describe('arcus client', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
    setNetwork('mainnet')
  })

  it('разворачивает список рынков и не ждёт вечно', async () => {
    const fn = fetchJson({ markets: [LIVE_MARKET] })
    await expect(getMarkets()).resolves.toEqual([LIVE_MARKET])
    expect(urlOf(fn)).toBe('https://api.arcus.xyz/v1/markets')
    expect(initOf(fn).signal).toBeInstanceOf(AbortSignal)
  })

  it('пустой ответ — это пустой список, а не падение', async () => {
    fetchJson({})
    await expect(getMarkets()).resolves.toEqual([])
  })

  it('hit testnet after the network switch', async () => {
    setNetwork('testnet')
    expect(getNetwork()).toBe('testnet')
    const fn = fetchJson({ mids: {}, globalSequenceId: 0 })
    await getMidPrices()
    expect(urlOf(fn)).toBe('https://api.testnet.arcus.xyz/v1/mids')
  })

  it('кодирует имя рынка в параметре и режет limit по максимуму API', async () => {
    const fn = fetchJson({ trades: [] })
    await getRecentTrades('BTC-USD', 5000)
    const params = new URL(urlOf(fn)).searchParams
    expect(params.get('market')).toBe('BTC-USD')
    expect(params.get('limit')).toBe('1000')

    fetchJson({ mids: {} })
    await getMidPrices('DOGE-USD')
    expect(urlOf(global.fetch as ReturnType<typeof vi.fn>)).toContain('/mids?market=DOGE-USD')
  })

  it('ошибку HTTP поднимает строкой с кодом, а не молча', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    await expect(getMarkets()).rejects.toThrow('Arcus API 503')
  })
})
