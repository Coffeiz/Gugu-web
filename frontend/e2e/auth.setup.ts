import { test as setup, expect } from '@playwright/test'
import { authFile } from '../playwright.config'

setup('使用测试账号登录', async ({ page }) => {
  // CI 首次启动 Vite 需要完成依赖预构建，登录 setup 使用独立的冷启动预算。
  setup.setTimeout(120000)
  const username = process.env.PLAYWRIGHT_USERNAME
  const password = process.env.PLAYWRIGHT_PASSWORD
  if (!username || !password) {
    throw new Error('请设置 PLAYWRIGHT_USERNAME 和 PLAYWRIGHT_PASSWORD 后运行 E2E 测试')
  }

  // Vite dev server 首次访问可能仍在预构建依赖；等待网络空闲并确认登录页已挂载，
  // 避免把冷启动期间的空白页面误判成登录回归。
  await page.goto('/login', { waitUntil: 'networkidle', timeout: 90000 })
  const loginButton = page.locator('button[type="submit"]')
  await expect(loginButton).toBeVisible({ timeout: 60000 })
  const usernameInput = page.locator('input[autocomplete="username"]')
  const passwordInput = page.locator('input[autocomplete="current-password"]')
  await usernameInput.fill(username)
  await passwordInput.fill(password)
  await expect(usernameInput).toHaveValue(username)
  await expect(passwordInput).toHaveValue(password)
  page.on('requestfailed', request => {
    console.log(`[浏览器请求失败] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
  })
  page.on('pageerror', error => console.log(`[浏览器异常] ${error.message}`))
  const loginResponse = page.waitForResponse(response =>
    response.url().endsWith('/api/v1/auth/login') && response.request().method() === 'POST',
  )
  await expect(loginButton).toBeEnabled()
  await loginButton.click()
  const response = await loginResponse
  expect(response.ok(), `登录接口返回 ${response.status()}: ${await response.text()}`).toBeTruthy()
  await expect(page).not.toHaveURL(/\/login/)
  await page.context().storageState({ path: authFile })
})
