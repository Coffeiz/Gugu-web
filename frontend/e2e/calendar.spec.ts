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

test('框选日期后可以从侧栏创建带日期范围的项目', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.locator('.month-body')).toBeVisible()

  const cells = page.locator('.month-cell:not(.other-month)')
  const start = cells.nth(0)
  const end = cells.nth(1)
  const startIso = await start.getAttribute('data-iso')
  const endIso = await end.getAttribute('data-iso')
  expect(startIso).toBeTruthy()
  expect(endIso).toBeTruthy()

  const startBox = await start.boundingBox()
  const endBox = await end.boundingBox()
  expect(startBox).not.toBeNull()
  expect(endBox).not.toBeNull()
  await page.mouse.move(startBox!.x + 10, startBox!.y + 12)
  await page.mouse.down()
  await page.mouse.move(endBox!.x + 10, endBox!.y + 12)
  await page.mouse.up()

  const addProject = page.locator('.add-proj-btn')
  await expect(addProject).toBeVisible()
  await addProject.click()
  await expect(page.locator('.header-name-input')).toBeVisible()

  const fmt = (iso: string) => {
    const [year, month, day] = iso.split('-').map(Number)
    const currentYear = new Date().getFullYear()
    return year === currentYear ? `${month}/${day}` : `${year}/${month}/${day}`
  }
  await expect(page.locator('.drp-input')).toContainText(`${fmt(startIso!)} — ${fmt(endIso!)}`)
})
