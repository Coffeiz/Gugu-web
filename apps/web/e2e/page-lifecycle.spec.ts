import { test, expect, type Locator, type Page } from '@playwright/test'

/**
 * 用户页面的单向导航巡检：逐个挂载页面主视图，再切到下一个页面确认前一视图已卸载。
 * 保护页面懒加载失败、首屏卡在加载态以及路由切换后旧页面残留等用户可见回归。
 */
async function clickNav(page: Page, label: string) {
  const item = page.locator('.nav-item[role="link"]').filter({ hasText: label }).first()
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
}

async function assertTransition(previous: Locator, next: Locator) {
  await expect(next).toBeVisible({ timeout: 20000 })
  await expect(previous).toBeHidden({ timeout: 10000 })
}

test('主应用页面按导航顺序打开后可离开，不残留卡住的旧页面', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.goto('/projects')
  const projects = page.locator('.projects-page .kanban')
  await expect(projects).toBeVisible()

  await clickNav(page, '日历')
  const calendar = page.locator('.cal-page .cal-main')
  await assertTransition(projects, calendar)

  // /mind 默认恢复上次子视图；此用例固定从笔记页开始，再自然切到画布。
  await page.evaluate(() => localStorage.setItem('mind-last-mode', 'notes'))
  await clickNav(page, '思维')
  const notes = page.locator('.ntp-layout')
  await assertTransition(calendar, notes)
  await expect(notes.locator('.ntp-list-scroll')).toBeVisible()
  await expect(notes.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 20000 })

  await page.locator('.mind-tab[href="/mind/canvases"]').click()
  const canvas = page.locator('.canvas-page-canvas.canvas-page-canvas-ready')
  await assertTransition(notes, canvas)

  await clickNav(page, '定时任务')
  const schedules = page.locator('.sched-page')
  await assertTransition(canvas, schedules)
  await expect(schedules.getByRole('button', { name: '新建任务' })).toBeVisible()
  await expect(schedules.locator('.task-grid, .scrollable-card-layout__empty')).toBeVisible({ timeout: 20000 })

  await clickNav(page, '文件库')
  const files = page.locator('.files-page .files-main')
  await assertTransition(schedules, files)

  // 终端同样受运行时能力控制；若启用，沿侧栏顺序检查打开与离开。
  const terminalNav = page.locator('.nav-item[role="link"]').filter({ hasText: '终端' }).first()
  let currentPage = files
  if (await terminalNav.isVisible().catch(() => false)) {
    await terminalNav.click()
    const terminals = page.locator('.terminals-page')
    await assertTransition(files, terminals)
    await expect(terminals.locator('.terminal-empty[role="status"]')).toBeHidden({ timeout: 20000 })
    await expect(terminals.locator('.terminal-layout, .terminal-empty, .terminal-page-error').first()).toBeVisible({ timeout: 20000 })
    currentPage = terminals
  }

  const skillsResponse = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname.endsWith('/api/v1/skills') && url.searchParams.get('include_tools') === 'false'
  })
  await clickNav(page, '技能')
  const skills = page.locator('.skills-page .skills-home')
  await assertTransition(currentPage, skills)
  expect((await skillsResponse).status()).toBeLessThan(500)
  await expect(skills.locator('.skill-group, .scrollable-card-layout__empty, .error-banner').first()).toBeVisible({ timeout: 20000 })
  await expect.poll(async () => {
    const emptyState = skills.locator('.scrollable-card-layout__empty')
    return !(await emptyState.count()) || !(await emptyState.innerText()).includes('正在加载技能')
  }).toBe(true)

  // MCP 是否开放由用户配置决定；开放时检查页面能挂载并能继续离开。
  const mcpNav = page.locator('.nav-item[role="link"]').filter({ hasText: 'MCP' }).first()
  if (await mcpNav.isVisible().catch(() => false)) {
    await mcpNav.click()
    const mcp = page.locator('.mcp-route-page')
    await assertTransition(skills, mcp)
    await expect(mcp.getByRole('button', { name: '添加服务' })).toBeVisible()
  }

  expect(pageErrors).toEqual([])
})
