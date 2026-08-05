import { test, expect } from '@playwright/test'

test('登录态可以访问应用', async ({ page }) => {
  await page.goto('/')
  await expect(page).not.toHaveURL(/\/login/)
})
