import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BACKEND_URL } from './config'
import { jsonBody } from '../test/request'
import { setNetwork, getNetwork, getOrderBooks, getCandles, getRecentTrades, getAccountByL1Address, getMarketOverview, listOwnFollows, createFollow, setFollowPaused, deleteFollow, getMirrorLog, registerLeader, getMyLeader, setLeaderActive, openInterestUsd, toBaseUnits, toPriceTicks, randomClientOrderIndex, type OrderBook } from './lighter'

describe('открытый интерес в долларах', () => {
  // Живой /orderBooks (mainnet, 2026-10-24) отдаёт open_interest_usd СТРОКОЙ
  // ("9920884.729544"), у 16 из 225 активных рынков — "0.000000". На типе
  // «number» работал только случайный coercion в < и -, а `?.toFixed()` на
  // строке падал бы уже в рантайме.
  const book = (over: Partial<OrderBook>) =>
    ({ symbol: 'BTC', market_id: 0, market_type: 'perp', status: 'active', ...over }) as OrderBook

  it('считает доллары из строки книги', () => {
    expect(openInterestUsd(book({ open_interest_usd: '9920884.729544' }))).toBeCloseTo(9920884.729544, 4)
  })

  it('нулевой и отсутствующий интерес дают 0, а не NaN', () => {
    expect(openInterestUsd(book({ open_interest_usd: '0.000000' }))).toBe(0)
    expect(openInterestUsd(book({}))).toBe(0)
    expect(openInterestUsd(book({ open_interest_usd: '' }))).toBe(0)
    expect(openInterestUsd(book({ open_interest_usd: 'не число' }))).toBe(0)
  })

  it('не возвращает отрицательное значение, которое перемешало бы сортировку', () => {
    expect(openInterestUsd(book({ open_interest_usd: '-5' }))).toBe(0)
  })
})

/**
 * Каждый внешний запрос обязан уходить с таймаутом: висящее без ответа соединение
 * — это «загружаю…» до конца открытия вкладки. Проверка сразу и адреса, и сигнала,
 * чтобы ни один из шести GET не остался без него.
 */
function calledUrlWithTimeout(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit]
  expect(init?.signal).toBeInstanceOf(AbortSignal)
  return url
}

