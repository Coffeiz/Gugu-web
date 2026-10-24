import { test, expect } from '@playwright/test'

test('全局搜索便签：冷启动和重复热跳转都能打开首屏外目标', async ({ page }) => {
  test.setTimeout(90000)

  const noteId = 987654321
  const targetNote = {
    id: noteId,
    kind: 'note',
    title: null,
    contentMd: '# E2E 搜索目标便签\n目标正文',
    color: null,
    capturedAt: '2020-01-02T03:04:00Z',
    version: 1,
    createdAt: '2020-01-02T03:04:00Z',
    updatedAt: '2020-01-02T03:04:00Z',
  }
  let directReads = 0
  let listRequestSettled = false
  let releaseListRequest!: () => void
  const listRequestGate = new Promise<void>(resolve => { releaseListRequest = resolve })
  const listNotesCalls: number[] = []
  const noteRequestPaths: string[] = []
  page.on('request', request => {
    if (request.url().includes('/api/v1/mind/notes')) noteRequestPaths.push(new URL(request.url()).pathname)
  })

  await page.route(/\/api\/v1\/search(?:\?|$)/, async route => {
    await route.fulfill({ json: {
      groups: [{
        type: 'note',
        label: '便签',
        items: [{ id: noteId, title: 'E2E 搜索目标便签', subtitle: '目标正文' }],
      }],
      total: 1,
    } })
  })
  await page.route(/\/api\/v1\/mind\/notes(?:\?|$)/, async route => {
    listNotesCalls.push(Date.now())
    // 暂停时间流首屏请求，直接证明目标 ID 可以先完成定位。
    await listRequestGate
    listRequestSettled = true
    await route.fulfill({ json: [] })
  })
  await page.route(new RegExp(`/api/v1/mind/notes/${noteId}$`), async route => {
    directReads += 1
    await route.fulfill({ json: targetNote })
  })

  await page.goto('/projects')
  const search = page.getByPlaceholder('搜索项目、文件、日程、联系人…')
  await expect(search).toBeVisible()

  async function searchAndOpen() {
    await search.fill(`note-${Date.now()}`)
    const result = page.getByRole('button', { name: /E2E 搜索目标便签/ })
    await expect(result).toBeVisible()
    const startedAt = Date.now()
    await result.click()
    await expect(page.locator(`.ntp-item[data-note-id="${noteId}"].selected`)).toBeVisible()
    return Date.now() - startedAt
  }

  let coldNavigationMs = 0
  try {
    try {
      coldNavigationMs = await searchAndOpen()
    } catch (error) {
      console.log(`[SEARCH3 E2E diagnostic] url=${page.url()} direct_reads=${directReads} list_calls=${listNotesCalls.length} note_paths=${JSON.stringify(noteRequestPaths)}`)
      throw error
    }
    expect(page.url()).toContain('/mind/notes')
    expect(directReads).toBe(1)
    expect(listNotesCalls.length).toBeGreaterThan(0)
    expect(listRequestSettled).toBe(false)
  } finally {
    // 即使断言失败也释放路由，避免遗留挂起请求。
    releaseListRequest()
  }
  // 确认目标先打开，再让慢首屏请求结束。
  await expect.poll(() => listRequestSettled).toBe(true)

  // 浏览器返回保留 SPA 中的目标便签；再次用搜索打开同一实体，覆盖页面未卸载时的重复跳转。
  await page.goBack()
  await expect(page).toHaveURL(/\/projects$/)
  const warmNavigationMs = await searchAndOpen()
  expect(page.locator(`.ntp-item[data-note-id="${noteId}"]`)).toHaveClass(/selected/)
  expect(directReads).toBe(1)
  expect(listNotesCalls.length).toBeGreaterThan(0)

  console.log(`[SEARCH3 E2E] note cold=${coldNavigationMs}ms warm=${warmNavigationMs}ms direct_reads=${directReads}`)
})

test('全局搜索定时任务：用目标 ID 打开编辑弹窗并消费路由参数', async ({ page }) => {
  const taskId = 987654322
  await page.route(/\/api\/v1\/search(?:\?|$)/, async route => {
    await route.fulfill({ json: {
      groups: [{
        type: 'scheduled_task',
        label: '定时任务',
        items: [{ id: taskId, title: 'E2E 定时任务目标' }],
      }],
      total: 1,
    } })
  })
  await page.route(/\/api\/v1\/scheduled-tasks(?:\?|$)/, async route => {
    await route.fulfill({ json: { tasks: [{
      id: taskId,
      name: 'E2E 定时任务目标',
      payload: 'E2E 提醒正文',
      cron: '0 9 * * *',
      schedule_kind: 'cron',
      channels: ['web'],
      enabled: true,
    }] } })
  })

  await page.goto('/projects')
  const search = page.getByPlaceholder('搜索项目、文件、日程、联系人…')
  await expect(search).toBeVisible()
  await search.fill('e2e-scheduled-task')
  await page.getByRole('button', { name: /E2E 定时任务目标/ }).click()

  await expect(page).toHaveURL(/\/schedules(?:\?.*)?$/)
  await expect(page.locator('.title-input')).toHaveValue('E2E 定时任务目标')
  await expect.poll(() => new URL(page.url()).searchParams.has('object_id')).toBe(false)
})
