import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupMarkdownMermaid, renderMarkdownMermaid, renderMermaidSvg } from '@/utils/mermaidRenderer'
import type { MermaidInteractionLabels } from '@/utils/mermaidInteraction'

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaidMock }))

const labels: MermaidInteractionLabels & { renderFailed: string } = {
  zoomOut: 'Zoom out', zoomIn: 'Zoom in', resetZoom: 'Reset', expand: 'Expand',
  downloadPng: 'Download PNG', close: 'Close', previewTitle: 'Diagram preview',
  downloadFailed: 'Download failed', pngTooLarge: 'Diagram too large', renderFailed: 'Render failed',
}
let root: HTMLDivElement | null = null

describe('共享 Mermaid 渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mermaidMock.render.mockResolvedValue({ svg: '<svg onload="run()"><text>Diagram</text></svg>' })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    if (root) {
      cleanupMarkdownMermaid(root)
      root.remove()
      root = null
    }
  })

  it('统一使用严格安全配置，并在返回 SVG 前消毒危险事件属性', async () => {
    const svg = await renderMermaidSvg('flowchart LR; A-->B;')
    const rendered = document.createElement('div')
    rendered.innerHTML = svg

    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
    }))
    expect(rendered.querySelector('svg')).not.toBeNull()
    expect(rendered.querySelector('[onload]')).toBeNull()
  })

  it('把 Markdown Mermaid 占位节点替换为可交互图表，并在清理时移除控件', async () => {
    root = document.createElement('div')
    root.innerHTML = '<pre class="md-mermaid-source"><code>flowchart LR; A--&gt;B;</code></pre>'
    document.body.append(root)

    await renderMarkdownMermaid(root, labels)

    const chart = root.querySelector<HTMLElement>('.md-mermaid-ready')
    expect(chart?.querySelector('svg text')?.textContent).toBe('Diagram')
    expect(chart?.querySelector('[data-mermaid-action="expand"]')?.getAttribute('aria-label')).toBe(labels.expand)

    cleanupMarkdownMermaid(root)
    expect(chart?.querySelector('.md-mermaid-controls')).toBeNull()
  })
})
