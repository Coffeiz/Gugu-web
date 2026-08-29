import { test, expect } from '@playwright/test'

/**
 * CI 关键路径之二：定时任务创建 → 立即运行 → 得到确定性的成功结果。
 *
 * 只选 web 通知渠道（不依赖任何 IM 平台绑定），后端 AI__BASE_URL 在 CI 里指向
 * scripts/mock_llm_server.py（固定文本、不产生 tool_calls），因此结果必然是
 * 「web 通知：已发送」，不会因为真实模型的不确定性/限流导致这条测试偶发失败。
 */
test('定时任务：创建后立即运行，展示确定的成功结果', async ({ page }) => {
  await page.goto('/schedules')
  await expect(page.locator('.sched-page')).toBeVisible()

  const taskName = `e2e-task-${Date.now()}`
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.locator('.title-input').fill(taskName)
  await page.locator('.field textarea').fill('e2e 冒烟：不需要真实产出')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  const card = page.locator('.task-card', { hasText: taskName })
  await expect(card).toBeVisible()

  await card.getByRole('button', { name: '试运行' }).click()

  const toast = page.locator('.app-toast__message')
  await expect(toast).toContainText('已发送', { timeout: 20000 })
  // 不清理：CI 每轮都是全新数据库，且 removeTask() 走原生 window.confirm()，
  // Playwright 默认会自动 dismiss 它，硬点删除反而会造成误导性的"删除失败"噪音。
})
