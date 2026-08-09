import { test, expect } from '@playwright/test'

test('日历月视图与周视图可以切换', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.locator('.cal-page')).toBeVisible()

  const monthButton = page.locator('.view-toggle button').filter({ hasText: '月' })
  const weekButton = page.locator('.view-toggle button').filter({ hasText: '周' })
  await monthButton.click()
  await expect(page.locator('.month-body')).toBeVisible()
  expect(await page.locator('.month-cell').count()).toBeGreaterThan(0)

  await weekButton.click()
  await expect(page.locator('.week-view')).toBeVisible()
  await expect(page.locator('.month-body')).toHaveCount(0)

  await monthButton.click()
  await expect(page.locator('.month-body')).toBeVisible()
})
