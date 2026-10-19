import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { jsonBody } from '../test/request'
import {
  connectTelegramMiniApp,
  ensureTelegramSdk,
  hasMiniAppUser,
  isTelegramWebView,
  miniAppDisplayName,
  verifyTelegramLogin,
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

  // Имя в шапке берётся отсюда, а это разбор initData на клиенте: годится как
  // надпись, и личность по-прежнему определяет user_id из ответа бэкенда.
  describe('miniAppDisplayName', () => {
    afterEach(() => {
      delete window.Telegram
    })

    it('reads the unsafe user for the header label only', () => {
      window.Telegram = { WebApp: { initDataUnsafe: { user: { id: 4350, first_name: 'Mini', username: 'wake_user', auth_date: 1, hash: 'h' } } } }
      expect(miniAppDisplayName()?.username).toBe('wake_user')
    })

    it('is null when the webview gave no user', () => {
      expect(miniAppDisplayName()).toBeNull()
    })
  })

  describe('connectTelegramMiniApp', () => {
    const fetchMock = vi.fn()
    const realFetch = global.fetch

    beforeEach(() => {
      fetchMock.mockReset()
      global.fetch = fetchMock
      localStorage.clear()
    })

    afterEach(() => {
      global.fetch = realFetch
      delete window.Telegram
    })

    // Ответ входа — токен сессии, а не профиль: сохранение остаётся за приложением,
    // иначе четвёртый способ входа мог бы пройтись мимо хранилища.
    const SIGNED_IN = { user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400, lighter_account_index: null }

    it('does not call the backend outside the Telegram webview', async () => {
      const res = await connectTelegramMiniApp(BROWSER_UA)
      expect(res).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not call the backend when initData has no user', async () => {
      window.Telegram = { WebApp: { initData: '' } }
      const res = await connectTelegramMiniApp(TG_UA)
      expect(res).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('posts the raw initData and returns what the backend issued', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA, ready: vi.fn() } }
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(SIGNED_IN) })

      const res = await connectTelegramMiniApp(TG_UA)

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/auth/telegram/init`)
      expect(init.method).toBe('POST')
      expect(jsonBody(init)).toEqual({ init_data: INIT_DATA })
      expect(res).toEqual(SIGNED_IN)
    })

    it('surfaces the backend reason instead of a bare status code', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve('{"error":{"code":"INVALID_INIT_DATA","message":"Подпись initData не совпала"}}'),
      })

      await expect(connectTelegramMiniApp(TG_UA)).rejects.toThrow(/Подпись initData не совпала \(INVALID_INIT_DATA\)/)
    })

    it('falls back to the status code when the body is empty', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(null), text: () => Promise.resolve('') })

      await expect(connectTelegramMiniApp(TG_UA)).rejects.toThrow('Бэкенд Wake 503')
    })
  })

  describe('verifyTelegramLogin', () => {
    const fetchMock = vi.fn()
    const realFetch = global.fetch

    beforeEach(() => {
      fetchMock.mockReset()
      global.fetch = fetchMock
      localStorage.clear()
    })

    afterEach(() => {
      global.fetch = realFetch
    })

    // Виджетные поля уходят целиком, включая auth_date и hash: проверять подпись
    // должен бэкенд на токене бота, а не браузер, и для этого ему нужен набор полей.
    it('posts the widget payload and returns the session answer', async () => {
      const user = { id: 4350, first_name: 'Sergey', username: 'wake_user', auth_date: 1_760_000_000, hash: 'a1b2c3' }
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400 }),
      })

      const res = await verifyTelegramLogin(user)

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/auth/telegram`)
      expect(jsonBody(init)).toEqual(user)
      expect(res).toEqual({ user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400 })
    })

    it('names the missing bot token as the reason', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve(null),
        text: () =>
          Promise.resolve('{"error":{"code":"TELEGRAM_NOT_CONFIGURED","message":"Telegram-вход не настроен: на бэкенде нет TELEGRAM_BOT_TOKEN"}}'),
      })

      await expect(
        verifyTelegramLogin({ id: 1, first_name: 'X', auth_date: 1_760_000_000, hash: 'h' })
      ).rejects.toThrow(/TELEGRAM_NOT_CONFIGURED/)
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
