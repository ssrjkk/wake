import { describe, it, expect, vi, afterEach } from 'vitest'

// Тест держит значения по умолчанию из config.ts, а не переменные окружения
// разработчика: локальный .env задаёт VITE_*, и без этого module-factory читающий
// его тест прошёл бы дома и упал в CI, где .env не закоммичен. Пустая строка
// не проходит по `||`, поэтому свежая копия модуля возвращает fallback-строку.
async function defaultConfig() {
  vi.resetModules()
  for (const key of [
    'VITE_BACKEND_URL',
    'VITE_SIGNING_SERVICE_URL',
    'VITE_LIGHTER_NETWORK',
    'VITE_WALLETCONNECT_PROJECT_ID',
  ]) {
    vi.stubEnv(key, '')
  }
  return import('./config')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('config', () => {
  it('has default backend URL', async () => {
    const { BACKEND_URL } = await defaultConfig()
    expect(BACKEND_URL).toBe('https://wake-backend-production-3483.up.railway.app')
  })

  it('has default signing service URL', async () => {
    const { SIGNING_SERVICE_URL } = await defaultConfig()
    expect(SIGNING_SERVICE_URL).toBe('http://localhost:8787')
  })

  it('defaults to the same network as the backend', async () => {
    // backend/config.py берёт сеть из WAKE_LIGHTER_NETWORK с дефолтом mainnet.
    // Если дефолты разойдутся, страница и бот начнут показывать разные market ids.
    const { LIGHTER_NETWORK } = await defaultConfig()
    expect(LIGHTER_NETWORK).toBe('mainnet')
  })

  it('ships no WalletConnect project id placeholder', async () => {
    // 'REPLACE_ME' прошёл бы в walletConnect({ projectId }) и уткнулся бы в 400/403
    // на старте. Пустая строка — сигнал не добавлять коннектор (см. src/wagmi.ts).
    const { WALLETCONNECT_PROJECT_ID } = await defaultConfig()
    expect(WALLETCONNECT_PROJECT_ID).toBe('')
  })
})
