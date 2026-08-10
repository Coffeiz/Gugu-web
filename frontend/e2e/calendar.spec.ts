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

test('浮动活动编辑窗内选择日期不会被 Teleport 弹层误关', async ({ page }) => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const initialDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
  const title = `E2E 活动 ${Date.now()}`
  const response = await page.request.post('/api/v1/events', {
    data: { title, date: initialDate, type: 'event' },
  })
  expect(response.ok()).toBeTruthy()
  const created = await response.json()

  try {
    await page.goto('/calendar')
    await expect(page.locator('.month-body')).toBeVisible()

    const chip = page.locator('.event-chip.chip-ev-click').filter({ hasText: title })
    await expect(chip).toBeVisible()
    await chip.click()

    const editModal = page.locator('.eem-floating')
    await expect(editModal).toBeVisible()
    await editModal.locator('.dp-input').click()
    await expect(page.locator('.dp-popup')).toBeVisible()

    const nextDay = page.locator('.dp-popup .dp-day:not(.other):not(.disabled):not(.selected)').first()
    const nextDayNumber = await nextDay.innerText()
    await nextDay.click()

    await expect(editModal).toBeVisible()
    await expect(editModal.locator('.dp-input')).toContainText(`${now.getMonth() + 1}/${Number(nextDayNumber)}`)
  } finally {
    await page.request.delete(`/api/v1/events/${created.id}`)
  }
})
