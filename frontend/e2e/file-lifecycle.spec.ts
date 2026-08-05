import { test, expect } from '@playwright/test'

/**
 * CI 关键路径之一：文件库上传 → 卡片出现 → 删除。不依赖测试账号已有数据（个人
 * 文件目录为空也能跑），也不接 OSS——CI 用 STORAGE__BACKEND=local，上传直接落
 * 盘，流程和生产一致但不需要真实云凭证。
 */
test('文件库：上传文件出现卡片，删除后卡片消失', async ({ page }) => {
  await page.goto('/files')
  await expect(page.locator('.files-page')).toBeVisible()

  // 上传入口在「个人文件」目录内部，不在文件库顶层的文件夹卡片列表上。
  await page.locator('.folder-card', { hasText: '个人文件' }).first().click()
  await expect(page.locator('.file-browser-panel')).toBeVisible()

  const baseName = `e2e-${Date.now()}`   // 卡片只显示不带扩展名的文件名，扩展名单独渲染成图标角标
  await page.setInputFiles('.fub input[type="file"]', {
    name: `${baseName}.txt`,
    mimeType: 'text/plain',
    buffer: Buffer.from('gugu e2e smoke'),
  })

  const card = page.locator('.fc-card', { hasText: baseName })
  await expect(card).toBeVisible({ timeout: 15000 })

  await card.hover()
  await card.locator('.file-card-btn.del[title="移到回收站"]').click()

  await expect(page.locator('.fc-card', { hasText: baseName })).toHaveCount(0)
})
