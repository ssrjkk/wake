import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import {
  claimPredictMarket,
  getPredictMarkets,
  getPredictPositions,
  predictOutcomeWorth,
  predictTimeLeft,
  tradePredictMarket,
} from './predict'

// Те же границы формата, что проверяет backend/test_telegram_bot.py для
// _fmt_left: срок в боте и на сайте обязан читаться одинаково.
const NOW = new Date('2026-10-03T12:00:00Z')
const at = (ms: number) => Math.floor((NOW.getTime() + ms) / 1000)

describe('predict', () => {
  describe('predictTimeLeft', () => {
    it('matches the bot formatting across day/hour/minute bands', () => {
      expect(predictTimeLeft(at(86400_000 + 3 * 3600_000), NOW)).toBe('осталось 1д 3ч')
      expect(predictTimeLeft(at(5 * 3600_000 + 20 * 60_000), NOW)).toBe('осталось 5ч 20м')
      expect(predictTimeLeft(at(40 * 60_000), NOW)).toBe('осталось 40м')
    })

    it('says the deadline passed instead of a negative countdown', () => {
      expect(predictTimeLeft(at(-3600_000), NOW)).toBe('срок истёк')
      expect(predictTimeLeft(at(0), NOW)).toBe('срок истёк')
    })
  })

  describe('predictOutcomeWorth', () => {
    it('pays a dollar per winning share and nothing to the loser', () => {
      expect(predictOutcomeWorth('yes', 'yes')).toBe(1)
      expect(predictOutcomeWorth('no', 'no')).toBe(1)
      expect(predictOutcomeWorth('yes', 'no')).toBe(0)
      expect(predictOutcomeWorth(null, 'yes')).toBe(0)
    })
  })

  describe('fetch layer', () => {
    const fetchMock = vi.fn()
    const realFetch = global.fetch

    beforeEach(() => {
      fetchMock.mockReset()
      global.fetch = fetchMock
    })

    afterEach(() => {
      global.fetch = realFetch
    })

    function ok(data: unknown) {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(data), text: () => Promise.resolve('') })
    }

    function fail(status: number, text: string) {
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve(text),
      })
    }

    // Проверяем сам URL: второй аргумент у fetch — init, и для GET там undefined,
    // что не имеет отношения к тому, что запрашивает интерфейс.
    const asked = (i = 0) => String(fetchMock.mock.calls[i][0])

    it('asks the backend for the requested status filter', async () => {
      ok([])
      await getPredictMarkets('resolved')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(asked()).toBe(`${BACKEND_URL}/predict/markets?status=resolved`)
    })

    it('defaults to open markets', async () => {
      ok([])
      await getPredictMarkets()
      expect(asked()).toBe(`${BACKEND_URL}/predict/markets?status=open`)
    })

    it('url-encodes the user id in positions and claims', async () => {
      ok([])
      await getPredictPositions('tg_123 / x')
      expect(asked()).toBe(`${BACKEND_URL}/predict/positions?user_id=tg_123%20%2F%20x`)
      await claimPredictMarket('m 1', 'a&b')
      expect(asked(1)).toBe(`${BACKEND_URL}/predict/markets/m%201/claim?user_id=a%26b`)
      expect(fetchMock.mock.calls[1][1]).toEqual({ method: 'POST' })
    })

    it('sells with negative shares on the same endpoint as buying', async () => {
      ok({ cost_usd: -4.2 })
      await tradePredictMarket('m1', 'tg_1', 'yes', -3)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${BACKEND_URL}/predict/markets/m1/trade`)
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({ user_id: 'tg_1', outcome: 'yes', shares: -3 })
    })

    it('surfaces the backend reason, not a bare status code', async () => {
      fail(409, 'рынок уже резолвлен с исходом yes')
      await expect(tradePredictMarket('m1', 'tg_1', 'yes', 5)).rejects.toThrow('уже резолвлен')
    })

    it('falls back to the status code when the error body is empty', async () => {
      fail(502, '')
      await expect(getPredictMarkets('all')).rejects.toThrow(`Бэкенд Wake 502`)
    })
  })
})
