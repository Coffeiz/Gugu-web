import { nextTick } from 'vue'
import { bindMermaidInteractions, cleanupMermaidInteractions, type MermaidInteractionLabels } from '@/utils/mermaidInteraction'
import { sanitizeHtml } from '@/utils/markdown'
import { resolveMermaidThemeColors } from '@/utils/mermaidTheme'
import { createMermaidThemeConfig } from '../../../backend/ts/workers/mermaid-renderer/theme.mjs'
import { prepareMermaidDiagramSource, restoreMermaidDiagramLabels } from '../../../backend/ts/workers/mermaid-renderer/diagram-source.mjs'
import { normalizeMermaidEdgeLabelBounds, normalizeMermaidEdgeStyles, normalizeMermaidMindmapRootLabel, normalizeMermaidNodeCorners, normalizeMermaidStateDiagramLabelAlignment } from '../../../backend/ts/workers/mermaid-renderer/svg-style.mjs'

type MermaidApi = typeof import('mermaid').default

let mermaidLoad: Promise<MermaidApi> | null = null
let renderSequence = 0
let svgInstanceSequence = 0

const MERMAID_RENDER_CACHE_MAX_ENTRIES = 32
const MERMAID_RENDER_CACHE_MAX_CHARS = 1_000_000
const mermaidRenderCache = new Map<string, { svg: string; chars: number }>()
const mermaidRenderInFlight = new Map<string, Promise<string>>()
let mermaidRenderCacheChars = 0

export type MermaidRenderLabels = MermaidInteractionLabels & { renderFailed: string }

async function getMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= (async () => {
    const [{ default: mermaid }, { default: zenuml }] = await Promise.all([
      import('mermaid'),
      import('@mermaid-js/mermaid-zenuml'),
    ])
    await mermaid.registerExternalDiagrams([zenuml])
    return mermaid
  })()
  return mermaidLoad
}

function getCachedMermaidSvg(key: string): string | undefined {
  const entry = mermaidRenderCache.get(key)
  if (!entry) return undefined
  mermaidRenderCache.delete(key)
  mermaidRenderCache.set(key, entry)
  return entry.svg
}

function cacheMermaidSvg(key: string, svg: string): void {
  const entryChars = svg.length + key.length
  if (entryChars > MERMAID_RENDER_CACHE_MAX_CHARS) return
  const previous = mermaidRenderCache.get(key)
  if (previous) {
    mermaidRenderCacheChars -= previous.chars
    mermaidRenderCache.delete(key)
  }
  mermaidRenderCache.set(key, { svg, chars: entryChars })
  mermaidRenderCacheChars += entryChars
  while (
    mermaidRenderCache.size > MERMAID_RENDER_CACHE_MAX_ENTRIES
    || mermaidRenderCacheChars > MERMAID_RENDER_CACHE_MAX_CHARS
  ) {
    const oldestKey = mermaidRenderCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = mermaidRenderCache.get(oldestKey)
    mermaidRenderCache.delete(oldestKey)
    if (oldest) mermaidRenderCacheChars -= oldest.chars
  }
}

function rewriteSvgIdReferences(value: string, attributeName: string, idMap: Map<string, string>): string {
  if (attributeName === 'href' || attributeName === 'xlink:href') {
    const renamed = value.startsWith('#') ? idMap.get(value.slice(1)) : undefined
    return renamed ? `#${renamed}` : value
  }
  if (attributeName === 'aria-labelledby' || attributeName === 'aria-describedby') {
    return value.split(/\s+/).map(id => idMap.get(id) || id).join(' ')
  }
  if (attributeName === 'begin' || attributeName === 'end') {
    return value.replace(/(^|;)(\s*)([\w:.-]+)(?=\.)/g, (_match, separator: string, whitespace: string, id: string) =>
      `${separator}${whitespace}${idMap.get(id) || id}`)
  }
  let rewritten = value.replace(/url\(#([^)]+)\)/g, (match, id: string) => {
    const renamed = idMap.get(id)
    return renamed ? `url(#${renamed})` : match
  })
  if (attributeName === '__stylesheet') {
    rewritten = rewritten.replace(/#([\w:.-]+)/g, (match, id: string) => {
      const renamed = idMap.get(id)
      return renamed ? `#${renamed}` : match
    })
  }
  return rewritten
}

function buildSvgIdMap(elements: Element[], prefix: string): Map<string, string> {
  const idMap = new Map<string, string>()
  elements.forEach((element, index) => {
    const originalId = element.getAttribute('id') || ''
    // 保留原 ID 后缀（例如 -pointEnd），样式与 Mermaid 的内部选择器依赖该约定。
    if (originalId && !idMap.has(originalId)) idMap.set(originalId, `${prefix}-${index}-${originalId}`)
  })
  return idMap
}

function applySvgIdMap(elements: Element[], idMap: Map<string, string>): void {
  elements.forEach((element) => {
    const originalId = element.getAttribute('id')
    const renamed = originalId ? idMap.get(originalId) : undefined
    if (renamed) element.setAttribute('id', renamed)
    for (const attribute of [...element.attributes]) {
      const rewritten = rewriteSvgIdReferences(attribute.value, attribute.name, idMap)
      if (rewritten !== attribute.value) element.setAttributeNS(attribute.namespaceURI, attribute.name, rewritten)
    }
  })
}

/** 图表离开虚拟窗口后再次挂载时复用 SVG，但每个实例必须拥有独立的文档内 ID。 */
function namespaceSvgIds(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return svg

  const prefix = `gugu-mermaid-instance-${++svgInstanceSequence}`
  const elements = [parsed.documentElement, ...parsed.documentElement.querySelectorAll<SVGElement>('*')]
  const idMap = buildSvgIdMap(elements, prefix)
  if (!idMap.size) return svg
  applySvgIdMap(elements, idMap)
  parsed.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteSvgIdReferences(style.textContent || '', '__stylesheet', idMap)
  })
  return new XMLSerializer().serializeToString(parsed.documentElement)
}

