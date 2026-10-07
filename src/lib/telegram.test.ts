import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import {
  connectTelegramMiniApp,
  ensureTelegramSdk,
  hasMiniAppUser,
  isTelegramWebView,
} from './telegram'

// Урезанная, но по форме настоящая initData: бэкенд разбирает её сам, фронту
// важно отдать строку целиком и не терять поля.
const INIT_DATA =
  'auth_date=1760000000&query_id=AAH4xyz&user=%7B%22id%22%3A4350%2C%22first_name%22%3A%22Mini%22%2C%22username%22%3A%22wake_user%22%7D&hash=a1b2c3'

const TG_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Telegram/iPhone 11.2.5'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36'

describe('telegram mini app', () => {
  describe('isTelegramWebView', () => {
    it('recognises the Telegram webview by its user agent', () => {
      expect(isTelegramWebView(TG_UA)).toBe(true)
      expect(isTelegramWebView('TelegramDesktop/5.11')).toBe(true)
    })

    it('is false for a plain browser', () => {
      expect(isTelegramWebView(BROWSER_UA)).toBe(false)
      expect(isTelegramWebView('')).toBe(false)
    })
  })

  describe('hasMiniAppUser', () => {
    it('needs both the user payload and the signature', () => {
      expect(hasMiniAppUser(INIT_DATA)).toBe(true)
    })

    it('is false when there is nothing to log in with', () => {
      // Кнопка без подписи, пустая строка, подпись без пользователя — во всех
      // случаях вход не состоится, и это не ошибка, а «мы не в мини-аппе».
      expect(hasMiniAppUser(undefined)).toBe(false)
      expect(hasMiniAppUser(null)).toBe(false)
      expect(hasMiniAppUser('')).toBe(false)
      expect(hasMiniAppUser('auth_date=1760000000&hash=a1b2c3')).toBe(false)
      expect(hasMiniAppUser('auth_date=1760000000&user=%7B%22id%22%3A1%7D')).toBe(false)
    })
  })

  describe('connectTelegramMiniApp', () => {
    const fetchMock = vi.fn()
    const realFetch = global.fetch

    beforeEach(() => {
      fetchMock.mockReset()
      global.fetch = fetchMock
    })

    afterEach(() => {
      global.fetch = realFetch
      delete window.Telegram
    })

    it('does not call the backend outside the Telegram webview', async () => {
      const profile = await connectTelegramMiniApp(BROWSER_UA)
      expect(profile).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not call the backend when initData has no user', async () => {
      window.Telegram = { WebApp: { initData: '' } }
      const profile = await connectTelegramMiniApp(TG_UA)
      expect(profile).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('posts the raw initData and returns the backend profile', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA, ready: vi.fn() } }
      fetchMock.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            user_id: 'tg_4350',
            telegram_id: 4350,
            username: 'wake_user',
            first_name: 'Mini',
          }),
      })

      const profile = await connectTelegramMiniApp(TG_UA)

      expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/auth/telegram/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: INIT_DATA }),
      })
      expect(profile).toEqual({
        user_id: 'tg_4350',
        telegram_id: 4350,
        username: 'wake_user',
        first_name: 'Mini',
      })
    })

    it('surfaces the backend reason instead of a bare status code', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"detail":"Подпись initData не совпала"}'),
      })

      await expect(connectTelegramMiniApp(TG_UA)).rejects.toThrow('Подпись initData не совпала')
    })

    it('falls back to the status code when the body is empty', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') })

      await expect(connectTelegramMiniApp(TG_UA)).rejects.toThrow('Бэкенд Wake 503')
    })
  })

  describe('ensureTelegramSdk', () => {
    afterEach(() => {
      delete window.Telegram
      document.querySelector('script[data-telegram-sdk]')?.remove()
    })

    it('does not pull the Telegram domain into a normal browser', async () => {
      const app = await ensureTelegramSdk(BROWSER_UA)
      expect(app).toBeNull()
      expect(document.querySelector('script[data-telegram-sdk]')).toBeNull()
    })

    it('uses the SDK Telegram already injected', async () => {
      const webApp = { initData: INIT_DATA }
      window.Telegram = { WebApp: webApp }
      await expect(ensureTelegramSdk(TG_UA)).resolves.toBe(webApp)
      expect(document.querySelector('script[data-telegram-sdk]')).toBeNull()
    })
  })
})
