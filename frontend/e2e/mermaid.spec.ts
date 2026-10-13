import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('浏览器真实渲染 Mermaid，在窄屏预览并导出有效 PNG', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await page.evaluate(async () => {
    const { renderMarkdownMermaid } = await import('/src/utils/mermaidRenderer.ts')
    const root = document.createElement('main')
    root.id = 'mermaid-e2e-fixture'
    root.innerHTML = '<pre class="md-mermaid-source"><code>graph LR\n  A[Start] --&gt; B[Finish]</code></pre>'
    document.body.append(root)
    await renderMarkdownMermaid(root, {
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
      resetZoom: 'Reset zoom',
      expand: 'Expand',
      downloadPng: 'Download PNG',
      close: 'Close',
      previewTitle: 'Diagram preview',
      downloadFailed: 'Download failed',
      pngTooLarge: 'Diagram too large',
      renderFailed: 'Render failed',
    })
  })

  const chart = page.locator('#mermaid-e2e-fixture .md-mermaid')
  await expect(chart).toHaveClass(/md-mermaid-ready/)
  await expect(chart.locator('svg')).toBeVisible()
  await expect(chart.locator('svg')).toContainText('Start')
  await expect(chart.locator('svg')).toContainText('Finish')

  const expand = chart.getByRole('button', { name: 'Expand' })
  await expand.focus()
  await expand.click()

  const dialog = page.getByRole('dialog', { name: 'Diagram preview' })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)

  const downloadPromise = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Download PNG' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^mermaid-diagram-.*\.png$/)
  const path = await download.path()
  expect(path).not.toBeNull()
  const png = await readFile(path!)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(png.byteLength).toBeGreaterThan(100)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(expand).toBeFocused()

  await page.evaluate(async () => {
    const { cleanupMarkdownMermaid } = await import('/src/utils/mermaidRenderer.ts')
    const root = document.querySelector<HTMLElement>('#mermaid-e2e-fixture')
    cleanupMarkdownMermaid(root)
    root?.remove()
  })
})