function normalizeSvgEdgeStyles(svg: string, arrowheadColor: string, labels: Record<string, string>): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return svg
  restoreMermaidDiagramLabels(parsed.documentElement, labels)
  normalizeMermaidMindmapRootLabel(parsed.documentElement)
  normalizeMermaidNodeCorners(parsed.documentElement)
  normalizeMermaidEdgeLabelBounds(parsed.documentElement)
  const root = normalizeMermaidEdgeStyles(parsed.documentElement, arrowheadColor)
  return new XMLSerializer().serializeToString(root)
}

function parseRgbColor(color: string): [number, number, number] | null {
  const match = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)[, ]+\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  if (!match || (match[4] !== undefined && Number(match[4]) < 1)) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const linear = [red, green, blue].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
}

function contrastRatio(first: [number, number, number], second: [number, number, number]): number {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (luminances[0] + 0.05) / (luminances[1] + 0.05)
}

/** Mermaid classDef 可单独指定深色节点底，但省略文字色；修正低对比标签并保留可读的自定义颜色。 */
function normalizeSvgNodeTextContrast(svg: string): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (parsed.querySelector('parsererror') || root.localName.toLowerCase() !== 'svg') return svg
  normalizeMermaidStateDiagramLabelAlignment(root)

  const measurementHost = document.createElement('div')
  measurementHost.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;'
  const measuredSvg = document.importNode(root, true)
  measurementHost.append(measuredSvg)
  document.body.append(measurementHost)

  try {
    for (const node of measuredSvg.querySelectorAll<SVGGElement>('.node')) {
      const shape = node.querySelector<SVGGraphicsElement>('rect, polygon, ellipse, circle, path')
      const textElements = [...node.querySelectorAll<SVGTextElement>('text, tspan')]
      if (!shape || textElements.length === 0) continue

      const background = parseRgbColor(getComputedStyle(shape).fill)
      if (!background) continue

      const black: [number, number, number] = [0, 0, 0]
      const white: [number, number, number] = [255, 255, 255]
      for (const text of textElements) {
        const textColor = parseRgbColor(getComputedStyle(text).fill)
        if (!textColor || contrastRatio(background, textColor) >= 4.5) continue
        const readableColor = contrastRatio(background, white) >= contrastRatio(background, black) ? '#ffffff' : '#000000'
        const declarations = new Map<string, string>()
        for (const item of (text.getAttribute('style') || '').split(';')) {
          const separator = item.indexOf(':')
          if (separator < 0) continue
          const name = item.slice(0, separator).trim()
          if (name) declarations.set(name, item.slice(separator + 1).trim())
        }
        declarations.set('fill', readableColor)
        text.setAttribute('style', [...declarations].map(([name, value]) => `${name}: ${value}`).join('; '))
      }
    }
  } finally {
    measurementHost.remove()
  }

  return new XMLSerializer().serializeToString(measuredSvg)
}

/** 所有 Markdown 入口共享 Mermaid 懒加载、主题、安全配置与 SVG 消毒。 */
export async function renderMermaidSvg(source: string): Promise<string> {
  const originalSource = source
  const prepared = prepareMermaidDiagramSource(source)
  source = prepared.source
  const dark = document.documentElement.dataset.theme === 'dark'
  const colors = resolveMermaidThemeColors(dark)
  const fontFamily = getComputedStyle(document.body).fontFamily.trim()
    || '"Gugu Noto Sans SC", sans-serif'
  const cacheKey = JSON.stringify([originalSource, source, prepared.labels, colors, fontFamily])
  const cachedSvg = getCachedMermaidSvg(cacheKey)
  if (cachedSvg) return namespaceSvgIds(cachedSvg)
  const inFlight = mermaidRenderInFlight.get(cacheKey)
  if (inFlight) return namespaceSvgIds(await inFlight)

  const rendering = (async () => {
    const mermaid = await getMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      ...createMermaidThemeConfig(colors, fontFamily),
    })
    const { svg } = await mermaid.render(`gugu-mermaid-${++renderSequence}`, source)
    const sanitizedSvg = sanitizeHtml(normalizeSvgEdgeStyles(svg, colors.arrowheadColor, prepared.labels))
    const readableSvg = normalizeSvgNodeTextContrast(sanitizedSvg)
    cacheMermaidSvg(cacheKey, readableSvg)
    return readableSvg
  })()
  mermaidRenderInFlight.set(cacheKey, rendering)
  try {
    return namespaceSvgIds(await rendering)
  } finally {
    if (mermaidRenderInFlight.get(cacheKey) === rendering) mermaidRenderInFlight.delete(cacheKey)
  }
}

async function renderBlock(element: HTMLElement, source: string, labels: MermaidRenderLabels): Promise<void> {
  const sequence = ++renderSequence
  element.dataset.renderSequence = String(sequence)
  try {
    const svg = await renderMermaidSvg(source)
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    cleanupMermaidInteractions(element)
    element.innerHTML = svg
    element.style.removeProperty('min-height')
    bindMermaidInteractions(element, labels)
    element.classList.add('md-mermaid-ready')
    element.classList.remove('md-mermaid-error')
  } catch {
    if (!element.isConnected || element.dataset.renderSequence !== String(sequence)) return
    cleanupMermaidInteractions(element)
    element.style.removeProperty('min-height')
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
    const placeholderHeight = Math.ceil(sourceBlock.getBoundingClientRect().height)
    if (placeholderHeight > 0) container.style.minHeight = `${placeholderHeight}px`
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
