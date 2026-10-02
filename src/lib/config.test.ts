import { describe, it, expect } from 'vitest'
import { BACKEND_URL, SIGNING_SERVICE_URL, LIGHTER_NETWORK, WALLETCONNECT_PROJECT_ID } from './config'

describe('config', () => {
  it('has default backend URL', () => {
    expect(BACKEND_URL).toBe('http://localhost:8000')
  })

  it('has default signing service URL', () => {
    expect(SIGNING_SERVICE_URL).toBe('http://localhost:8787')
  })

  it('defaults to the same network as the backend', () => {
    // backend/config.py берёт сеть из WAKE_LIGHTER_NETWORK с дефолтом mainnet.
    // Если дефолты разойдутся, страница и бот начнут показывать разные market ids.
    expect(LIGHTER_NETWORK).toBe('mainnet')
  })

  it('ships no WalletConnect project id placeholder', () => {
    // 'REPLACE_ME' прошёл бы в walletConnect({ projectId }) и уткнулся бы в 400/403
    // на старте. Пустая строка — сигнал не добавлять коннектор (см. src/wagmi.ts).
    expect(WALLETCONNECT_PROJECT_ID).toBe('')
  })
})
