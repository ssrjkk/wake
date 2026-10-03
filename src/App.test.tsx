import { describe, it, expect } from 'vitest'

describe('App', () => {
  it('exports App component', async () => {
    const App = (await import('./App')).default
    expect(App).toBeDefined()
    expect(typeof App).toBe('function')
  }, 10000)
})
