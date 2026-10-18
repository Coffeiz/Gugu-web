import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'

test('Mermaid 不同折线路由统一圆角端点和标准箭头，同时保留平滑曲线', async ({ page }) => {
  await page.goto('/', { waitUntil: 'commit' })

  const rendered = await page.evaluate(async () => {
    const { renderMermaidSvg } = await import('/src/utils/mermaidRenderer.ts')
    const newline = String.fromCharCode(10)
    const smooth = await renderMermaidSvg('flowchart TB; A[消息] --> B[读取]; A --> C[判断]; C --> D[结果]')
    const orthogonal = await renderMermaidSvg(
      `%%{init: {"flowchart": {"curve": "step"}}}%%${newline}flowchart TB; A[消息] -->|查询| B[读取]; A --> C[判断]; C --> D[结果]`,
    )
    const semantic = await renderMermaidSvg('flowchart LR; A --o B; A --x C')
    const host = document.createElement('div')
    host.id = 'mermaid-style-contract'
    host.innerHTML = `<section data-diagram="smooth">${smooth}</section><section data-diagram="orthogonal">${orthogonal}</section><section data-diagram="semantic">${semantic}</section>`
    document.body.append(host)

    const orthogonalSvg = host.querySelector<SVGSVGElement>('[data-diagram="orthogonal"] svg')!
    const smoothSvg = host.querySelector<SVGSVGElement>('[data-diagram="smooth"] svg')!
    const edge = orthogonalSvg.querySelector<SVGPathElement>('.flowchart-link')!
    const labelBackground = orthogonalSvg.querySelector<SVGRectElement>('.edgeLabel .background')!
    const arrowMarker = orthogonalSvg.querySelector<SVGMarkerElement>('marker[id$="-pointEnd"]')!
    const arrow = orthogonalSvg.querySelector<SVGPathElement>('marker[id$="-pointEnd"] .arrowMarkerPath')!
    return {
      smoothEdgePaths: [...host.querySelectorAll<SVGPathElement>('[data-diagram="smooth"] .flowchart-link')]
        .map(path => path.getAttribute('d') || ''),
      orthogonalEdgePaths: [...host.querySelectorAll<SVGPathElement>('[data-diagram="orthogonal"] .flowchart-link')]
        .map(path => path.getAttribute('d') || ''),
      edgeCaps: [
        getComputedStyle(smoothSvg.querySelector<SVGPathElement>('.flowchart-link')!).strokeLinecap,
        getComputedStyle(edge).strokeLinecap,
      ],
      edgeJoins: [
        getComputedStyle(smoothSvg.querySelector<SVGPathElement>('.flowchart-link')!).strokeLinejoin,
        getComputedStyle(edge).strokeLinejoin,
      ],
      labelRadius: getComputedStyle(labelBackground).rx,
      labelOpacity: getComputedStyle(labelBackground).opacity,
      arrowFill: getComputedStyle(arrow).fill,
      arrowStroke: getComputedStyle(arrow).stroke,
      arrowStrokeWidth: getComputedStyle(arrow).strokeWidth,
      edgeStrokeWidth: getComputedStyle(edge).strokeWidth,
      arrowMarkerWidth: arrowMarker.getAttribute('markerWidth'),
      arrowMarkerViewBox: arrowMarker.getAttribute('viewBox'),
      arrowMarkerRefX: arrowMarker.getAttribute('refX'),
      arrowPath: arrow.getAttribute('d'),
      smoothArrowPath: smoothSvg.querySelector<SVGPathElement>('marker[id$="-pointEnd"] .arrowMarkerPath')?.getAttribute('d'),
      semanticMarkerIds: [...host.querySelectorAll<SVGMarkerElement>('[data-diagram="semantic"] marker')]
        .map(marker => marker.id),
    }
  })

  expect(rendered.smoothEdgePaths.some(path => path.includes('C'))).toBe(true)
  expect(rendered.orthogonalEdgePaths.some(path => path.includes('Q'))).toBe(true)
  expect(rendered.edgeCaps).toEqual(['round', 'round'])
  expect(rendered.edgeJoins).toEqual(['round', 'round'])
  expect(rendered.labelRadius).toBe('8px')
  expect(rendered.labelOpacity).toBe('1')
  expect(rendered.arrowFill).toBe('none')
  expect(rendered.arrowStrokeWidth).toBe(rendered.edgeStrokeWidth)
  expect(rendered.arrowStroke).not.toBe('')
  expect(rendered.arrowMarkerWidth).toBe('9.5')
  expect(rendered.arrowMarkerViewBox).toBe('0 0 10 10')
  expect(rendered.arrowMarkerRefX).toBe('4.65')
  expect(rendered.arrowPath).toBe('M 0 0 L 4.2 4 C 4.8 4.57 4.8 5.43 4.2 6 L 0 10')
  expect(rendered.smoothArrowPath).toBe(rendered.arrowPath)
  expect(rendered.semanticMarkerIds.some(id => id.endsWith('-circleEnd'))).toBe(true)
  expect(rendered.semanticMarkerIds.some(id => id.endsWith('-crossEnd'))).toBe(true)
})

