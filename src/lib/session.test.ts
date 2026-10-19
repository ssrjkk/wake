import { describe, it, expect, beforeEach } from 'vitest'
import { authHeader, clearSession, getSession, isSessionExpired, saveSession, type SignInResponse } from './session'

// Ключ и форма совпадают с lib/session.ts: проверка «токен переживает перезагрузку»
// бессмысленна, если мок пишет под другим ключом.
const KEY = 'wake.session.v1'

const future = Math.floor(Date.now() / 1000) + 3600

const response = (over: Partial<SignInResponse> = {}): SignInResponse => ({
  user_id: 'tg_4350',
  token: 'wk1.eyJ1IjoiIn0.sig',
  expires_at: future,
  ...over,
})

describe('session', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores what the backend issued and reads it back', () => {
    const saved = saveSession(response(), { via: 'telegram', label: '@wake_user' })
    expect(getSession()).toEqual(saved)
    expect(saved).toEqual({
      token: 'wk1.eyJ1IjoiIn0.sig',
      userId: 'tg_4350',
      expiresAt: future,
      lighterAccountIndex: null,
      label: '@wake_user',
      via: 'telegram',
    })
  })

  it('keeps the Lighter index the wallet sign-in returned', () => {
    // Публикация лидера на бэкенде берёт индекс из своей записи, а фронт — из
    // сессии, чтобы показать тот же индекс, а не тот, что обещает подключённый кошелёк.
    saveSession(response({ lighter_account_index: 77 }), { via: 'wallet', label: '0xAbC…1234' })
    expect(getSession()?.lighterAccountIndex).toBe(77)
  })

  it('has no session before a sign-in and none after a sign-out', () => {
    expect(getSession()).toBeNull()
    expect(authHeader()).toEqual({})
    saveSession(response())
    clearSession()
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('sends the token as a bearer credential', () => {
    saveSession(response())
    expect(authHeader()).toEqual({ Authorization: 'Bearer wk1.eyJ1IjoiIn0.sig' })
  })

  it('drops an expired session instead of returning a token the backend rejects', () => {
    // Форма — тот самый Session, который пишет saveSession (camelCase), а не ответ
    // входа: иначе проверка шла бы по ветке «не распознали запись», а не по сроку.
    const expired = future - 7200
    localStorage.setItem(
      KEY,
      JSON.stringify({ token: 'wk1.aaa.bbb', userId: 'tg_4350', expiresAt: expired, lighterAccountIndex: null, label: null, via: null })
    )
    expect(getSession()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('treats expiry in the epoch seconds the backend uses', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(isSessionExpired({ token: 't', userId: 'u', expiresAt: now - 1, lighterAccountIndex: null, label: null, via: null })).toBe(true)
    expect(isSessionExpired({ token: 't', userId: 'u', expiresAt: now + 60, lighterAccountIndex: null, label: null, via: null })).toBe(false)
  })

  // Токен в хранилище может быть испорчен чем угодно: старый ключ, обрезанная
  // запись, чужой формат. Ответ «нет входа» здесь безопаснее, чем запрос с
  // заведомо битым заголовком, а падение страницы — тем более не вариант.
  it.each([
    ['не JSON вовсе', 'not json at all'],
    ['без токена', JSON.stringify({ userId: 'tg_1', expiresAt: future })],
    ['без пользователя', JSON.stringify({ token: 'wk1.x.y', expiresAt: future })],
    ['пустой объект', JSON.stringify({})],
  ])('ignores a stored session %s', (_label, raw) => {
    localStorage.setItem(KEY, raw)
    expect(getSession()).toBeNull()
    expect(authHeader()).toEqual({})
  })
})
