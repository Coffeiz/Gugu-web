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

test('暗色月视图中框选范围的周末使用选中底色', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.locator('.month-body')).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.family = 'glass'
  })

  let friday: ReturnType<typeof page.locator> | null = null
  let sunday: ReturnType<typeof page.locator> | null = null
  {
    // 按月视图的完整日期序列定位，兼容周日/周一起始以及跨行框选。
    const cells = page.locator('.month-body .month-cell')
    const dates = await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-iso')))
    for (let dayIndex = 0; dayIndex <= dates.length - 3; dayIndex += 1) {
      const startDate = dates[dayIndex]
      const endDate = dates[dayIndex + 2]
      if (!startDate || !endDate) continue
      const startDay = new Date(`${startDate}T00:00:00`).getDay()
      const middleDay = new Date(`${dates[dayIndex + 1]}T00:00:00`).getDay()
      const endDay = new Date(`${endDate}T00:00:00`).getDay()
      if (startDay === 5 && middleDay === 6 && endDay === 0) {
        friday = cells.nth(dayIndex)
        sunday = cells.nth(dayIndex + 2)
        break
      }
    }
  }

  expect(friday).not.toBeNull()
  expect(sunday).not.toBeNull()
  const startBox = await friday!.boundingBox()
  const endBox = await sunday!.boundingBox()
  expect(startBox).not.toBeNull()
  expect(endBox).not.toBeNull()
  await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + 12)
  await page.mouse.down()
  await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + 12)
  await page.mouse.up()

  const weekendPaint = await page.locator('.month-cell.in-range.is-weekend:not(.range-start):not(.range-end)').evaluate(cell => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(--calendar-weekend-selected-bg)'
    document.body.append(probe)
    const selected = getComputedStyle(probe).backgroundColor
    probe.style.backgroundColor = 'var(--calendar-weekend-bg)'
    const regular = getComputedStyle(probe).backgroundColor
    probe.remove()
    return { actual: getComputedStyle(cell).backgroundColor, selected, regular }
  })
  expect(weekendPaint.actual).toBe(weekendPaint.selected)
  expect(weekendPaint.actual).not.toBe(weekendPaint.regular)
})

test('周末作为框选头尾时比范围内的周末日期更突出', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.locator('.month-body')).toBeVisible()

  let friday: ReturnType<typeof page.locator> | null = null
  let saturday: ReturnType<typeof page.locator> | null = null
  let sunday: ReturnType<typeof page.locator> | null = null
  let monday: ReturnType<typeof page.locator> | null = null
  {
    // 周五到周一通常跨越两行，不能要求四天都在同一个 week-row。
    const cells = page.locator('.month-body .month-cell')
    const dates = await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-iso')))
    for (let dayIndex = 0; dayIndex <= dates.length - 4; dayIndex += 1) {
      const days = dates.slice(dayIndex, dayIndex + 4).map(date => date ? new Date(`${date}T00:00:00`).getDay() : -1)
      if (days[0] === 5 && days[1] === 6 && days[2] === 0 && days[3] === 1) {
        friday = cells.nth(dayIndex)
        saturday = cells.nth(dayIndex + 1)
        sunday = cells.nth(dayIndex + 2)
        monday = cells.nth(dayIndex + 3)
        break
      }
    }
  }

  expect(friday).not.toBeNull()
  expect(saturday).not.toBeNull()
  expect(sunday).not.toBeNull()
  expect(monday).not.toBeNull()

  const alpha = async (selector: string) => page.locator(selector).evaluate((element) => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建颜色验证画布')
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3]
  })

  for (const theme of ['light', 'dark']) {
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme
      document.documentElement.dataset.family = 'glass'
      document.documentElement.dataset.palette = 'mist'
    }, theme)

    for (const [startCell, endCell, edgeSelector] of [
      [saturday!, monday!, '.month-cell.range-start.is-weekend'],
      [friday!, sunday!, '.month-cell.range-end.is-weekend'],
    ] as const) {
      const startBox = await startCell.boundingBox()
      const endBox = await endCell.boundingBox()
      expect(startBox).not.toBeNull()
      expect(endBox).not.toBeNull()
      await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + 12)
      await page.mouse.down()
      await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + 12)
      await page.mouse.up()

      const edgeAlpha = await alpha(edgeSelector)
      const middleAlpha = await alpha('.month-cell.in-range.is-weekend:not(.range-start):not(.range-end)')
      expect(edgeAlpha, `${theme} 模式下周末范围边界应强于范围内周末`).toBeGreaterThan(middleAlpha)
    }
  }
})

