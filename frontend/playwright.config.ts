import { defineConfig, devices } from '@playwright/test'

export const authFile = 'playwright/.auth/user.json'

/**
 * E2E 默认连接已启动的 devserver；Gugu-web 的开发服务由 devserver 管理，
 * 本地不在 Playwright 中重复拉起前后端进程。通过 PLAYWRIGHT_BASE_URL 切换环境。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], storageState: authFile },
    },
  ],
})
