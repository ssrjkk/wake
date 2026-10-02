import { defineConfig, devices } from '@playwright/test'

// Хост и порт задаются явно, а не дефолтным «localhost»: Node на Windows резолвит
// localhost в ::1, и сервер, поднявшийся только на IPv6-петле, затем недоступен
// ни проверки webServer, ни браузеру. 127.0.0.1 работает одинаково на Linux-раннере
// CI и на локальной машине, а PW_PORT спасает, когда 5173 уже занят другим процессом.
const HOST = '127.0.0.1'
const PORT = Number(process.env.PW_PORT ?? 5173)
const BASE_URL = `http://${HOST}:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --host ${HOST} --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
  },
})