test('框选范围头尾在亮暗主题中都比中段更突出', async ({ page }) => {
  await page.goto('/calendar')
  await expect(page.locator('.month-body')).toBeVisible()

  let monday: ReturnType<typeof page.locator> | null = null
  let wednesday: ReturnType<typeof page.locator> | null = null
  for (let weekIndex = 0; weekIndex < await page.locator('.week-row').count(); weekIndex += 1) {
    const cells = page.locator('.week-row').nth(weekIndex).locator('.month-cell')
    const dates = await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-iso')))
    for (let dayIndex = 0; dayIndex <= dates.length - 3; dayIndex += 1) {
      const startDate = dates[dayIndex]
      const middleDate = dates[dayIndex + 1]
      const endDate = dates[dayIndex + 2]
      if (!startDate || !middleDate || !endDate) continue
      if (
        new Date(`${startDate}T00:00:00`).getDay() === 1
        && new Date(`${middleDate}T00:00:00`).getDay() === 2
        && new Date(`${endDate}T00:00:00`).getDay() === 3
      ) {
        monday = cells.nth(dayIndex)
        wednesday = cells.nth(dayIndex + 2)
        break
      }
    }
    if (monday && wednesday) break
  }

  expect(monday).not.toBeNull()
  expect(wednesday).not.toBeNull()
  const startBox = await monday!.boundingBox()
  const endBox = await wednesday!.boundingBox()
  expect(startBox).not.toBeNull()
  expect(endBox).not.toBeNull()

  for (const theme of ['light', 'dark']) {
    await page.evaluate((selectedTheme) => {
      document.documentElement.dataset.theme = selectedTheme
      document.documentElement.dataset.family = 'glass'
      document.documentElement.dataset.palette = 'mist'
    }, theme)

    await page.mouse.move(startBox!.x + startBox!.width / 2, startBox!.y + 12)
    await page.mouse.down()
    await page.mouse.move(endBox!.x + endBox!.width / 2, endBox!.y + 12)
    await page.mouse.up()

    const alpha = async (selector: string) => page.locator(selector).evaluate((element) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建颜色验证画布')
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]
    })

    const startAlpha = await alpha('.month-cell.range-start')
    const middleAlpha = await alpha('.month-cell.in-range:not(.range-start):not(.range-end)')
    const endAlpha = await alpha('.month-cell.range-end')
    expect(startAlpha, `${theme} 模式的起始日期需强于中段`).toBeGreaterThan(middleAlpha)
    expect(endAlpha, `${theme} 模式的结束日期需强于中段`).toBeGreaterThan(middleAlpha)
  }
})

test('浮动活动编辑窗内选择日期不会被 Teleport 弹层误关', async ({ page }) => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const initialDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const title = `E2E 活动 ${Date.now()}`
  await page.goto('/calendar')
  const created = await page.evaluate(async ({ title: eventTitle, date }) => {
    const token = localStorage.getItem('user_token')
    const response = await fetch('/api/v1/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ title: eventTitle, date, type: 'event' }),
    })
    return { ok: response.ok, body: await response.json() }
  }, { title, date: initialDate })
  expect(created.ok).toBeTruthy()

  try {
    await page.reload()
    await expect(page.locator('.month-body')).toBeVisible()

    // 月格会按可用高度把活动收进「更多」弹层，不能用月格中的即时 DOM
    // 数量判断入口。侧栏在活动数据加载后始终展示当天活动，作为稳定入口。
    const sidebarEvent = page.locator('.sidebar-ev').filter({ hasText: title })
    await expect(sidebarEvent).toBeVisible({ timeout: 15000 })
    await sidebarEvent.click()

    const editModal = page.locator('.eem-popup')
    await expect(editModal).toBeVisible()
    await editModal.locator('.dp-input').click()
    await expect(page.locator('.dp-popup')).toBeVisible()

    const nextDay = page.locator('.dp-popup .dp-day:not(.other):not(.disabled):not(.selected)').first()
    const nextDayNumber = await nextDay.innerText()
    await nextDay.click()

    await expect(editModal).toBeVisible()
    await expect(editModal.locator('.dp-input')).toContainText(`${now.getMonth() + 1}/${Number(nextDayNumber)}`)
  } finally {
    await page.evaluate(async (eventId) => {
      const token = localStorage.getItem('user_token')
      await fetch(`/api/v1/events/${eventId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      })
    }, created.body.id)
  }
})
