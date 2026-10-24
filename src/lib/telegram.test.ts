import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { jsonBody } from '../test/request'
import {
  applyTelegramChrome,
  connectTelegramMiniApp,
  ensureTelegramChrome,
  ensureTelegramSdk,
  hasSignedUser,
  isTelegramWebView,
  miniAppDisplayName,
  openExternally,
  parseInitData,
  setTelegramBackHandler,
  telegramNotify,
  verifyTelegramLogin,
  type TelegramSdk,
  type TelegramUser,
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

  describe('hasSignedUser', () => {
    it('needs the user payload and both parts of the signature', () => {
      expect(hasSignedUser(INIT_DATA)).toBe(true)
    })

    it('is false when there is nothing to log in with', () => {
      // Кнопка без подписи, пустая строка, подпись без пользователя — во всех
      // случаях вход не состоится, и это не ошибка, а «мы не в мини-аппе».
      expect(hasSignedUser(undefined)).toBe(false)
      expect(hasSignedUser(null)).toBe(false)
      expect(hasSignedUser('')).toBe(false)
      expect(hasSignedUser('auth_date=1760000000&hash=a1b2c3')).toBe(false)
      expect(hasSignedUser('auth_date=1760000000&user=%7B%22id%22%3A1%7D')).toBe(false)
    })

    it('is not fooled by the words user= and hash= inside another value', () => {
      // Прежняя проверка искала подстроки, и «user=» в чужом username проходил
      // как подписанный пользователь. Здесь строка разбирается как набор
      // параметров, поэтому значение одного поля не может притвориться другим.
      expect(hasSignedUser('user=%7B%22username%22%3A%22x%22%7D&auth_date=abc&hash=')).toBe(false)
      expect(hasSignedUser('user=not-json&auth_date=1&hash=x')).toBe(false)
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
      // Цвет шапки мини-аппа берётся из токена темы; в jsdom stylesheet не
      // применяется, поэтому токен задаёт сам тест — проверяется связь «токен →
      // Telegram», а не значение палитры.
      document.documentElement.style.setProperty('--bg-1', '#101011')
    })

    afterEach(() => {
      global.fetch = realFetch
      delete window.Telegram
      document.documentElement.style.removeProperty('--bg-1')
    })

    // Ответ входа — токен сессии, а не профиль: сохранение остаётся за приложением,
    // иначе четвёртый способ входа мог бы пройтись мимо хранилища.
    const SIGNED_IN = { user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400, lighter_account_index: null }

    it('does not call the backend outside the Telegram webview', async () => {
      const res = await connectTelegramMiniApp({ userAgent: BROWSER_UA })
      expect(res).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not call the backend when initData has no user', async () => {
      window.Telegram = { WebApp: { initData: '' } }
      const res = await connectTelegramMiniApp({ userAgent: TG_UA })
      expect(res).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('posts the raw initData, shows the window and only then signs in', async () => {
      const ready = vi.fn()
      const background = vi.fn()
      const sdk: TelegramSdk = {
        initData: INIT_DATA,
        initDataUnsafe: { user: { id: 4350, first_name: 'Mini', username: 'wake_user', auth_date: 1, hash: 'h' } },
        ready,
        expand: vi.fn(),
        setColorScheme: vi.fn(),
        setHeaderColor: background,
        setBackgroundColor: background,
      }
      window.Telegram = { WebApp: sdk }
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(SIGNED_IN) })

      const res = await connectTelegramMiniApp({ userAgent: TG_UA, sdk })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`${BACKEND_URL}/auth/telegram/init`)
      expect(init.method).toBe('POST')
      // Строка уходит целиком: разбор и проверка подписи — дело бэкенда.
      expect(jsonBody(init)).toEqual({ init_data: INIT_DATA })
      expect(res).toEqual(SIGNED_IN)
      expect(ready).toHaveBeenCalled()
      expect(sdk.expand).toHaveBeenCalled()
      expect(sdk.setColorScheme).toHaveBeenCalledWith('dark')
      expect(background).toHaveBeenCalledWith('#101011')
    })

    it('surfaces the backend reason instead of a bare status code', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve(null),
        text: () => Promise.resolve('{"error":{"code":"INVALID_INIT_DATA","message":"Подпись initData не совпала"}}'),
      })

      await expect(connectTelegramMiniApp({ userAgent: TG_UA })).rejects.toThrow(/Подпись initData не совпала \(INVALID_INIT_DATA\)/)
    })

    it('falls back to the status code when the body is empty', async () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      fetchMock.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(null), text: () => Promise.resolve('') })

      await expect(connectTelegramMiniApp({ userAgent: TG_UA })).rejects.toThrow('Бэкенд Wake 503')
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
    // должен бэкенд на токене бота, а не браузер, и для этого ему нужен ровно тот
    // набор, который Telegram подписал. photo_url среди них нет — он в подпись не
    // входит, и с ним check_string расходится.
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

    it('drops the field that Telegram did not sign', async () => {
      // Виджет отдаёт ещё и photo_url. Подпись его не покрывает, и с ним check_string
      // расходится — вход падал 401 там, где подпись была полностью корректна.
      const widgetUser: TelegramUser & { photo_url: string } = {
        id: 4350,
        first_name: 'Sergey',
        username: 'wake_user',
        photo_url: 'https://telegram.org/img/xx.jpg',
        auth_date: 1_760_000_000,
        hash: 'a1b2c3',
      }
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ user_id: 'tg_4350', token: 't', expires_at: 1 }) })

      await verifyTelegramLogin(widgetUser)

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(jsonBody(init)).toEqual({
        id: 4350,
        first_name: 'Sergey',
        username: 'wake_user',
        auth_date: 1_760_000_000,
        hash: 'a1b2c3',
      })
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

  describe('parseInitData', () => {
    it('reads the signed fields and the percent-decoded user', () => {
      const parsed = parseInitData(INIT_DATA)
      expect(parsed?.auth_date).toBe(1_760_000_000)
      expect(parsed?.hash).toBe('a1b2c3')
      expect(parsed?.user?.username).toBe('wake_user')
    })

    it('refuses a string without the signature', () => {
      // Без hash и без auth_date это не подписанные данные, а набор полей из
      // чужого URL: проверять нечего, и входить не по чему.
      expect(parseInitData('user=%7B%22id%22%3A1%7D')).toBeNull()
      expect(parseInitData('hash=abc&auth_date=1')).toBeNull()
      expect(parseInitData('auth_date=abc&hash=x')).toBeNull()
      expect(parseInitData('user=%7B%22broken%7D&auth_date=1&hash=x')).toBeNull()
      expect(parseInitData('user=%22не+объект%22&auth_date=1&hash=x')).toBeNull()
    })
  })

  describe('applyTelegramChrome', () => {
    afterEach(() => {
      delete window.Telegram
      for (const side of ['top', 'bottom', 'left', 'right']) {
        document.documentElement.style.removeProperty(`--tg-safe-${side}`)
      }
    })

    it('tells Telegram that the page is ready, expands it and paints the window dark', () => {
      document.documentElement.style.setProperty('--bg-1', '#101011')
      document.documentElement.style.setProperty('--bg-0', '#0b0b0c')
      const calls: string[] = []
      const ready = vi.fn(() => calls.push('ready'))
      const expand = vi.fn(() => calls.push('expand'))
      const setColorScheme = vi.fn(() => calls.push('dark'))
      const setHeaderColor = vi.fn(() => calls.push('header'))
      const setBackgroundColor = vi.fn(() => calls.push('background'))
      window.Telegram = {
        WebApp: { initData: INIT_DATA, ready, expand, setColorScheme, setHeaderColor, setBackgroundColor },
      }

      applyTelegramChrome()

      // Порядок здесь важнее содержимого: без ready() Telegram не показывает
      // страницу, а без expand() она остаётся половиной экрана.
      expect(calls).toEqual(['ready', 'expand', 'dark', 'header', 'background'])
      expect(setColorScheme).toHaveBeenCalledWith('dark')
      expect(setHeaderColor).toHaveBeenCalledWith('#101011')
      expect(setBackgroundColor).toHaveBeenCalledWith('#0b0b0c')
      document.documentElement.style.removeProperty('--bg-1')
      document.documentElement.style.removeProperty('--bg-0')
    })

    it('moves the Telegram safe-area numbers into the CSS variables', () => {
      // В его вебвью env(safe-area-inset-*) часто ноль: выемку знает только
      // клиент, и она обязана дойти до стилей, иначе нижняя панель ложится под
      // жест возврата на iPhone.
      window.Telegram = { WebApp: { initData: INIT_DATA, safeAreaInset: { top: 47, bottom: 34 } } }
      applyTelegramChrome()
      expect(document.documentElement.style.getPropertyValue('--tg-safe-top')).toBe('47px')
      expect(document.documentElement.style.getPropertyValue('--tg-safe-bottom')).toBe('34px')
      expect(document.documentElement.style.getPropertyValue('--tg-safe-left')).toBe('')
    })

    it('survives an old SDK that injected only initData', () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      expect(() => applyTelegramChrome()).not.toThrow()
    })

    it('waits for the SDK through ensureTelegramChrome', async () => {
      // Приложение вызывает именно её: на первом рендере window.Telegram ещё нет,
      // скрипт догружается, и настроить окно надо после.
      const ready = vi.fn()
      await ensureTelegramChrome({ sdk: { initData: INIT_DATA, ready } })
      expect(ready).toHaveBeenCalled()
    })

    it('does nothing outside the webview', async () => {
      await expect(ensureTelegramChrome({ userAgent: BROWSER_UA })).resolves.toBeUndefined()
      expect(() => applyTelegramChrome()).not.toThrow()
    })
  })

  describe('setTelegramBackHandler', () => {
    afterEach(() => {
      setTelegramBackHandler(false, () => {})
      delete window.Telegram
    })

    it('shows the button and registers exactly one handler', () => {
      const onPress = vi.fn()
      const button = { show: vi.fn(), hide: vi.fn(), onPress: vi.fn(), offPress: vi.fn() }
      window.Telegram = { WebApp: { initData: INIT_DATA, BackButton: button, onEvent: vi.fn() } }

      setTelegramBackHandler(true, onPress)

      expect(button.onPress).toHaveBeenCalledWith(onPress)
      // onPress и onEvent внутри SDK — один и тот же сигнал: второй регистрацией
      // был бы двойной вызов на одно нажатие.
      expect(window.Telegram.WebApp!.onEvent).not.toHaveBeenCalled()
      expect(button.show).toHaveBeenCalled()
    })

    it('replaces the previous handler instead of stacking them', () => {
      const button = { show: vi.fn(), hide: vi.fn(), onPress: vi.fn(), offPress: vi.fn() }
      window.Telegram = { WebApp: { initData: INIT_DATA, BackButton: button } }
      const first = () => {}
      const second = () => {}

      setTelegramBackHandler(true, first)
      setTelegramBackHandler(true, second)

      expect(button.offPress).toHaveBeenCalledWith(first)
      expect(button.onPress).toHaveBeenLastCalledWith(second)
    })

    it('hides and detaches when there is nothing left to close', () => {
      const button = { show: vi.fn(), hide: vi.fn(), onPress: vi.fn(), offPress: vi.fn() }
      window.Telegram = { WebApp: { initData: INIT_DATA, BackButton: button } }
      setTelegramBackHandler(true, () => {})

      setTelegramBackHandler(false, () => {})

      expect(button.offPress).toHaveBeenCalled()
      expect(button.hide).toHaveBeenCalled()
    })

    it('uses the event API when the SDK has no BackButton', () => {
      // Старые вебвью: без этой ветки «назад» в мини-аппе на старом клиенте
      // вообще ничего не закрывала бы.
      const onEvent = vi.fn()
      const offEvent = vi.fn()
      window.Telegram = { WebApp: { initData: INIT_DATA, onEvent, offEvent } }
      const handler = () => {}

      setTelegramBackHandler(true, handler)

      expect(onEvent).toHaveBeenCalledTimes(1)
      expect(onEvent).toHaveBeenCalledWith('backButtonClicked', handler)
      setTelegramBackHandler(false, handler)
      expect(offEvent).toHaveBeenCalledWith('backButtonClicked', handler)
    })

    it('is a no-op in a normal browser', () => {
      expect(() => setTelegramBackHandler(true, () => {})).not.toThrow()
    })
  })

  describe('telegramNotify', () => {
    afterEach(() => {
      delete window.Telegram
    })

    it('maps the outcome onto the haptic signal', () => {
      const notificationOccurred = vi.fn()
      const impactOccurred = vi.fn()
      window.Telegram = { WebApp: { initData: INIT_DATA, HapticFeedback: { notificationOccurred, impactOccurred } } }

      telegramNotify('error')
      telegramNotify('success')
      telegramNotify('info')

      expect(notificationOccurred.mock.calls).toEqual([['error'], ['success']])
      expect(impactOccurred).toHaveBeenCalledWith('light')
    })

    it('is silent where there is nothing to vibrate', () => {
      window.Telegram = { WebApp: { initData: INIT_DATA } }
      expect(() => telegramNotify('success')).not.toThrow()
      delete window.Telegram
      expect(() => telegramNotify('success')).not.toThrow()
    })
  })

  describe('openExternally', () => {
    afterEach(() => {
      delete window.Telegram
    })

    it('routes t.me into Telegram itself', () => {
      const openTelegramLink = vi.fn()
      const openLink = vi.fn()
      window.Telegram = { WebApp: { initData: INIT_DATA, openTelegramLink, openLink } }

      openExternally('https://t.me/waketrade_bot')

      expect(openTelegramLink).toHaveBeenCalledWith('https://t.me/waketrade_bot')
      expect(openLink).not.toHaveBeenCalled()
    })

    it('opens any other address outside the current webview', () => {
      const openTelegramLink = vi.fn()
      const openLink = vi.fn()
      window.Telegram = { WebApp: { initData: INIT_DATA, openTelegramLink, openLink } }

      openExternally('https://wake-7k6.pages.dev/?tab=terminal')

      expect(openLink).toHaveBeenCalledWith('https://wake-7k6.pages.dev/?tab=terminal')
      expect(openTelegramLink).not.toHaveBeenCalled()
    })

    it('falls back to a new tab in a plain browser', () => {
      const open = vi.fn()
      window.open = open
      openExternally('https://t.me/waketrade_bot')
      expect(open).toHaveBeenCalledWith('https://t.me/waketrade_bot', '_blank', 'noopener,noreferrer')
    })
  })
})
