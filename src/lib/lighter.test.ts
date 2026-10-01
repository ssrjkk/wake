import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setNetwork, getNetwork, getOrderBooks, getCandles, getRecentTrades, getAccountByL1Address, registerFollower, listFollowsForFollower } from './lighter'

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
    it('defaults to testnet', () => {
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
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/follows/by-follower/f123'))
    })
  })
})
