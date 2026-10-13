import { nextTick } from 'vue'
import { bindMermaidInteractions, cleanupMermaidInteractions, type MermaidInteractionLabels } from '@/utils/mermaidInteraction'
import { sanitizeHtml } from '@/utils/markdown'
import { resolveMermaidThemeColors } from '@/utils/mermaidTheme'

type MermaidApi = typeof import('mermaid').default

let mermaidLoad: Promise<MermaidApi> | null = null
let renderSequence = 0

export type MermaidRenderLabels = MermaidInteractionLabels & { renderFailed: string }

async function getMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= import('mermaid').then(module => module.default)
  return mermaidLoad
}

function cssToken(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 所有 Markdown 入口共享 Mermaid 懒加载、主题、安全配置与 SVG 消毒。 */
export async function renderMermaidSvg(source: string): Promise<string> {
  const mermaid = await getMermaid()
  const dark = document.documentElement.dataset.theme === 'dark'
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    theme: dark ? 'dark' : 'default',
    themeVariables: {
      ...resolveMermaidThemeColors(dark),
      fontFamily: cssToken('--font-family-sans', 'Inter, sans-serif'),
    },
  })
  const { svg } = await mermaid.render(`gugu-mermaid-${++renderSequence}`, source)
  return sanitizeHtml(svg)
}

async function renderBlock(element: HTMLElement, source: string, labels: MermaidRenderLabels): Promise<void> {
  const sequence = ++renderSequence
  element.dataset.renderSequence = String(sequence)
  try {
    const svg = await renderMermaidSvg(source)
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    cleanupMermaidInteractions(element)
    element.innerHTML = svg
    bindMermaidInteractions(element, labels)
    element.classList.add('md-mermaid-ready')
    element.classList.remove('md-mermaid-error')
  } catch {
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    cleanupMermaidInteractions(element)
    element.classList.add('md-mermaid-error')
    element.textContent = `${labels.renderFailed}\n\n${source}`
  }
}

/** 统一处理 Markdown Mermaid 占位节点、异步渲染代际与交互生命周期。 */
export async function renderMarkdownMermaid(
  root: HTMLElement | null,
  labels: MermaidRenderLabels,
  beforeRender?: () => void,
): Promise<void> {
  await nextTick()
  if (!root) return
  beforeRender?.()
  for (const sourceBlock of root.querySelectorAll<HTMLElement>('.md-mermaid-source')) {
    const container = document.createElement('div')
    container.className = 'md-mermaid'
    container.dataset.source = encodeURIComponent(sourceBlock.textContent || '')
    sourceBlock.replaceWith(container)
  }
  for (const container of root.querySelectorAll<HTMLElement>('.md-mermaid')) {
    const encoded = container.dataset.source
    if (encoded) await renderBlock(container, decodeURIComponent(encoded), labels)
  }
}

/** 使未完成的异步渲染失效，并清理所有图表的弹层与事件绑定。 */
export function cleanupMarkdownMermaid(root: HTMLElement | null): void {
  if (!root) return
  for (const container of root.querySelectorAll<HTMLElement>('.md-mermaid')) {
    container.dataset.renderSequence = String(++renderSequence)
  }
  cleanupMermaidInteractions(root)
}
