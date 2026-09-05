import { test, expect, type Page } from '@playwright/test'

type MockTask = {
  id: number
  name: string
  payload: string
  cron: string
  channels: string[]
  enabled: boolean
}

async function mockScheduledTasks(page: Page) {
  let nextId = 1
  let tasks: MockTask[] = []

  await page.route('**/api/v1/scheduled-tasks**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const idMatch = url.pathname.match(/scheduled-tasks\/(\d+)$/)
    const id = idMatch ? Number(idMatch[1]) : null
    const body = request.postDataJSON?.() ?? {}

    if (request.method() === 'GET') {
      await route.fulfill({ json: { tasks } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/run')) {
      await route.fulfill({ json: { msg: '已发送' } })
      return
    }
    if (request.method() === 'POST') {
      const created = { id: nextId++, ...body }
      tasks.push(created)
      await route.fulfill({ status: 201, json: created })
      return
    }
    if (request.method() === 'PATCH' && id != null) {
      tasks = tasks.map(task => task.id === id ? { ...task, ...body } : task)
      await route.fulfill({ json: tasks.find(task => task.id === id) })
      return
    }
    if (request.method() === 'DELETE' && id != null) {
      tasks = tasks.filter(task => task.id !== id)
      await route.fulfill({ status: 204, body: '' })
      return
    }
    await route.continue()
  })
}

test('定时任务页面：空状态、新建、编辑、启停、试运行和删除', async ({ page }) => {
  await mockScheduledTasks(page)
  await page.goto('/schedules')
  await expect(page.locator('.empty-state')).toContainText('还没有定时任务')

  await page.getByRole('button', { name: '新建任务' }).click()
  await page.locator('.title-input').fill('自动化任务')
  await page.locator('.field textarea').fill('测试内容')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  const card = page.locator('.task-card', { hasText: '自动化任务' })
  await expect(card).toBeVisible()
  await expect(card.locator('.tc-window')).toContainText('开始 不限制')
  await expect(card.locator('.tc-window')).toContainText('结束 不限制')
  await card.getByRole('button', { name: '停用定时任务' }).click()
  await expect(card).toHaveClass(/off/)

  await card.getByRole('button', { name: '编辑' }).click()
  await expect(page.locator('.title-input')).toHaveValue('自动化任务')
  await page.locator('.title-input').fill('已编辑任务')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.task-card', { hasText: '已编辑任务' })).toBeVisible()

  const edited = page.locator('.task-card', { hasText: '已编辑任务' })
  await edited.getByRole('button', { name: '试运行' }).click()
  await expect(page.locator('.app-toast__message')).toContainText('已发送')

  await edited.getByRole('button', { name: '删除' }).click()
  await page.locator('.confirm-dialog-confirm').click()
  await expect(edited).toHaveCount(0)
})

test('定时任务页面：时间范围、间隔和渠道选项可切换', async ({ page }) => {
  await mockScheduledTasks(page)
  await page.route('**/api/v1/auth/me', async route => {
    await route.fulfill({ json: {
      id: 'e2e-user', username: 'e2e-user', email: 'e2e@example.invalid',
      isActive: true, createdAt: '2026-01-01T00:00:00Z', imChannels: [],
    } })
  })
  await page.goto('/schedules')
  await page.getByRole('button', { name: '新建任务' }).click()

  await expect(page.locator('[data-testid="schedule-start-boundary"]')).toBeVisible()
  await expect(page.locator('[data-testid="schedule-end-boundary"]')).toBeVisible()
  await page.getByRole('button', { name: '分钟' }).click()
  await expect(page.locator('.interval-presets')).toBeVisible()
  await page.getByRole('button', { name: '自定义', exact: true }).last().click()
  const interval = page.locator('input[type=number]')
  await expect(interval).toBeVisible()
  await interval.fill('15')
  await expect(page.locator('.chans .app-checkbox')).toHaveCount(2)
  await page.locator('.title-input').fill('间隔任务')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.task-card', { hasText: '间隔任务' })).toContainText('每 15 分钟')
})

test('定时任务页面：可以创建自定义单次任务', async ({ page }) => {
  await mockScheduledTasks(page)
  await page.route('**/api/v1/auth/me', async route => {
    await route.fulfill({ json: {
      id: 'e2e-user', username: 'e2e-user', email: 'e2e@example.invalid',
      isActive: true, createdAt: '2026-01-01T00:00:00Z', imChannels: [],
    } })
  })
  const createBodies: Record<string, unknown>[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/scheduled-tasks')) {
      createBodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })
  await page.goto('/schedules')
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByRole('button', { name: '单次', exact: true }).click()
  await expect(page.locator('[data-testid="schedule-once-boundary"]')).toBeVisible()
  await page.locator('.title-input').fill('单次任务')
  await page.locator('.field textarea').fill('单次执行内容')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  await expect(page.locator('.task-card', { hasText: '单次任务' })).toContainText('单次')
  expect(createBodies.at(-1)).toMatchObject({
    schedule_kind: 'once', cron: null, interval_minutes: null, end_at: null,
    start_at: expect.stringMatching(/T\d{2}:\d{2}:00$/),
  })
})

test('定时任务页面：精确窗口提交开始和结束边界', async ({ page }) => {
  await mockScheduledTasks(page)
  await page.route('**/api/v1/auth/me', async route => {
    await route.fulfill({ json: {
      id: 'e2e-user', username: 'e2e-user', email: 'e2e@example.invalid',
      isActive: true, createdAt: '2026-01-01T00:00:00Z', imChannels: [],
    } })
  })
  const createBodies: Record<string, unknown>[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/scheduled-tasks')) {
      createBodies.push(request.postDataJSON() as Record<string, unknown>)
    }
  })
  await page.goto('/schedules')
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.getByRole('button', { name: '分钟' }).click()
  await page.getByRole('button', { name: '10 分钟' }).click()

  const start = page.locator('[data-testid="schedule-start-boundary"]')
  await start.locator('.dp-input').click()
  await page.getByRole('button', { name: '今天' }).click()
  await start.locator('.time-part').nth(0).fill('18')
  await start.locator('.time-part').nth(1).fill('30')
  await start.getByRole('button', { name: '清除时间范围' }).click()
  await expect(start.locator('.boundary-clear')).toHaveCount(0)
  await start.locator('.dp-input').click()
  await page.getByRole('button', { name: '今天' }).click()
  await start.locator('.time-part').nth(0).fill('18')
  await start.locator('.time-part').nth(1).fill('30')

  const end = page.locator('[data-testid="schedule-end-boundary"]')
  await end.locator('.dp-input').click()
  await page.getByRole('button', { name: '今天' }).click()
  await end.locator('.time-part').nth(0).fill('19')
  await end.locator('.time-part').nth(1).fill('30')

  await page.locator('.title-input').fill('窗口任务')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.task-card', { hasText: '窗口任务' })).toBeVisible()
  expect(createBodies.at(-1)).toMatchObject({
    schedule_kind: 'interval', interval_minutes: 10,
    start_at: expect.stringMatching(/T18:30:00$/),
    end_at: expect.stringMatching(/T19:30:00$/),
  })
})
