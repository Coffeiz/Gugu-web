import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { cleanupMarkdownMermaid, renderMarkdownMermaid, renderMermaidSvg } from '@/utils/mermaidRenderer'
import type { MermaidInteractionLabels } from '@/utils/mermaidInteraction'
import { createMermaidThemeConfig, MERMAID_NEUTRAL_THEME_COLORS } from '../../../backend/ts/workers/mermaid-renderer/theme.mjs'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  registerExternalDiagrams: vi.fn(),
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))
vi.mock('@mermaid-js/mermaid-zenuml', () => ({ default: {} }))

const labels: MermaidInteractionLabels & { renderFailed: string } = {
  zoomOut: 'Zoom out', zoomIn: 'Zoom in', resetZoom: 'Reset', expand: 'Expand',
  showSource: 'Show source', showDiagram: 'Show diagram',
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
    const webTheme = mermaidMock.initialize.mock.calls[0][0]
    expect(webTheme.themeCSS).toBe(createMermaidThemeConfig(
      webTheme.themeVariables,
      webTheme.themeVariables.fontFamily,
    ).themeCSS)
    const imTheme = createMermaidThemeConfig(MERMAID_NEUTRAL_THEME_COLORS, 'Inter, sans-serif')
    expect(imTheme.themeCSS).toBe(webTheme.themeCSS)
    expect(imTheme.themeVariables).toMatchObject({
      background: '#ffffff',
      primaryTextColor: '#272532',
      nodeTextColor: '#272532',
      textColor: '#272532',
      lineColor: '#67647a',
    })
    const darkTheme = createMermaidThemeConfig({
      ...MERMAID_NEUTRAL_THEME_COLORS,
      primaryTextColor: '#f0edf3',
    }, 'Inter, sans-serif')
    expect(darkTheme.themeVariables.nodeTextColor).toBe('#f0edf3')
    expect(darkTheme.themeVariables.textColor).toBe('#f0edf3')
    expect(rendered.querySelector('svg')).not.toBeNull()
    expect(rendered.querySelector('[onload]')).toBeNull()
  })

  it('将中文 Sankey 标签适配为解析器可处理的标识并在 SVG 中恢复中文', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg><text>GuguMermaidNode0</text><text>GuguMermaidNode1</text></svg>',
    })
    const source = 'sankey\n"消息来源","飞书对话",12\n"消息来源","QQ 对话",8'

    const svg = await renderMermaidSvg(source)
    const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const parserSource = mermaidMock.render.mock.calls[0][1]

    expect(parserSource).toContain('"GuguMermaidNode0","GuguMermaidNode1",12')
    expect(parserSource).toContain('"GuguMermaidNode0","GuguMermaidNode2",8')
    expect([...rendered.querySelectorAll('text')].map(node => node.textContent)).toEqual([
      '消息来源', '飞书对话',
    ])
    expect(svg).not.toContain('GuguMermaidNode')
  })

  it('为 Mermaid XY 图未加引号的中文标题补上语法要求的引号', async () => {
    await renderMermaidSvg('xychart-beta\n  title 咕咕对话量\n  bar [2, 3]')

    expect(mermaidMock.render.mock.calls[0][1]).toContain('title "咕咕对话量"')
  })

  it('深色节点填充下修正低对比标签，同时保留已可读的自定义标签色', async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><g class="node dark"><rect fill="#202638" /><text fill="#272532">低对比<tspan>标签</tspan></text></g><g class="node readable"><rect fill="#202638" /><text fill="#ffffff">可读标签</text></g></svg>',
    })

    const svg = await renderMermaidSvg('flowchart TD; A-->B;')
    const rendered = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const labels = [...rendered.querySelectorAll('.node text, .node tspan')]

    expect(labels[0].getAttribute('style')).toContain('fill: #ffffff')
    expect(labels[1].getAttribute('fill')).toBeNull()
    expect(labels[2].getAttribute('fill')).toBe('#ffffff')
  })

  it('将 mindmap 圆形根节点的文字以节点中心为锚点，且不改其他图表', async () => {
    mermaidMock.render
      .mockResolvedValueOnce({
        svg: '<svg aria-roledescription="mindmap" viewBox="0 0 1000 250"><g class="mindmap-node section-root" transform="translate(530, 34)"><circle r="26" /><g class="label"><text y="-10.1"><tspan x="0">Root</tspan></text></g></g></svg>',
      })
      .mockResolvedValueOnce({
        svg: '<svg aria-roledescription="flowchart" viewBox="0 0 1000 250"><g class="node"><text><tspan x="0">Root</tspan></text></g></svg>',
      })

    const mindmap = new DOMParser().parseFromString(await renderMermaidSvg('mindmap\n  root((Root))'), 'image/svg+xml').documentElement
    const flowchart = new DOMParser().parseFromString(await renderMermaidSvg('flowchart LR; ROOT_ALIGNMENT_OTHER-->END;'), 'image/svg+xml').documentElement

    expect(mindmap.querySelector('.section-root .label text')?.getAttribute('text-anchor')).toBe('middle')
    expect(mindmap.getAttribute('viewBox')).toBe('0 0 1000 250')
    expect(flowchart.querySelector('.node text')?.hasAttribute('text-anchor')).toBe(false)
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
