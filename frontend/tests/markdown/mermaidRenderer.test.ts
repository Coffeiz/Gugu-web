import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { cleanupMarkdownMermaid, renderMarkdownMermaid, renderMermaidSvg } from '@/utils/mermaidRenderer'
import type { MermaidInteractionLabels } from '@/utils/mermaidInteraction'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  registerExternalDiagrams: vi.fn(),
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))
vi.mock('@mermaid-js/mermaid-zenuml', () => ({ default: {} }))

const labels: MermaidInteractionLabels & { renderFailed: string } = {
  zoomOut: 'Zoom out', zoomIn: 'Zoom in', resetZoom: 'Reset', expand: 'Expand',
  downloadPng: 'Download PNG', close: 'Close', previewTitle: 'Diagram preview',
  downloadFailed: 'Download failed', pngTooLarge: 'Diagram too large', renderFailed: 'Render failed',
}
let root: HTMLDivElement | null = null

describe('共享 Mermaid 渲染', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mermaidMock.render.mockResolvedValue({
      svg: '<svg id="diagram-root" onload="run()"><defs><clipPath id="diagram-clip"><rect /></clipPath></defs><g clip-path="url(#diagram-clip)"><text id="diagram-label">Diagram</text></g></svg>',
    })
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
      theme: 'base',
      themeCSS: expect.stringContaining('rx: 12px'),
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

  it('图表异步生成期间保留原代码块高度，避免消息行先塌缩再撑开', async () => {
    root = document.createElement('div')
    root.innerHTML = '<pre class="md-mermaid-source"><code>flowchart LR; RESERVED_HEIGHT_481-->B;</code></pre>'
    document.body.append(root)
    const sourceBlock = root.querySelector('pre')!
    vi.spyOn(sourceBlock, 'getBoundingClientRect').mockReturnValue({ height: 148 } as DOMRect)

    let resolveRender!: (value: { svg: string }) => void
    mermaidMock.render.mockReturnValue(new Promise(resolve => { resolveRender = resolve }))
    const rendering = renderMarkdownMermaid(root, labels)
    await nextTick()
    await vi.waitFor(() => expect(mermaidMock.render).toHaveBeenCalledOnce())

    const placeholder = root.querySelector<HTMLElement>('.md-mermaid')
    expect(placeholder?.style.minHeight).toBe('148px')

    resolveRender({ svg: '<svg><text>Diagram</text></svg>' })
    await rendering
    expect(placeholder?.style.minHeight).toBe('')
    expect(placeholder?.querySelector('svg text')?.textContent).toBe('Diagram')
  })

  it('虚拟消息重挂载时复用图表计算，并为每次挂载生成互不冲突的 SVG ID', async () => {
    const source = 'flowchart LR; CACHE_REATTACH_93741-->B;'
    const firstRoot = document.createElement('div')
    const secondRoot = document.createElement('div')
    for (const element of [firstRoot, secondRoot]) {
      element.innerHTML = `<pre class="md-mermaid-source"><code>${source}</code></pre>`
      document.body.append(element)
    }

    try {
      await renderMarkdownMermaid(firstRoot, labels)
      const firstSvg = firstRoot.querySelector('svg')!
      const firstIds = new Set([firstSvg, ...firstSvg.querySelectorAll('[id]')].map(element => element.id))

      await renderMarkdownMermaid(secondRoot, labels)
      const secondSvg = secondRoot.querySelector('svg')!
      const secondIds = [secondSvg, ...secondSvg.querySelectorAll('[id]')].map(element => element.id)
      const clipReference = secondSvg.querySelector('[clip-path]')?.getAttribute('clip-path') || ''
      const referencedClipId = clipReference.match(/url\(#([^)]*)\)/)?.[1]

      expect(mermaidMock.render).toHaveBeenCalledTimes(1)
      expect(secondIds.every(id => !firstIds.has(id))).toBe(true)
      expect(referencedClipId).toBeTruthy()
      expect(secondIds).toContain(referencedClipId)
    } finally {
      cleanupMarkdownMermaid(firstRoot)
      cleanupMarkdownMermaid(secondRoot)
      firstRoot.remove()
      secondRoot.remove()
    }
  })
})