test('浏览器真实渲染 Mermaid，在窄屏预览并导出有效 PNG', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/', { waitUntil: 'commit' })

  await page.evaluate(async () => {
    const { renderMarkdownMermaid } = await import('/src/utils/mermaidRenderer.ts')
    const root = document.createElement('main')
    root.id = 'mermaid-e2e-fixture'
    root.innerHTML = '<pre class="md-mermaid-source"><code>graph LR\n  A[Start] --&gt; B[Finish]\n  classDef dark fill:#202638,stroke:#ef4444\n  class A dark</code></pre>'
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
  const diagram = chart.locator('svg.flowchart')
  await expect(diagram).toBeVisible()
  await expect(diagram).toContainText('Start')
  await expect(diagram).toContainText('Finish')
  const nodeTextContrast = await chart.locator('.node.dark').evaluate((node) => {
    const parseRgb = (color: string) => color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/)?.slice(1).map(Number)
    const shape = node.querySelector('rect, polygon, ellipse, circle, path')
    const text = node.querySelector('text')
    const background = shape ? parseRgb(getComputedStyle(shape).fill) : null
    const foreground = text ? parseRgb(getComputedStyle(text).fill) : null
    if (!background || !foreground) return 0
    const luminance = ([red, green, blue]: number[]) => [red, green, blue]
      .map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const [bright, dark] = [luminance(background), luminance(foreground)].sort((a, b) => b - a)
    return (bright + 0.05) / (dark + 0.05)
  })
  expect(nodeTextContrast).toBeGreaterThanOrEqual(4.5)

  const controls = chart.locator('.md-mermaid-controls')
  const controlOpacity = () => controls.evaluate(element => Number(getComputedStyle(element).opacity))
  const controlBackdropFilter = () => controls.evaluate(element => getComputedStyle(element).backdropFilter)
  await expect.poll(controlBackdropFilter).not.toBe('none')
  await page.mouse.move(1, 1)
  await expect.poll(controlOpacity).toBeLessThan(0.05)
  await chart.hover()
  await expect.poll(controlOpacity).toBeGreaterThan(0.95)
  await page.mouse.move(1, 1)
  await expect.poll(controlOpacity).toBeLessThan(0.05)

  const expand = chart.getByRole('button', { name: 'Expand' })
  await expand.focus()
  await expect.poll(controlOpacity).toBeGreaterThan(0.95)
  await expand.click()

  const dialog = page.getByRole('dialog', { name: 'Diagram preview' })
  await expect(dialog).toBeVisible()
  const dialogBody = dialog.locator('.md-mermaid-dialog-body')
  await expect.poll(() => dialogBody.evaluate(element => getComputedStyle(element).overflow)).toBe('hidden')
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
