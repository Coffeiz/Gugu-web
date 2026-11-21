import { test, expect } from '@playwright/test'

test('交互式终端可以创建、连接、输入并删除', async ({ page }) => {
  await page.goto('/')
  const terminalId = await page.evaluate(async () => {
    const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
    const response = await fetch('/api/v1/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
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
    await expect(terminal.locator('.xterm-rows')).toContainText('gugu-sandbox:/workspace/', { timeout: 15000 })

    await terminal.click()
    const outputMarker = `e2e-pty-${Date.now()}`
    const escapedMarker = [...outputMarker]
      .map(char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
      .join('')
    // Keep the expected output out of the echoed command itself so this verifies
    // command execution, not only that keyboard events reached xterm.
    await page.keyboard.type(`printf '${escapedMarker}\\n'`)
    await page.keyboard.press('Enter')
    await expect(terminal.locator('.xterm-rows')).toContainText(outputMarker, { timeout: 10000 })
    await expect(page.locator('.terminal-page-error, .terminal-output-error')).toHaveCount(0)

    await page.getByRole('button', { name: '删除' }).click()
    await page.locator('.confirm-dialog-confirm').click()
    await expect(page.locator('.terminal-delete-action')).toHaveCount(0)
  } finally {
    await page.evaluate(async (id) => {
      const csrfToken = decodeURIComponent(document.cookie.split('; ').find(item => item.startsWith('gugu_user_csrf_token='))?.split('=').slice(1).join('=') ?? '')
      await fetch(`/api/v1/terminals/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'X-CSRF-Token': csrfToken },
      })
    }, terminalId)
  }
})
