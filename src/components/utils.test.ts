import { describe, it, expect } from 'vitest'
import { avatarColor, categorizeMarket, fmt, fmtPrice, fmtPct, fmtUsdCompact, shortHandle, usd } from './utils'
import { COMMODITY_SYMBOLS, FOREX_SYMBOLS, STOCK_SYMBOLS } from './types'
import type { OrderBook } from '../lib/lighter'

// Случаи взяты те же, что в backend/test_telegram_bot.py: смысл этих функций не в
// том, чтобы «красиво печатать», а в том, чтобы Telegram и сайт показывали одно
// число одинаково. Расхождение здесь — это баг, который никто не заметит, пока
// юзер не сравнит два экрана.
describe('components/utils', () => {
  describe('fmtUsdCompact', () => {
    it('matches the bot bands', () => {
      expect(fmtUsdCompact(0.5)).toBe('$0.50')
      expect(fmtUsdCompact(1_000)).toBe('$1K')
      expect(fmtUsdCompact(847_828_634)).toBe('$847.8M')
      expect(fmtUsdCompact(2_400_000_000)).toBe('$2.40B')
    })

    it('keeps the K band readable instead of rounding a third away', () => {
      // Без знака после запятой 1500 показывалось как "$2K".
      expect(fmtUsdCompact(1_500)).toBe('$1.5K')
      expect(fmtUsdCompact(1_000.4)).toBe('$1K')
    })
  })

  describe('fmtPrice', () => {
    it('matches the bot bands', () => {
      expect(fmtPrice(84_408.7)).toBe('84,408.70')
      expect(fmtPrice(3.5957)).toBe('3.5957')
      expect(fmtPrice(0.000123)).toBe('0.000123')
    })

    it('drops trailing zeros rather than padding the column', () => {
      expect(fmtPrice(3.5)).toBe('3.5')
      expect(fmtPrice(2660)).toBe('2,660.00')
    })
  })

  describe('fmtPct', () => {
    it('always carries a sign so growth and decline differ at a glance', () => {
      expect(fmtPct(-0.002)).toBe('-0.20%')
      expect(fmtPct(0.0138)).toBe('+1.38%')
      expect(fmtPct(0)).toBe('+0.00%')
    })
  })

  describe('usd', () => {
    it('keeps the sign outside the dollar sign', () => {
      expect(usd(-1234.5, 2)).toBe('-$1,234.50')
      expect(usd(0)).toBe('$0')
    })
  })

  describe('avatarColor', () => {
    it('is stable per handle and drawn from the existing palette', () => {
      expect(avatarColor('@northstar')).toBe(avatarColor('@northstar'))
      // Цвет, а не имя класса: панели красят аватар через style={{ background }},
      // и «bg-cyan-500» браузер отбрасывает как невалидное значение — круг был
      // прозрачным.
      expect(avatarColor('@northstar')).toMatch(/^#[0-9a-f]{6}$/)
    })

    it('stays inside the declared palette', () => {
      const handles = ['@a', '@northstar', '@vega.eth', '@driftking', '@x1', '@мимо', '', '@qqqqqq']
      const hexes = handles.map(avatarColor)
      for (const h of hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/)
      // Разные handle обязаны иногда давать разные цвета, иначе палитра из шести
      // значений — декорация: проверка на фикстурном наборе, а не «в среднем».
      expect(new Set(hexes).size).toBeGreaterThan(1)
    })
  })

  describe('shortHandle', () => {
    it('strips the leading @ for the avatar letter', () => {
      expect(shortHandle('@vega.eth')).toBe('V')
    })
  })

  describe('not-a-number never renders as a real figure', () => {
    // NaN в таблицу чисел попадает из жизни: у поля number() очищенное значение
    // и ввод вида «-» или «1e» дают NaN, а Math.max(0, NaN) — тоже NaN. fmt(NaN)
    // до правки печатал "NaN" и "-$NaN", что в колонке с суммами не отличить от
    // настоящего числа.
    it('renders em dash instead of NaN for every formatter', () => {
      expect(fmt(NaN)).toBe('—')
      expect(usd(NaN)).toBe('—')
      expect(fmtUsdCompact(NaN)).toBe('—')
      expect(fmtPrice(NaN)).toBe('—')
      expect(fmtPct(NaN)).toBe('—')
    })

    it('renders em dash for infinity too', () => {
      expect(usd(Infinity)).toBe('—')
      expect(fmtPrice(-Infinity)).toBe('—')
    })

    it('keeps formatting real values exactly as before', () => {
      expect(fmt(1234567, 2)).toBe('1,234,567.00')
      expect(usd(-1500)).toBe('-$1,500')
      expect(fmtUsdCompact(1500)).toBe('$1.5K')
      expect(fmtPrice(3.5)).toBe('3.5')
      expect(fmtPct(0.002)).toBe('+0.20%')
      expect(fmtPct(-0.002)).toBe('-0.20%')
    })
  })
})

describe('категория рынка по живым символам книги Lighter', () => {
  // У /orderBooks нет поля «тип инструмента» (market_deployer у всех "lighter",
  // base_asset_id/quote_asset_id/multiplier не различают классы — проверено на
  // живом ответе 2026-10-24), поэтому категория считается по списку тикеров.
  // Список обязан покрывать то, что в книге есть: «BRENT», «GOLD» и «SILVER»
  // никогда не совпадали ни с одной строкой, а BRENTOIL, XPT и USDHKD в книге
  // есть и падали в Crypto.
  const book = (symbol: string, market_type: 'perp' | 'spot' = 'perp'): OrderBook =>
    ({ symbol, market_id: 1, market_type, status: 'active' }) as OrderBook

  it('разводит классы, которые реально торгуются', () => {
    expect(categorizeMarket(book('BTC'))).toBe('Crypto')
    expect(categorizeMarket(book('AAPL'))).toBe('Stocks')
    expect(categorizeMarket(book('SPY'))).toBe('Stocks')
    expect(categorizeMarket(book('US10Y'))).toBe('Stocks')
    expect(categorizeMarket(book('EURUSD'))).toBe('Forex')
    expect(categorizeMarket(book('USDHKD'))).toBe('Forex')
    expect(categorizeMarket(book('XAU'))).toBe('Commodities')
    expect(categorizeMarket(book('BRENTOIL'))).toBe('Commodities')
    expect(categorizeMarket(book('XPT'))).toBe('Commodities')
  })

  it('спот — это спот, каким бы тикером он ни был', () => {
    expect(categorizeMarket(book('ETH/USDC', 'spot'))).toBe('Spot')
    expect(categorizeMarket(book('AAPL/USDC', 'spot'))).toBe('Spot')
  })

  it('списки классов не пересекаются: один тикер не может быть и акцией, и валютой', () => {
    const sets = [FOREX_SYMBOLS, COMMODITY_SYMBOLS, STOCK_SYMBOLS]
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        expect([...sets[i]].filter((s) => sets[j].has(s))).toEqual([])
      }
    }
  })

  it('в списках нет символа длиннее того, что принимает диплинк', () => {
    // src/lib/deeplink.ts допускает asset из 1–12 знаков [A-Z0-9$]; тикер
    // длиннее нельзя ни открыть ссылкой, ни найти в фильтре по-человечески.
    for (const s of [...FOREX_SYMBOLS, ...COMMODITY_SYMBOLS, ...STOCK_SYMBOLS]) {
      expect(s).toMatch(/^[A-Z0-9$]{1,12}$/)
    }
  })
})
