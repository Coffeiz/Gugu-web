import { test, expect } from '@playwright/test'

test('交互式终端可以创建、连接、输入并删除', async ({ page }) => {
  const terminalId = await page.evaluate(async () => {
    const token = localStorage.getItem('user_token')
    const response = await fetch('/api/v1/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
      body: JSON.stringify({ name: `E2E 终端 ${Date.now()}`, mode: 'interactive-pty' }),
    })
    if (!response.ok) throw new Error(`创建终端失败：${response.status}`)
    return (await response.json()).id as string
  })

  try {
    await page.goto(`/terminals?terminalId=${encodeURIComponent(terminalId)}`)
    await expect(page.locator('.terminals-page')).toBeVisible()
    const terminal = page.locator('.pty-terminal-shell')
    await expect(terminal).toBeVisible({ timeout: 15000 })
    await expect(terminal).not.toHaveClass(/is-disconnected/, { timeout: 15000 })

    await terminal.click()
    await page.keyboard.type('printf e2e-pty')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await expect(page.locator('.terminal-page-error, .terminal-output-error')).toHaveCount(0)

    await page.getByRole('button', { name: '删除' }).click()
    await page.locator('.confirm-dialog-confirm').click()
    await expect(page.locator('.terminal-delete-action')).toHaveCount(0)
  } finally {
    await page.evaluate(async (id) => {
      const token = localStorage.getItem('user_token')
      await fetch(`/api/v1/terminals/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token ?? ''}` },
      })
    }, terminalId)
  }
})
