import { test as setup, expect } from '@playwright/test'
import { authFile } from '../playwright.config'

setup('使用测试账号登录', async ({ page }) => {
  const username = process.env.PLAYWRIGHT_USERNAME
  const password = process.env.PLAYWRIGHT_PASSWORD
  if (!username || !password) {
    throw new Error('请设置 PLAYWRIGHT_USERNAME 和 PLAYWRIGHT_PASSWORD 后运行 E2E 测试')
  }

  await page.goto('/login')
  await page.locator('input[autocomplete="username"]').fill(username)
  await page.locator('input[autocomplete="current-password"]').fill(password)
  const loginResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
  )
  const [, response] = await Promise.all([
    page.getByRole('button', { name: '登录' }).click(),
    loginResponse,
  ])
  expect(response.ok(), `登录接口返回 ${response.status()}: ${await response.text()}`).toBeTruthy()
  await expect(page).not.toHaveURL(/\/login/)
  await page.context().storageState({ path: authFile })
})