describe('масштабирование ордера под рынок', () => {
  it('не теряет шаг цены на float-шуме', () => {
    // Math.floor(0.29 * 100) = 28: 0.29*100 в float64 это 28.999999999999996.
    expect(toBaseUnits(0.29, 2)).toBe(29)
    expect(toBaseUnits(0.57, 2)).toBe(57)
    expect(toBaseUnits(4.35, 2)).toBe(435)
    expect(toBaseUnits(0.029, 3)).toBe(29)
  })

  it('округляет размер вниз, если он реально между тиками', () => {
    expect(toBaseUnits(0.0289, 2)).toBe(2)
    expect(toBaseUnits(0.025, 2)).toBe(2)
    expect(toBaseUnits(1 / 3, 4)).toBe(3333)
  })

  it('цену приводит к ближайшему тику, а не к нижнему', () => {
    expect(toPriceTicks(110432.55, 2)).toBe(11043255)
    expect(toPriceTicks(0.1634, 4)).toBe(1634)
    expect(toPriceTicks(100.999, 2)).toBe(10100)
    // Decimals=0 — это не «цена 0», а попытка выразить $0.16 целым долларом:
    // ближайший тик 1. Именно поэтому масштаб берётся из книги рынка, а не
    // подставляется значением по умолчанию.
    expect(toPriceTicks(0.1634, 0)).toBe(1)
  })

  it('client_order_index в границах int32 и не повторяется подряд', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const v = randomClientOrderIndex()
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(0x7fffffff)
      seen.add(v)
    }
    expect(seen.size).toBeGreaterThan(490)
  })
})


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
      expect(calledUrlWithTimeout(global.fetch as ReturnType<typeof vi.fn>)).toContain('/orderBooks')
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
      const url = calledUrlWithTimeout(global.fetch as ReturnType<typeof vi.fn>)
      expect(url).toContain('market_id=1')
      expect(url).toContain('resolution=1h')
      expect(url).toContain('count_back=50')
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
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOverview)
      })
      global.fetch = fetchMock

      const result = await getMarketOverview()
      expect(result).toEqual(mockOverview)
      // Один запрос к Wake, а не 18 к Lighter: обзор считает бэкенд, и сайт с ботом
      // расходятся по числам ровно тогда, когда фронт пересчитывает их сам.
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/markets/overview`)
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
      const url = calledUrlWithTimeout(global.fetch as ReturnType<typeof vi.fn>)
      expect(url).toContain('market_id=1')
      expect(url).toContain('limit=10')
    })
  })

  describe('getAccountByL1Address', () => {
    it('maps the raw account row into LighterAccount', async () => {
      // Живой ответ mainnet: все числа строками, позиция — строка на каждый
      // тронутый рынок. Мок повторяет эту форму, а не придуманную.
      const mockAccount = {
        accounts: [
          {
            index: 123,
            total_asset_value: '1000.50',
            positions: [
              {
                market_id: 1,
                symbol: 'BTC',
                position: '0.5',
                avg_entry_price: '90000',
                position_value: '45000',
                unrealized_pnl: '10.25',
                realized_pnl: '-2',
                liquidation_price: '45000.5',
              },
            ],
          },
        ],
      }
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAccount)
      })
      global.fetch = fetchMock

      const result = await getAccountByL1Address('0xabc')
      expect(result.accountIndex).toBe(123)
      expect(result.equityUsd).toBe(1000.5)
      expect(result.realizedPnlUsd).toBe(-2)
      expect(result.positions).toHaveLength(1)
      expect(result.positions[0]).toEqual({
        marketId: 1,
        symbol: 'BTC',
        size: 0.5,
        avgEntry: 90000,
        value: 45000,
        unrealizedPnl: 10.25,
        realizedPnl: -2,
        liquidationPrice: 45000.5,
      })
      expect(calledUrlWithTimeout(fetchMock)).toContain('value=0xabc')
    })

    it('throws when Lighter answers without accounts', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({})
      })

      await expect(getAccountByL1Address('0xabc')).rejects.toThrow('Аккаунт не найден')
    })

    it('throws on error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404
      })

      await expect(getAccountByL1Address('0xinvalid')).rejects.toThrow('Lighter API 404')
    })
  })

  describe('копи-трейд через Wake-бэкенд', () => {
    // Мок возвращает форму ответов api/copy_trading.py: follow_id и leader_id —
    // объекты, pause/resume — пустое тело, /follows — список строк таблицы follows.
    function ok(data: unknown) {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(data), text: () => Promise.resolve('') })
      return global.fetch as ReturnType<typeof vi.fn>
    }

    it('reads the follows of the token holder, not of an id in the URL', async () => {
      const rows = [{ id: 'f1', leader_id: 'l1', leader_handle: '@test', allocation_usd: 1000, max_leverage: 3, current_mirrored_size: 0, paused: 0, created_at: 1 }]
      const fetchMock = ok(rows)

      await expect(listOwnFollows()).resolves.toEqual(rows)
      expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/follows`)
    })

    it('creates a follow with the leader id in the body', async () => {
      const fetchMock = ok({ follow_id: 'f9' })

      await expect(createFollow('l1', 250, 3)).resolves.toBe('f9')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/follows`)
      expect(init.method).toBe('POST')
      expect(jsonBody(init)).toEqual({ leader_id: 'l1', allocation_usd: 250, max_leverage: 3 })
    })

    // pause и resume — два разных маршрута, а не один с флагом: состояние меняется
    // на сервере, и в запросе нечего подменять, чтобы получить противоположное.
    it.each([
      [true, 'pause'],
      [false, 'resume'],
    ])('posts /follows/{id}/%s for paused=%s', async (paused, route) => {
      const fetchMock = ok({})

      await setFollowPaused('f 1', paused)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/follows/f%201/${route}`)
      expect(init.method).toBe('POST')
    })

    it('unfollows with DELETE on the follow itself', async () => {
      const fetchMock = ok({})

      await deleteFollow('f1')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/follows/f1`)
      expect(init.method).toBe('DELETE')
    })

    it('reads the mirror log with a limit', async () => {
      const fetchMock = ok([{ id: 'm1', follow_id: 'f1', market_id: 1, side: 'long', status: 'dry_run' }])

      await getMirrorLog(30)
      expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/mirror-log?limit=30`)
    })

    // Индекс аккаунта в теле отсутствует сознательно: его берёт из записи входа
    // бэкенд, и присланный клиентом индекс позволил бы опубликовать чужой аккаунт.
    it('publishes a leader by handle and fee only', async () => {
      const fetchMock = ok({ leader_id: 'l7', active: true })

      await expect(registerLeader('@sergey', 12)).resolves.toBe('l7')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/leaders`)
      expect(init.method).toBe('POST')
      expect(jsonBody(init)).toEqual({ handle: '@sergey', fee_bps: 12 })
    })

    // Публикация — состояние в базе, а не в памяти вкладки. /leaders отдаёт
    // только активных, поэтому для восстановления рубильника нужен /leaders/mine:
    // иначе «выключен» неотличим от «никогда не публиковался».
    it('reads own leader including the deactivated one', async () => {
      const fetchMock = ok({ leader: { id: 'l7', handle: '@sergey', fee_bps: 12, active: false } })

      await expect(getMyLeader()).resolves.toEqual({ id: 'l7', handle: '@sergey', fee_bps: 12, active: false })
      expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/leaders/mine`)
    })

    it('reads null leader when the account was never published', async () => {
      ok({ leader: null })
      await expect(getMyLeader()).resolves.toBeNull()
    })

    it('switches publication with a boolean on a dedicated route', async () => {
      const fetchMock = ok({ leader_id: 'l7', active: false })

      await setLeaderActive('l 7', false)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/leaders/l%207/active`)
      expect(init.method).toBe('PATCH')
      // не «1»/«yes»: бэкенд принимает только JSON-bool, иначе выключение
      // прочиталось бы включением
      expect(jsonBody(init)).toEqual({ active: false })
    })

    it('refuses to read follows when the session expired', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve('{"error":{"code":"SESSION_EXPIRED","message":"Войди заново"}}'),
      })

      await expect(listOwnFollows()).rejects.toThrow(/SESSION_EXPIRED/)
    })
  })
})
