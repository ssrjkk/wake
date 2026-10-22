import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    maxWorkers: 2,
    globals: true,
    setupFiles: './src/test/setup.ts',
    exclude: ['node_modules', 'e2e'],
  },
})
