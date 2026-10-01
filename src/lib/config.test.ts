import { describe, it, expect } from 'vitest'
import { BACKEND_URL, SIGNING_SERVICE_URL, LIGHTER_NETWORK } from './config'

describe('config', () => {
  it('has default backend URL', () => {
    expect(BACKEND_URL).toBe('http://localhost:8000')
  })

  it('has default signing service URL', () => {
    expect(SIGNING_SERVICE_URL).toBe('http://localhost:8787')
  })

  it('defaults to testnet', () => {
    expect(LIGHTER_NETWORK).toBe('testnet')
  })
})
