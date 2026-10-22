import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { backendJson, errorText, probeBackend, SIGNED_OUT_EVENT } from './backend'
import { getSession, saveSession } from './session'

// Что здесь проверяется — не формат сообщения, а то, что ни одно из трёх состояний
// «бэкенда нет» не выходит наружу как SyntaxError из res.json(): на хостинге SPA-
// заглушка отвечает 200 + HTML, и без этого слоя панели печатают кусок разметки.
describe('backendJson', () => {
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

  async function expectError(call: () => Promise<unknown>): Promise<string> {
    const message = await call().then(() => null, (e: unknown) => String(e instanceof Error ? e.message : e))
    expect(message).not.toBeNull()
    return message!
  }

  const headersOf = (i = 0) => (fetchMock.mock.calls[i][1] as RequestInit).headers as Headers

  it('asks the configured backend and returns parsed json', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ count: 2 }) })
    await expect(backendJson('/markets/overview')).resolves.toEqual({ count: 2 })
    expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/markets/overview`)
  })

  // Заголовок подмешивается в единственной точке, через которую ходит весь бэкенд:
  // роутеры читают субъекта из токена, и вызов без заголовка — это анонимный запрос,
  // который упрётся в 401 там, где человек уже вошёл.
  it('carries the session token on every call', async () => {
    saveSession({ user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: Math.floor(Date.now() / 1000) + 600 })
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })
    await backendJson('/follows')
    expect(headersOf().get('Authorization')).toBe('Bearer wk1.aaa.bbb')
  })

  it('sends no credential when nobody has signed in', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) })
    await backendJson('/leaders')
    expect(headersOf().get('Authorization')).toBeNull()
  })

  it('keeps the caller headers alongside the token', async () => {
    saveSession({ user_id: '0xabc', token: 'wk1.aaa.bbb', expires_at: Math.floor(Date.now() / 1000) + 600 })
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    await backendJson('/follows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(headersOf().get('Content-Type')).toBe('application/json')
    expect(headersOf().get('Authorization')).toBe('Bearer wk1.aaa.bbb')
  })

  // 401 — это «токен больше не действителен», и состояние входа должно уйти сразу:
  // иначе панели показывают пустоту там, где нужен повторный вход.
  it('drops the session and announces sign-out on 401', async () => {
    saveSession({ user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: Math.floor(Date.now() / 1000) + 600 })
    const seen = vi.fn()
    window.addEventListener(SIGNED_OUT_EVENT, seen)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve('{"error":{"code":"SESSION_EXPIRED","message":"Войди заново"}}'),
    })

    await expect(expectError(() => backendJson('/follows'))).resolves.toContain('Войди заново')
    expect(getSession()).toBeNull()
    expect(localStorage.getItem('wake.session.v1')).toBeNull()
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener(SIGNED_OUT_EVENT, seen)
  })

  it('leaves the session alone on an error that is not 401', async () => {
    saveSession({ user_id: 'tg_4350', token: 'wk1.aaa.bbb', expires_at: Math.floor(Date.now() / 1000) + 600 })
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve(null), text: () => Promise.resolve('') })

    await expectError(() => backendJson('/follows'))
    expect(getSession()?.token).toBe('wk1.aaa.bbb')
  })

  it('names the error code next to the message the backend wrote', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve(null),
      text: () => Promise.resolve('{"error":{"code":"LIGHTER_ACCOUNT_NOT_LINKED","message":"Нужен вход кошельком"}}'),
    })
    await expect(expectError(() => backendJson('/leaders', { method: 'POST' }))).resolves.toBe(
      'Нужен вход кошельком (LIGHTER_ACCOUNT_NOT_LINKED)'
    )
  })

  it('keeps the backend error text as the reason on non-2xx', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, text: () => Promise.resolve('рынок уже резолвлен') })
    await expect(expectError(() => backendJson('/x'))).resolves.toContain('рынок уже резолвлен')
  })

  it('falls back to the status code when the error body is empty', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('') })
    await expect(expectError(() => backendJson('/x'))).resolves.toContain('Бэкенд Wake 502')
  })

  it('names the backend as missing when the host answers with the site itself', async () => {
    // Cloudflare Pages с _redirects отдаёт index.html на любой путь, то есть 200 и
    // тело, которое не JSON. res.json() на этом бросает SyntaxError.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`)),
    })
    const message = await expectError(() => backendJson('/predict/markets'))
    // localhost и production дают разные сообщения; проверяем общее — нет сырого SyntaxError
    expect(message).not.toContain('Unexpected token')
  })

  it('says the backend does not answer when the request never got a response', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const message = await expectError(() => backendJson('/leaders'))
    // localhost: "Сервер недоступен"; production: "${URL} не отвечает"
    expect(message.toLowerCase()).toMatch(/не отвечает|недоступен/)
  })

  it('preserves the transport failure as the error cause', async () => {
    const cause = new TypeError('Failed to fetch')
    fetchMock.mockRejectedValue(cause)
    await expect(backendJson('/leaders')).rejects.toMatchObject({ cause })
  })

  it('checks readiness as well as liveness before accepting the backend', async () => {
    const health = { status: 'ok', network: 'mainnet', dry_run: true }
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(health) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ready' }) })
    await expect(probeBackend()).resolves.toEqual(health)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/health`)
    expect(fetchMock.mock.calls[1][0]).toBe(`${BACKEND_URL}/ready`)
  })

  it('rejects a live backend whose dependencies are unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok', network: 'mainnet', dry_run: true }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('{"status":"not_ready","checks":{"database":"fail","redis":"fail"}}') })
    await expect(probeBackend()).rejects.toThrow('not_ready')
  })

  it('does not accept a non-ready payload hidden behind HTTP 200', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'ok', network: 'mainnet', dry_run: true }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: 'not_ready' }) })
    await expect(probeBackend()).rejects.toThrow('не готов')
  })
})

// Панели печатают этот текст прямо в баннер, поэтому здесь важны обе детали:
// без префикса «Error: » и без обрыва посреди слова.
describe('errorText', () => {
  it('drops the constructor prefix that String(error) adds', () => {
    expect(errorText(new Error('рынок уже резолвлен'))).toBe('рынок уже резолвлен')
  })

  it('keeps a thrown non-error readable', () => {
    expect(errorText('запрос отклонён')).toBe('запрос отклонён')
  })

  it('cuts long text with an ellipsis instead of mid-word', () => {
    const cut = errorText(new Error('a'.repeat(200)), 20)
    expect(cut).toHaveLength(20)
    expect(cut.endsWith('…')).toBe(true)
  })
})
