import { describe, it, expect } from 'vitest'
import { avatarColor, categorizeMarket, fmt, fmtPrice, fmtPct, fmtUsdCompact, shortHandle, toastVariant, trialToast, usd } from './utils'
import type { ToastVariant } from './utils'
import type { Subscription } from './types'
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

// Строки взяты из тех мест, где их печатают: setToast вызывается одной строкой, а
// вариант решает, какого цвета плашка и какой вибрацией мини-апп ответит на
// исход ордера. Ошибка классификации здесь — это «красное выглядит спокойным».
describe('toastVariant', () => {
  const failures = [
    'Кошелёк не подключился: User rejected the request',
    'Кошелёк не подтверждён: Бэкенд Wake 401',
    'Telegram не подтвердил вход: Подпись initData не совпала',
    'Telegram не передал подписанную initData — войди через виджет или кошелёк',
    'Бэкенд не отвечает: fetch failed',
    'Бэкенд не принял выключение: Бэкенд Wake 503',
    'Бэкенд отклонил подписку: allocation exceeds balance',
    'Не удалось отписать: Бэкенд Wake 500',
    'Не удалось записаться в leaders: Бэкенд Wake 409',
    'Пауза не записана в базу: Бэкенд Wake 503',
    'Сделка не записана: рынок закрыт',
    'Выигрыш не начислен: уже забрано',
    'Расчёт размера не прошёл: нет данных книги',
    'Агент недоступен: Бэкенд Wake 502',
    'Анализ риска недоступен: fetch failed',
    'Размер ордера должен быть больше нуля',
    'Минимальный ордер по этому рынку — 10 USDC',
    'Нет свечей Lighter по этому рынку — агенту не на чём решать',
    'Пробный период не выдан: бэкенд вернул ответ без подписки',
  ]

  const successes = [
    'Ордер отправлен: 0x4f2a',
    'Подписка на @vega записана в таблицу follows',
    'Забрано $12.34 по «BTC выше 90k к 5 октября?»',
    'Пробный период активен — осталось 4 дн.',
    'Подписка Pro активна — пробный период не требуется',
    'Публикация включена: индекс Lighter #7, комиссия 0.08% за сделку',
    'Публикация выключена: mirror_engine больше не строит план по твоим сделкам',
    'Кошелёк подтверждён: @vega, Lighter #7',
    'Вошёл как @wake_user',
    'Добро пожаловать, Sergey!',
  ]

  // Это не успех и не отказ — указание, чего не хватает. Красить его зелёным
  // нельзя: человек решит, что действие прошло.
  const neutral = [
    'Сначала войди через Telegram или кошелёк',
    'Лидер публикуется на подтверждённый вход — войди через Telegram или кошелёк',
    'Нужен индекс аккаунта Lighter: подтверди вход кошельком в меню профиля',
    'Сначала подключи кошелёк',
    'Добавь хотя бы одну позицию',
    'Сервис подписи работает в сухом режиме: ордер в Lighter не ушёл',
    'Пробный период уже использован — он даётся один раз на аккаунт',
  ]

  for (const message of failures) it(`отклоняет: ${message.slice(0, 40)}`, () => expect(toastVariant(message)).toBe('error'))
  for (const message of successes) it(`подтверждает: ${message.slice(0, 40)}`, () => expect(toastVariant(message)).toBe('success'))
  for (const message of neutral) it(`не окрашивает: ${message.slice(0, 40)}`, () => expect(toastVariant(message)).toBe('info'))
})

// Строка о трайле выводится из ответа /subscription/trial, а не из литерала:
// ensure_trial пишет через ON CONFLICT DO NOTHING (backend/agent_db.py), поэтому
// повторный клик ничего не начинает и обещать «начат — 14 дней» было враньем в
// двух состояниях — на десятый день трайла и после его конца. Здесь проверяется
// и то, как каждая из этих строк окрашивается: плашка про «доступ есть» не должна
// выглядеть отказом, а отказ — выглядеть успехом.
describe('trialToast', () => {
  const sub = (over: Partial<Subscription>): Subscription => ({
    tier: 'free_trial',
    has_ai_agent: true,
    has_copy_trading: true,
    has_predict_markets: true,
    days_left_in_trial: 13.99,
    ...over,
  })

  // Четыре значения `tier` из types.ts — все, что умеет отвечать бэкенд.
  const cases: Array<{ sub: Subscription; text: string; variant: ToastVariant }> = [
    {
      sub: sub({ days_left_in_trial: 13.99 }),
      text: 'Пробный период активен — осталось 14 дн.',
      variant: 'success',
    },
    {
      sub: sub({ days_left_in_trial: 4.2 }),
      text: 'Пробный период активен — осталось 5 дн.',
      variant: 'success',
    },
    {
      sub: sub({ days_left_in_trial: 0.4 }),
      text: 'Пробный период активен — осталось 1 дн.',
      variant: 'success',
    },
    {
      // Остаток обнуляется ровно на границе: `is_trial_expired` сравнивает через
      // «>», поэтому сутки до перехода тира в «free» доступ ещё открыт, а
      // считать его осталось ноль — это правда, а не «период закончился».
      sub: sub({ days_left_in_trial: 0 }),
      text: 'Пробный период активен — осталось 0 дн.',
      variant: 'success',
    },
    {
      sub: sub({ days_left_in_trial: null }),
      text: 'Пробный период активен',
      variant: 'success',
    },
    {
      sub: sub({ tier: 'pro', days_left_in_trial: null }),
      text: 'Подписка Pro активна — пробный период не требуется',
      variant: 'success',
    },
    {
      sub: sub({ tier: 'free', has_ai_agent: false, days_left_in_trial: 0 }),
      text: 'Пробный период уже использован — он даётся один раз на аккаунт',
      variant: 'info',
    },
    {
      sub: sub({ tier: 'none', has_ai_agent: false, days_left_in_trial: null }),
      text: 'Пробный период не выдан: бэкенд вернул ответ без подписки',
      variant: 'error',
    },
  ]

  for (const { sub: s, text, variant } of cases) {
    it(`${s.tier} + ${String(s.days_left_in_trial)} → ${text}`, () => {
      expect(trialToast(s)).toBe(text)
      expect(toastVariant(trialToast(s))).toBe(variant)
    })
  }

  it('не обещает начало там, где ничего не начинается', () => {
    // «начат» — единственный смысл, которого у этой функции нет: она не знает,
    // создана строка этим кликом или лежала до него.
    for (const { sub: s } of cases) expect(trialToast(s)).not.toMatch(/начат/)
  })
})
