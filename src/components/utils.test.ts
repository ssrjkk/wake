import { describe, it, expect } from 'vitest'
import { avatarColor, fmtPrice, fmtPct, fmtUsdCompact, shortHandle, usd } from './utils'

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
      expect(avatarColor('@northstar')).toMatch(/^bg-/)
    })
  })

  describe('shortHandle', () => {
    it('strips the leading @ for the avatar letter', () => {
      expect(shortHandle('@vega.eth')).toBe('V')
    })
  })
})
