import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { jsonBody } from '../test/request'
import {
  claimPredictMarket,
  getPredictMarkets,
  getPredictPositions,
  predictOutcomeWorth,
  PREDICT_PAGE_SIZE,
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
      expect(asked()).toBe(
        `${BACKEND_URL}/predict/markets?status=resolved&limit=${PREDICT_PAGE_SIZE}&offset=0`,
      )
    })

    it('defaults to open markets', async () => {
      ok([])
      await getPredictMarkets()
      expect(asked()).toBe(
        `${BACKEND_URL}/predict/markets?status=open&limit=${PREDICT_PAGE_SIZE}&offset=0`,
      )
    })

    // Витрина страницей, а не «всем, что создал куратор»: потолок ответа
    // держит бэкенд (le=200), смещение передаёт клиент.
    it('asks the next page by offset, not by re-reading the first one', async () => {
      ok([])
      await getPredictMarkets('open', PREDICT_PAGE_SIZE)
      expect(asked()).toBe(
        `${BACKEND_URL}/predict/markets?status=open&limit=${PREDICT_PAGE_SIZE}&offset=${PREDICT_PAGE_SIZE}`,
      )
    })

    // Чей это список и кому платить — решает токен в заголовке, поэтому в адресах
    // больше нет ?user_id=…: подмена query не может ни прочитать чужие позиции,
    // ни забрать чужой выигрыш.
    it('asks for positions and claims without naming a user', async () => {
      ok([])
      await getPredictPositions()
      expect(asked()).toBe(`${BACKEND_URL}/predict/positions`)
      await claimPredictMarket('m 1')
      expect(asked(1)).toBe(`${BACKEND_URL}/predict/markets/m%201/claim`)
      expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST')
    })

    it('sells with negative shares on the same endpoint as buying', async () => {
      ok({ cost_usd: -4.2 })
      await tradePredictMarket('m1', 'yes', -3)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/predict/markets/m1/trade`)
      expect(init.method).toBe('POST')
      expect(jsonBody(init)).toEqual({ outcome: 'yes', shares: -3 })
    })

    it('surfaces the backend reason, not a bare status code', async () => {
      fail(409, 'рынок уже резолвлен с исходом yes')
      await expect(tradePredictMarket('m1', 'yes', 5)).rejects.toThrow('уже резолвлен')
    })

    it('falls back to the status code when the error body is empty', async () => {
      fail(502, '')
      await expect(getPredictMarkets('all')).rejects.toThrow(`Бэкенд Wake 502`)
    })
  })
})
