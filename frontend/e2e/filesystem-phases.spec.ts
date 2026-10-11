import { test, expect, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

const fixtureFiles = new Set<string>()
const fixtureFolders = new Set<string>()
const fixtureProjects = new Set<number>()

async function cleanupFixtures(page: Page) {
  const names = [...fixtureFiles]
  const folderNames = [...fixtureFolders]
  const projectIds = [...fixtureProjects]
  fixtureFiles.clear()
  fixtureFolders.clear()
  fixtureProjects.clear()
  await page.evaluate(async ({ names, folderNames, projectIds }) => {
    const token = localStorage.getItem('user_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    if (names.length) {
      const files = await fetch('/api/v1/files/all', { headers }).then(response => response.ok ? response.json() : [])
      for (const file of files.filter((item: { displayName?: string }) => names.includes(item.displayName))) {
        await fetch(`/api/v1/files/${file.id}`, { method: 'DELETE', headers })
      }
    }
    if (folderNames.length) {
      const folders = await fetch('/api/v1/folders/all', { headers }).then(response => response.ok ? response.json() : [])
      for (const folder of folders.filter((item: { name?: string }) => folderNames.includes(item.name))) {
        await fetch(`/api/v1/folders/${folder.id}`, { method: 'DELETE', headers })
      }
    }
    for (const id of projectIds) {
      await fetch(`/api/v1/projects/${id}`, { method: 'DELETE', headers })
    }
  }, { names, folderNames, projectIds })
}

test.afterEach(async ({ page }) => cleanupFixtures(page))

async function openFiles(page: Page) {
  await page.goto('/files')
  await expect(page.locator('.files-page')).toBeVisible()
  await expect(page.locator('.files-toolbar')).toBeVisible()
  await expect(page.locator('.files-main')).toBeVisible()
}

async function openPersonalDirectory(page: Page) {
  await openFiles(page)
  const personal = page.locator('.folder-card').filter({ hasText: '个人文件' }).first()
  await expect(personal).toBeVisible()
  await personal.click()
  await expect(page.locator('.select-mode-btn')).toBeVisible()
  const gridButton = page.getByTitle('网格视图')
  if (await gridButton.count() > 0) await gridButton.click()
  await expect(page.locator('.file-browser-grid')).toBeVisible()
}

async function openFixtureDirectory(page: Page) {
  await openPersonalDirectory(page)
  const name = `e2e-phase-folder-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const root = page.locator('.files-page')
  await root.locator('button', { hasText: '新建文件夹' }).click()
  await root.locator('.new-folder-input').fill(name)
  await root.getByRole('button', { name: '确定' }).click()
  const folder = root.locator('.folder-card', { hasText: name })
  await expect(folder).toBeVisible()
  fixtureFolders.add(name)
  await folder.click()
  await expect(root.locator('.bc-item.active, .bc-cur', { hasText: name })).toBeVisible()
  return name
}

async function uploadFixtureFile(page: Page) {
  const name = `e2e-phase-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await page.setInputFiles('.fub input[type="file"]', {
    name: `${name}.txt`, mimeType: 'text/plain', buffer: Buffer.from('filesystem phase fixture'),
  })
  await expect(page.locator('.fc-card', { hasText: name })).toBeVisible({ timeout: 15000 })
  fixtureFiles.add(name)
  return name
}

async function createProjectFixture(page: Page) {
  const name = `e2e-phase-project-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const id = await page.evaluate(async projectName => {
    const token = localStorage.getItem('user_token')
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name: projectName }),
    })
    if (!response.ok) throw new Error(`创建 E2E 项目失败：${response.status}`)
    return (await response.json()).id as number
  }, name)
  fixtureProjects.add(id)
  await page.reload()
  const project = page.locator('.proj-card').filter({ hasText: name })
  await expect(project).toBeVisible()
  await project.click()
  return name
}

test.describe('文件浏览阶段 2–4 冒烟', () => {
  test('阶段 2：目录进入后可以开启统一选择模式并退出', async ({ page }) => {
    await openFixtureDirectory(page)
    const name = await uploadFixtureFile(page)
    await page.locator('.select-mode-btn').click()
    await expect(page.locator('.select-mode-btn.on')).toBeVisible()
    const file = page.locator('.fc-card', { hasText: name })
    await file.click()
    await expect(file).toHaveClass(/selected/)
    await page.locator('.files-main').click({ position: { x: 8, y: 8 } })
    await expect(page.locator('.fc-card.selected, .folder-card.selected')).toHaveCount(0)
  })

  test('阶段 2：连续 Shift 选择保持第一次点击的范围锚点', async ({ page }) => {
    await openFixtureDirectory(page)
    const names: string[] = []
    for (let index = 0; index < 8; index += 1) names.push(await uploadFixtureFile(page))
    const files = page.locator('.fc-card')
    await page.locator('.select-mode-btn').click()
    await files.filter({ hasText: names[0] }).click()
    await files.filter({ hasText: names[4] }).click({ modifiers: ['Shift'] })
    await files.filter({ hasText: names[7] }).click({ modifiers: ['Shift'] })
    await expect(page.locator('.fc-card.selected')).toHaveCount(8)
  })

  test('阶段 2：批量选择工具栏统一暴露下载、剪切、复制和删除', async ({ page }) => {
    await openFixtureDirectory(page)
    const name = await uploadFixtureFile(page)
    await page.locator('.select-mode-btn').click()
    await page.locator('.fc-card', { hasText: name }).click()
    const toolbar = page.locator('.file-selection-toolbar')
    await expect(toolbar).toBeVisible()
    await expect(toolbar).toContainText('已选 1 项')
    for (const label of ['下载', '剪切', '复制', '删除', '取消']) {
      await expect(toolbar.getByRole('button', { name: label })).toBeVisible()
    }
    await toolbar.getByRole('button', { name: '取消' }).click()
    await expect(toolbar).toHaveCount(0)
  })

  test('阶段 3：文件操作边界通过右键复制入口可达', async ({ page }) => {
    await openFixtureDirectory(page)
    const name = await uploadFixtureFile(page)
    await page.locator('.fc-card', { hasText: name }).click({ button: 'right' })
    const copy = page.locator('.popup-menu-item').filter({ hasText: '复制' }).first()
    await expect(copy).toBeVisible()
    await copy.click()
    await expect(page.locator('.file-paste-button')).toBeVisible()
  })

  test('阶段 4：上传入口与空白区域右键菜单使用共享组件', async ({ page }) => {
    await openFixtureDirectory(page)
    await expect(page.locator('.fub.grid, .fub.list').first()).toBeVisible()
    await page.locator('.files-main').click({ button: 'right', position: { x: 12, y: 12 } })
    await expect(page.locator('.popup-menu')).toBeVisible()
    await expect(page.locator('.popup-menu-item').first()).toBeVisible()
  })

  test('文件库回收站保留场景扩展且仍由通用面板承载工具栏', async ({ page }) => {
    await openFiles(page)
    const trash = page.locator('.folder-card').filter({ hasText: '回收站' }).first()
    await expect(trash).toBeVisible()
    await trash.click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    await expect(page.locator('.empty-trash-btn')).toBeVisible()
  })

  test('项目文件区使用通用面板并保留项目工具栏适配层', async ({ page }) => {
    await page.goto('/projects')
    await createProjectFixture(page)
    await expect(page.locator('.project-modal-root')).toBeVisible()
    await expect(page.locator('.project-modal-root .file-browser-panel')).toBeVisible()
    await expect(page.locator('.project-modal-root .file-browser-toolbar')).toBeVisible()
  })

  test('窄窗口下文件浏览面板不产生横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await openFiles(page)
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.documentElement.clientWidth,
      panel: document.querySelector<HTMLElement>('.file-browser-panel')?.getBoundingClientRect(),
    }))
    expect(overflow.body).toBeLessThanOrEqual(1)
    expect(overflow.panel).toBeTruthy()
    expect(overflow.panel!.right).toBeLessThanOrEqual(900 + 1)
  })
})
