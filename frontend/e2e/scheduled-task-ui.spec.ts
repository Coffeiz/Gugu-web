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

test('定时任务页面：自定义日期、间隔和渠道选项可切换', async ({ page }) => {
  await mockScheduledTasks(page)
  await page.route('**/api/v1/auth/me', async route => {
    await route.fulfill({ json: {
      id: 'e2e-user', username: 'e2e-user', email: 'e2e@example.invalid',
      isActive: true, createdAt: '2026-01-01T00:00:00Z', imChannels: [],
    } })
  })
  await page.goto('/schedules')
  await page.getByRole('button', { name: '新建任务' }).click()

  await page.getByRole('button', { name: '自定义' }).click()
  await expect(page.locator('.date-range')).toBeVisible()
  await page.getByRole('button', { name: '分钟' }).click()
  await expect(page.locator('.interval-presets')).toBeVisible()
  await page.getByRole('button', { name: '自定义', exact: true }).last().click()
  const interval = page.locator('input[type=number]')
  await expect(interval).toBeVisible()
  await interval.fill('15')
  await expect(page.locator('.app-checkbox')).toHaveCount(1)
  await page.locator('.title-input').fill('间隔任务')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.task-card', { hasText: '间隔任务' })).toContainText('每 15 分钟')
})
