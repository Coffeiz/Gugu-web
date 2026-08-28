import { test, expect } from '@playwright/test'

const createdTaskNames = new Set<string>()

test.afterEach(async ({ page }) => {
  const names = [...createdTaskNames]
  createdTaskNames.clear()
  if (!names.length) return
  await page.evaluate(async (targetNames) => {
    const token = localStorage.getItem('user_token')
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const response = await fetch('/api/v1/scheduled-tasks', { headers })
    if (!response.ok) return
    const data = await response.json()
    for (const task of (data.tasks ?? []).filter((item: { name?: string }) => targetNames.includes(item.name ?? ''))) {
      await fetch(`/api/v1/scheduled-tasks/${task.id}`, { method: 'DELETE', headers })
    }
  }, names)
})

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
  createdTaskNames.add(taskName)
  await page.getByRole('button', { name: '新建任务' }).click()
  await page.locator('.title-input').fill(taskName)
  await page.locator('.field textarea').fill('e2e 冒烟：不需要真实产出')
  await page.getByRole('button', { name: '创建', exact: true }).click()

  const card = page.locator('.task-card', { hasText: taskName })
  await expect(card).toBeVisible()

  await card.getByRole('button', { name: '试运行' }).click()

  const toast = page.locator('.app-toast__message')
  await expect(toast).toContainText('已发送', { timeout: 20000 })
})
