import { describe, it, expect, vi, afterEach } from 'vitest'
import { setNetwork, getNetwork, getMarkets, getMidPrices, getRecentTrades, isArcusPerp, isArcusOnline, type ArcusMarket } from './arcus'

// Фикстуры — форма живого ответа mainnet Arcus (замер 2026-10-24: 70 рынков,
// status только "ONLINE"/"OFFLINE", type только "PERPETUAL"), а не пересказ
// документации: именно на расхождении с документацией этот слой и ломался.
const LIVE_MARKET: ArcusMarket = {
  marketDisplayName: 'BTC-USD',
  marketId: 1,
  status: 'ONLINE',
  baseAsset: 'BTC',
  quoteAsset: 'USD',
  tickSize: '0.1',
  stepSize: '0.00000001',
  type: 'PERPETUAL',
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
