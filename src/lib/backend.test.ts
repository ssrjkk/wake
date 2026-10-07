import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { backendJson, errorText, probeBackend } from './backend'

// Что здесь проверяется — не формат сообщения, а то, что ни одно из трёх состояний
// «бэкенда нет» не выходит наружу как SyntaxError из res.json(): на хостинге SPA-
// заглушка отвечает 200 + HTML, и без этого слоя панели печатают кусок разметки.
describe('backendJson', () => {
  const fetchMock = vi.fn()
  const realFetch = global.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  async function expectError(call: () => Promise<unknown>): Promise<string> {
    const message = await call().then(() => null, (e: unknown) => String(e instanceof Error ? e.message : e))
    expect(message).not.toBeNull()
    return message!
  }

  it('asks the configured backend and returns parsed json', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ count: 2 }) })
    await expect(backendJson('/markets/overview')).resolves.toEqual({ count: 2 })
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/markets/overview`, undefined)
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

  it('probes /health for the backend status', async () => {
    const health = { status: 'ok', network: 'mainnet', dry_run: true }
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve(health) })
    await expect(probeBackend()).resolves.toEqual(health)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BACKEND_URL}/health`)
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
