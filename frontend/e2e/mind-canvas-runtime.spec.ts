import { test, expect } from '@playwright/test'

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
  await expect(page.locator('[data-layout-surface="mind:project-drawer"]')).toBeVisible()

  const toolbar = page.locator('.canvas-toolbar')
  const zoomLabel = toolbar.locator('button[title="恢复 100%"]')
  await zoomLabel.click()
  await expect(zoomLabel).toHaveText('100%')

  await toolbar.getByRole('button', { name: '放大' }).click()
  await expect(zoomLabel).toHaveText('112%')
  await toolbar.getByRole('button', { name: '缩小' }).click()
  await expect(zoomLabel).toHaveText('100%')

  const drawer = page.locator('[data-layout-surface="mind:project-drawer"]')
  await page.getByRole('button', { name: '项目素材' }).click()
  await expect(drawer.locator('.projects-panel.visible')).toBeVisible()
  await expect(page.getByRole('button', { name: '收起' })).toBeVisible()
  await page.getByRole('button', { name: '收起' }).click()
  await expect(page.getByRole('button', { name: '项目素材' })).toBeVisible()
  await page.getByRole('button', { name: '项目素材' }).click()
  await expect(drawer.locator('.projects-panel.visible')).toBeVisible()
})
