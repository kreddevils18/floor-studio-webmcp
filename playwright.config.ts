import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4173/floor-studio-webmcp/', trace: 'retain-on-failure' },
  webServer: {
    command: 'bun run preview',
    url: 'http://127.0.0.1:4173/floor-studio-webmcp/',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 } } },
    { name: 'mobile-review', use: { ...devices['Pixel 7'] } },
  ],
})
