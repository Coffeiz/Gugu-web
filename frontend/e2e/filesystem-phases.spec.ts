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
})
