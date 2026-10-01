import { describe, it, expect } from 'vitest'
import { fmt, formatUSD, formatPercent } from './utils'

describe('utils', () => {
  describe('fmt', () => {
    it('formats integers', () => {
      expect(fmt(1000)).toBe('1,000')
      expect(fmt(1234567)).toBe('1,234,567')
    })

    it('formats with decimals', () => {
      expect(fmt(1234.5678, 2)).toBe('1,234.57')
      expect(fmt(1000, 0)).toBe('1,000')
    })

    it('handles zero', () => {
      expect(fmt(0)).toBe('0')
      expect(fmt(0, 2)).toBe('0.00')
    })

    it('handles negative numbers', () => {
      expect(fmt(-1000)).toBe('-1,000')
      expect(fmt(-1234.56, 2)).toBe('-1,234.56')
    })
  })

  describe('formatUSD', () => {
    it('formats as USD', () => {
      expect(formatUSD(1000)).toBe('$1,000.00')
      expect(formatUSD(1234.5)).toBe('$1,234.50')
    })
  })

  describe('formatPercent', () => {
    it('formats as percent', () => {
      expect(formatPercent(12.34)).toBe('12.34%')
      expect(formatPercent(100)).toBe('100.00%')
    })
  })
})
