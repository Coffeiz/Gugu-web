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
  await Promise.all([
    page.waitForURL(url => !url.pathname.endsWith('/login')),
    page.getByRole('button', { name: '登录' }).click(),
  ])
  await expect(page).not.toHaveURL(/\/login/)
  await page.context().storageState({ path: authFile })
})
