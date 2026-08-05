import { test, expect, type Page } from '@playwright/test'

async function openFiles(page: Page) {
  await page.goto('/files')
  await expect(page.locator('.files-page')).toBeVisible()
  await expect(page.locator('.files-toolbar')).toBeVisible()
  await expect(page.locator('.files-main')).toBeVisible()
}

async function openPersonalDirectory(page: Page) {
  await openFiles(page)
  const personal = page.locator('.folder-card').filter({ hasText: '个人文件' }).first()
  if (await personal.count() === 0) return false
  await personal.click()
  await expect(page.locator('.select-mode-btn')).toBeVisible()
  // 视图模式会持久化到测试账号；阶段 2–4 需要验证网格共享卡片，先显式切到网格。
  const gridButton = page.getByTitle('网格视图')
  if (await gridButton.count() > 0) await gridButton.click()
  await expect(page.locator('.file-browser-grid')).toBeVisible()
  return true
}

test.describe('文件浏览阶段 1–4 冒烟', () => {
  test('阶段 1：共享展示层挂载文件库浏览壳', async ({ page }) => {
    await openFiles(page)
    await expect(page.locator('.breadcrumb')).toBeVisible()
    await expect(page.locator('.file-browser-grid, .file-browser-list, .grid-empty, .file-list').first()).toBeVisible()
    await expect(page.locator('.fc-card, .folder-card, .fub, .grid-empty, .file-list').first()).toBeVisible()
  })

  test('阶段 2：目录进入后可以开启统一选择模式并退出', async ({ page }) => {
    test.skip(!(await openPersonalDirectory(page)), '测试账号没有个人文件目录')
    await page.locator('.select-mode-btn').click()
    await expect(page.locator('.select-mode-btn.on')).toBeVisible()

    const cards = page.locator('.fc-card, .folder-card')
    const count = await cards.count()
    test.skip(count === 0, '个人文件目录为空')
    await cards.first().click()
    await expect(page.locator('.fc-card.selected, .folder-card.selected').first()).toBeVisible()

    await page.locator('.files-main').click({ position: { x: 8, y: 8 } })
    await expect(page.locator('.fc-card.selected, .folder-card.selected')).toHaveCount(0)
  })

  test('阶段 2：连续 Shift 选择保持第一次点击的范围锚点', async ({ page }) => {
    test.skip(!(await openPersonalDirectory(page)), '测试账号没有个人文件目录')
    const files = page.locator('.fc-card')
    const count = await files.count()
    test.skip(count < 8, '个人文件数量不足以验证连续 Shift 范围选择')

    await page.locator('.select-mode-btn').click()
    await files.nth(0).click()
    await files.nth(4).click({ modifiers: ['Shift'] })
    await files.nth(7).click({ modifiers: ['Shift'] })

    await expect(page.locator('.fc-card.selected')).toHaveCount(8)
  })

  test('阶段 2：批量选择工具栏统一暴露下载、剪切、复制和删除', async ({ page }) => {
    test.skip(!(await openPersonalDirectory(page)), '测试账号没有个人文件目录')
    const file = page.locator('.fc-card').first()
    test.skip(await file.count() === 0, '个人文件目录没有文件卡片')

    await page.locator('.select-mode-btn').click()
    await file.click()
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
    test.skip(!(await openPersonalDirectory(page)), '测试账号没有个人文件目录')
    const file = page.locator('.fc-card').first()
    test.skip(await file.count() === 0, '个人文件目录没有文件卡片')

    await file.click({ button: 'right' })
    const copy = page.locator('.popup-menu-item').filter({ hasText: '复制' }).first()
    await expect(copy).toBeVisible()
    await copy.click()
    await expect(page.locator('.file-paste-button')).toBeVisible()
  })

  test('阶段 4：上传入口与空白区域右键菜单使用共享组件', async ({ page }) => {
    test.skip(!(await openPersonalDirectory(page)), '测试账号没有个人文件目录')
    await expect(page.locator('.fub.grid, .fub.list').first()).toBeVisible()

    await page.locator('.file-browser-grid').click({ button: 'right', position: { x: 12, y: 12 } })
    await expect(page.locator('.popup-menu')).toBeVisible()
    await expect(page.locator('.popup-menu-item').first()).toBeVisible()
  })

  test('文件库回收站保留场景扩展且仍由通用面板承载工具栏', async ({ page }) => {
    await openFiles(page)
    const trash = page.locator('.folder-card').filter({ hasText: '回收站' }).first()
    test.skip(await trash.count() === 0, '测试账号没有回收站入口')
    await trash.click()
    await expect(page.locator('.file-browser-panel')).toBeVisible()
    await expect(page.locator('.empty-trash-btn')).toBeVisible()
  })

  test('项目文件区使用通用面板并保留项目工具栏适配层', async ({ page }) => {
    await page.goto('/projects')
    const project = page.locator('.proj-card').first()
    test.skip(await project.count() === 0, '测试账号没有项目卡片')
    await project.click()
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
