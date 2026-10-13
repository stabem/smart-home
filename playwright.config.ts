import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: 'http://127.0.0.1:5173', browserName: 'chromium' },
  webServer: { command: 'npm run dev:renderer', url: 'http://127.0.0.1:5173/?fixture=house', reuseExistingServer: true, timeout: 30_000 }
})
