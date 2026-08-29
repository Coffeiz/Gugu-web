import { test, expect, type Locator } from '@playwright/test'

/**
 * Mind 画布 Runtime 接入的只读 smoke 覆盖。
 *
 * 这条用例刻意不新建画布、便签或关系：画布入口会负责确保当前账号有可用画布，
 * 测试只验证真实页面的 Surface、抽屉生命周期和相机控制，避免长期运行的共享账号
 * 被 E2E 留下业务数据。
 */
test('画布首屏、项目抽屉和相机控制可用', async ({ page }) => {
  await page.goto('/mind/canvases')

  await expect(page.locator('.canvas-page-canvas-ready')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.mind-canvas')).toBeVisible()
  // 项目抽屉默认收起；先确认 Runtime Surface 已挂载，再通过真实入口打开。
  await expect(page.locator('[data-layout-surface="mind:project-drawer"]')).toBeAttached()

  const toolbar = page.locator('.canvas-toolbar')
  const zoomLabel = toolbar.locator('button[title="恢复 100%"]')
  await zoomLabel.click()
  await expect(zoomLabel).toHaveText('100%')

  await toolbar.getByRole('button', { name: '放大' }).click()
  await expect(zoomLabel).toHaveText('112%')
  await toolbar.getByRole('button', { name: '缩小' }).click()
  await expect(zoomLabel).toHaveText('100%')

  const projectViewport = page.locator('[data-layout-surface="mind:project-drawer"]')
  await page.getByRole('button', { name: '项目素材' }).click()
  await expect(projectViewport.locator('.projects-panel.visible')).toBeVisible()
  await expect(page.getByRole('button', { name: '收起' })).toBeVisible()
  await page.getByRole('button', { name: '收起' }).click()
  await expect(page.getByRole('button', { name: '项目素材' })).toBeVisible()
  await page.getByRole('button', { name: '项目素材' }).click()
  await expect(projectViewport.locator('.projects-panel.visible')).toBeVisible()
})

type ChromeStyle = {
  background: string
  border: string
  backdrop: string
}

async function readChromeStyle(locator: Locator): Promise<ChromeStyle> {
  return locator.evaluate((el: Element) => {
    const style = getComputedStyle(el)
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      // Chromium（当前 E2E 项目）支持标准 backdropFilter；只读标准属性可避免
      // 测试本身依赖浏览器私有 CSSStyleDeclaration 扩展。
      backdrop: style.backdropFilter || 'none',
    }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Mono ${theme} 画布抽屉与工具栏保持毛玻璃且 hover 不回退`, async ({ page }) => {
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('gugu-theme-family', 'mono')
      localStorage.setItem('gugu-theme', theme)
    }, { theme })

    await page.goto('/mind/canvases')
    await expect(page.locator('.canvas-page-canvas-ready')).toBeVisible({ timeout: 15000 })

    const toolbar = page.locator('.canvas-toolbar')
    const topCapsule = page.locator('.mind-tabs')
    // 真正的毛玻璃 paint 在 DrawerShell 根节点；data-layout-surface 挂在内部 viewport，
    // 后者只负责布局/命中，拿它读 computed style 会产生“没有 blur”的假阴性。
    const drawer = page.locator('.canvas-drawer')
    const projectViewport = page.locator('[data-layout-surface="mind:project-drawer"]')

    await expect(toolbar).toBeVisible()
    await expect(topCapsule).toBeVisible()
    await page.getByRole('button', { name: '项目素材' }).click()
    await expect(projectViewport.locator('.projects-panel.visible')).toBeVisible()
    await expect(drawer).toBeVisible()

    const toolbarBefore = await readChromeStyle(toolbar)
    const drawerBefore = await readChromeStyle(drawer)
    const capsuleStyle = await readChromeStyle(topCapsule)

    for (const style of [toolbarBefore, drawerBefore]) {
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(style.border).not.toBe('rgba(0, 0, 0, 0)')
      expect(style.backdrop).not.toBe('none')
      expect(style.backdrop).toBe(capsuleStyle.backdrop)
    }

    await toolbar.hover()
    expect(await readChromeStyle(toolbar)).toEqual(toolbarBefore)

    await drawer.hover()
    expect(await readChromeStyle(drawer)).toEqual(drawerBefore)
  })
}
