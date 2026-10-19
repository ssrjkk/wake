import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BACKEND_URL } from './config'
import { verifyWalletOwnership } from './wallet'
import { clearSession } from './session'
import { jsonBody } from '../test/request'

// Текст challenge берётся ровно тот, что отдал бэкенд: он живёт пять минут и
// снимается первой проверкой, а любое изменение строки ломает восстановление
// адреса из подписи — вход отклоняется как недействительный.
const MESSAGE = 'Wake sign-in\nnonce: 4f2a\naddress: 0xabc'

describe('verifyWalletOwnership', () => {
  // Настоящий Response, а не подделка с двумя полями: lib/backend.ts читает ok,
  // status, json/text и заголовки, и мок обязан вести себя так же.
  function reply(status: number, body: unknown, raw?: string) {
    return new Response(raw ?? JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  const fetchMock = vi.fn<typeof fetch>()
  const realFetch = global.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock
    clearSession()
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  // Ответы идут парами (challenge, затем verify), поэтому once: mockResolvedValue
  // перезаписал бы первый, и второй вызов вернул бы текст challenge вместо токена.
  const ok = (data: unknown) => fetchMock.mockResolvedValueOnce(reply(200, data))

  // URL запрашивается строкой (backendJson собирает его из BACKEND_URL + path), поэтому
  // нестроковый аргумент — ошибка мока, а не «не совпало»: String() от объекта дал бы
  // '[object Object]' и сравнение ниже провалилось бы по непонятной причине.
  function asked(i = 0) {
    const input = fetchMock.mock.calls[i][0]
    if (typeof input !== 'string') throw new Error(`ожидался строковый URL, получен ${typeof input}`)
    return input
  }
  const bodyOf = (i = 0) => jsonBody(fetchMock.mock.calls[i][1])

  it('asks for a challenge, signs it, then verifies', async () => {
    ok({ message: MESSAGE, expires_at: 1_760_000_600 })
    ok({ user_id: '0xabc', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400, lighter_account_index: 123 })
    const sign = vi.fn().mockResolvedValue('0xsig')

    const res = await verifyWalletOwnership('0xabc', sign)

    expect(asked(0)).toBe(`${BACKEND_URL}/auth/wallet/challenge`)
    expect(bodyOf(0)).toEqual({ l1_address: '0xabc' })
    expect(sign).toHaveBeenCalledWith(MESSAGE)
    expect(asked(1)).toBe(`${BACKEND_URL}/auth/wallet/verify`)
    expect(bodyOf(1)).toEqual({ message: MESSAGE, signature: '0xsig' })
    expect(res).toEqual({ user_id: '0xabc', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400, lighter_account_index: 123 })
  })

  // Индекс Lighter приходит с сервера: фронт не может прислать свой, и именно по
  // этой причине публикация лидера берёт индекс из записи входа, а не из тела запроса.
  it('keeps a confirmed wallet without a Lighter account distinguishable', async () => {
    ok({ message: MESSAGE, expires_at: 1_760_000_600 })
    ok({ user_id: '0xabc', token: 'wk1.aaa.bbb', expires_at: 1_760_002_400, lighter_account_index: null })

    const res = await verifyWalletOwnership('0xabc', vi.fn().mockResolvedValue('0xsig'))

    expect(res.lighter_account_index).toBeNull()
  })

  it('sends nothing to /verify when the signature was not given', async () => {
    ok({ message: MESSAGE, expires_at: 1_760_000_600 })

    await expect(verifyWalletOwnership('0xabc', vi.fn().mockRejectedValue(new Error('User rejected the message')))).rejects.toThrow(
      'User rejected the message'
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(asked()).toBe(`${BACKEND_URL}/auth/wallet/challenge`)
  })

  it('passes the backend refusal through', async () => {
    ok({ message: MESSAGE, expires_at: 1_760_000_600 })
    fetchMock.mockResolvedValueOnce(
      reply(401, null, '{"error":{"code":"CHALLENGE_EXPIRED","message":"Challenge истёк, запроси новый"}}')
    )

    await expect(verifyWalletOwnership('0xabc', vi.fn().mockResolvedValue('0xsig'))).rejects.toThrow(/Challenge истёк.*CHALLENGE_EXPIRED/)
  })
})
