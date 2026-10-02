import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BACKEND_URL } from './config'
import { setNetwork, getNetwork, getOrderBooks, getCandles, getRecentTrades, getAccountByL1Address, getMarketOverview, registerFollower, listFollowsForFollower } from './lighter'

declare global {
  interface Window {
    fetch: typeof fetch
  }
  var global: {
    fetch: typeof fetch
  }
}

describe('lighter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    setNetwork('testnet')
  })

  describe('network management', () => {
    it('keeps the last network it was switched to', () => {
      expect(getNetwork()).toBe('testnet')
    })

    it('switches to mainnet', () => {
      setNetwork('mainnet')
      expect(getNetwork()).toBe('mainnet')
    })
  })

  describe('getOrderBooks', () => {
    it('fetches order books successfully', async () => {
      const mockData = {
        order_books: [
          { symbol: 'BTC-USD', market_id: 1, market_type: 'perp', status: 'active' }
        ]
      }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData)
      })

      const result = await getOrderBooks()
      expect(result).toEqual(mockData.order_books)
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/orderBooks'))
    })

    it('throws on API error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500
      })

      await expect(getOrderBooks()).rejects.toThrow('Lighter API 500')
    })
  })

  describe('getCandles', () => {
    it('fetches candles with correct params', async () => {
      const mockData = { c: [{ t: 1000, o: 100, h: 110, l: 90, c: 105, v: 10, V: 1000 }] }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData)
      })

      const result = await getCandles(1, '1h', 50)
      expect(result).toEqual(mockData.c)
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('market_id=1'))
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('resolution=1h'))
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('count_back=50'))
    })

    it('trims the window Lighter actually returned down to the requested count', async () => {
      // Замерено на mainnet: /candles отдаёт окно, заданное start/end_timestamp,
      // и в ответе оказывается на 2 свечи больше, чем count_back. Оставить их —
      // значит считать «изменение за 24 часа» по 26 свечам и показать не то число,
      // что считает бэкенд.
      const candles = Array.from({ length: 26 }, (_, i) => ({
        t: 1_700_000_000_000 + i * 3_600_000, o: i, h: i, l: i, c: i, v: 1, V: 1
      }))
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ c: candles })
      })

      const result = await getCandles(1, '1h', 24)
      expect(result).toHaveLength(24)
      expect(result[0].t).toBe(candles[2].t)
      expect(result[result.length - 1].t).toBe(candles[25].t)
    })
  })

  describe('getMarketOverview', () => {
    it('reads the Wake backend, not Lighter', async () => {
      const mockOverview = {
        network: 'mainnet', ranked_by: 'quote_volume_24h', epoch_hours: 1, count: 1,
        rows: [{ market_id: 1, symbol: 'BTC', funding_payer: 'long' }],
        no_market: ['TON'], no_data: ['MATIC']
      }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOverview)
      })

      const result = await getMarketOverview()
      expect(result).toEqual(mockOverview)
      // Один запрос к Wake, а не 18 к Lighter: обзор считает бэкенд, и сайт с ботом
      // расходятся по числам ровно тогда, когда фронт пересчитывает их сам.
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith(`${BACKEND_URL}/markets/overview`, undefined)
    })

    it('throws on backend error instead of returning an empty overview', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 502 })
      await expect(getMarketOverview()).rejects.toThrow('Бэкенд Wake 502')
    })
  })

  describe('getRecentTrades', () => {
    it('fetches recent trades', async () => {
      const mockData = {
        trades: [{ id: 1, price: 100, size: 1, isAsk: false }]
      }
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData)
      })

      const result = await getRecentTrades(1, 10)
      expect(result).toBeDefined()
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('market_id=1'))
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('limit=10'))
    })
  })

  describe('getAccountByL1Address', () => {
    it('fetches account by L1 address', async () => {
      const mockAccount = { account_index: 123, l1_address: '0xabc' }
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAccount)
      })
      global.fetch = fetchMock

      const result = await getAccountByL1Address('0xabc')
      expect(result).toEqual(mockAccount)
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('value=0xabc'))
    })

    it('throws on error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404
      })

      await expect(getAccountByL1Address('0xinvalid')).rejects.toThrow('Lighter API 404')
    })
  })

  describe('registerFollower', () => {
    it('registers follower and returns ID', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ follower_id: 'f123' })
      })

      const result = await registerFollower('0xabc')
      expect(result).toBe('f123')
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/followers'),
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('listFollowsForFollower', () => {
    it('lists follows for follower', async () => {
      const mockFollows = [
        { id: 'f1', leader_id: 'l1', leader_handle: '@test', allocation_usd: 1000 }
      ]
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockFollows)
      })

      const result = await listFollowsForFollower('f123')
      expect(result).toEqual(mockFollows)
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/follows/by-follower/f123'), undefined)
    })
  })
})
