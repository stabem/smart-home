import { defineConfig } from '@playwright/test'

const port = process.env.SMART_HOME_TEST_PORT || '5173'

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: { command: `npm run dev:renderer -- --port ${port} --strictPort`, url: `http://127.0.0.1:${port}/?fixture=house`, reuseExistingServer: false, timeout: 30_000 }
})
