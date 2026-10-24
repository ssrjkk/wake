import { describe, it, expect, vi, afterEach } from 'vitest'
import { PUBLIC_TIMEOUT_MS, BACKEND_TIMEOUT_MS, isTimeoutError, timeoutText, timedFetch } from './net'

// Таймаут нужен не для скорости, а чтобы висящее соединение не оставляло панель
// в состоянии «загружаю…» до конца открытия вкладки: интервалы опроса добавляют
// поверх висящих запросов новые.

function timeoutError(): Error {
  // Так выглядит DOMException, которую отдаёт AbortSignal.timeout: имя важно,
  // сообщение — нет ("signal timed out" человеку не объяснение).
  const e = new Error('signal timed out')
  e.name = 'TimeoutError'
  return e
}

describe('isTimeoutError', () => {
  it('различает таймаут и обрыв по имени, а не по тексту', () => {
    expect(isTimeoutError(timeoutError())).toBe(true)
    const aborted = new Error('The operation was canceled')
    aborted.name = 'AbortError'
    expect(isTimeoutError(aborted)).toBe(true)
    expect(isTimeoutError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isTimeoutError('TimeoutError')).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
  })
})

describe('timeoutText', () => {
  it('печатает секунды, а не миллисекунды', () => {
    expect(timeoutText(10_000)).toBe('нет ответа за 10 с')
    expect(timeoutText(1500)).toBe('нет ответа за 2 с')
  })
})

describe('timedFetch', () => {
  const realFetch = global.fetch

  afterEach(() => {
    global.fetch = realFetch
  })

  it('просит AbortSignal с таймаутом и отдаёт ответ как есть', async () => {
    const response = { ok: true } as Response
    const fetchMock = vi.fn().mockResolvedValue(response)
    global.fetch = fetchMock

    await expect(timedFetch('https://example.test/x')).resolves.toBe(response)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.test/x')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.signal?.aborted).toBe(false)
  })

  it('превращает таймаут в читаемую ошибку, сохраняя причину', async () => {
    global.fetch = vi.fn().mockRejectedValue(timeoutError())

    const error = await timedFetch('https://example.test/x', 10_000).then(() => null, (e: Error) => e)
    expect(error).not.toBeNull()
    expect(error!.message).toBe('нет ответа за 10 с')
    expect(error!.cause).toBeInstanceOf(Error)
  })

  it('прочую сетевую ошибку не переписывает', async () => {
    const boom = new TypeError('Failed to fetch')
    global.fetch = vi.fn().mockRejectedValue(boom)

    await expect(timedFetch('https://example.test/x')).rejects.toBe(boom)
  })
})

describe('константы таймаутов', () => {
  it('бэкенд ждёт дольше публичного REST, и оба значения человеческие', () => {
    // /markets/overview на бэкенде — это 18 свечных запросов на сервере, а не
    // один RTT; обрывать его раньше публичной котировки значило бы врать про
    // «бэкенд не отвечает».
    expect(BACKEND_TIMEOUT_MS).toBeGreaterThan(PUBLIC_TIMEOUT_MS)
    expect(PUBLIC_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(BACKEND_TIMEOUT_MS).toBeLessThan(60_000)
  })
})
