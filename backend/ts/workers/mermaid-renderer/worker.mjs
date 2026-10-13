import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { createHTMLWindow } from 'svgdom'
import { normalizeMermaidEdgeLabelBounds, normalizeMermaidEdgeStyles, normalizeMermaidKanbanSectionTitles, normalizeMermaidMindmapRootLabel, normalizeMermaidNodeCorners, normalizeMermaidRasterText } from './svg-style.mjs'
import { prepareMermaidDiagramSource, restoreMermaidDiagramLabels } from './diagram-source.mjs'
import { createMermaidThemeConfig, resolveMermaidThemeColors } from './theme.mjs'

const MAX_SOURCE_CHARS = 20_000
const MAX_DIAGRAMS = 4
const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_DIMENSION = 4_096
const MAX_PIXELS = 5_000_000
const MAX_PNG_BYTES = 3 * 1024 * 1024
const CJK_FONT_FILE = [
  new URL('./fonts/NotoSansSC-VariableFont_wght.ttf', import.meta.url),
  new URL('../../../../frontend/public/fonts/Noto_Sans_SC/NotoSansSC-VariableFont_wght.ttf', import.meta.url),
  new URL('../../frontend/public/fonts/Noto_Sans_SC/NotoSansSC-VariableFont_wght.ttf', import.meta.url),
].map(fileURLToPath).find(existsSync)
if (!CJK_FONT_FILE) throw new Error('cjk_font_unavailable')
const FORBIDDEN_SVG_ELEMENTS = new Set([
  'a', 'animate', 'animatemotion', 'animatetransform', 'audio', 'foreignobject',
  'iframe', 'image', 'script', 'set', 'video',
])

const input = await new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  process.stdin.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_SOURCE_CHARS * MAX_DIAGRAMS * 4 + 1024) {
      reject(new Error('input_too_large'))
      process.stdin.destroy()
      return
    }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  process.stdin.on('error', reject)
})

const request = JSON.parse(input)
const sources = Array.isArray(request) ? request : request?.sources
const colors = resolveMermaidThemeColors(Array.isArray(request) ? {} : request?.theme)
if (
  !Array.isArray(sources) || sources.length > MAX_DIAGRAMS ||
  sources.some((source) => typeof source !== 'string' || !source || source.length > MAX_SOURCE_CHARS)
) throw new Error('input_too_large')

const window = createHTMLWindow()
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  enumerable: true,
  value: window,
  writable: true,
})
globalThis.document = window.document
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node',
  'DOMParser', 'XMLSerializer', 'MutationObserver', 'CSSStyleSheet', 'getComputedStyle',
]) {
  if (key in window) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      value: window[key],
      writable: true,
    })
  }
}
// svgdom 提供 parentNode，但没有实现浏览器标准的 parentElement；Mermaid Gantt
// 会通过它读取父容器宽度。补齐 DOM 语义后，未提供 offsetWidth 时 Mermaid 会用默认宽度。
Object.defineProperty(window.Element.prototype, 'parentElement', {
  configurable: true,
  get() {
    const parent = this.parentNode
    return parent?.nodeType === 1 ? parent : null
  },
})
// svgdom 的 getBBox 会漏算 flowchart 多行标签的行高，也会低估中文字符宽度，导致节点过窄；
// Resvg 再按完整字体绘制时，文字会穿出节点。测量阶段补齐行高和中文宽度，让 Mermaid 同步调整布局。
const originalGetTextBBox = window.SVGGraphicsElement.prototype.getBBox
const fullWidthTextCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u
Object.defineProperty(window.SVGGraphicsElement.prototype, 'getBBox', {
  configurable: true,
  value() {
    const bounds = originalGetTextBBox.call(this)
    if (this.nodeName !== 'text') return bounds

    const positionedLines = Array.from(this.childNodes || []).filter((child) =>
      child.nodeType === 1 && child.localName === 'tspan' &&
      (child.hasAttribute('y') || child.hasAttribute('dy')),
    )
    const computedFontSize = window.getComputedStyle(this).fontSize
    const fontSize = Number.parseFloat(computedFontSize || this.style.fontSize || this.getAttribute('font-size') || '16') || 16
    const lines = positionedLines.length
      ? positionedLines.map(line => line.textContent || '')
      : [this.textContent || '']
    const containsFullWidthText = lines.some(line => [...line].some(character => fullWidthTextCharacter.test(character)))
    const measuredWidth = containsFullWidthText
      ? Math.max(...lines.map(line => [...line].reduce((width, character) => {
        if (fullWidthTextCharacter.test(character)) return width + fontSize
        if (/\s/u.test(character)) return width + fontSize * 0.33
        if (/[ilI.,:;'|!]/u.test(character)) return width + fontSize * 0.32
        if (/[MW@%]/u.test(character)) return width + fontSize * 0.85
        if (character === '→') return width + fontSize * 0.95
        return width + fontSize * 0.56
      }, 0)))
      : bounds.width
    const height = positionedLines.length >= 2 ? positionedLines.length * fontSize * 1.1 : bounds.height
    if (measuredWidth <= bounds.width && height <= bounds.height) return bounds
    return {
      ...bounds,
      width: Math.max(bounds.width, measuredWidth),
      right: Math.max(bounds.right, bounds.x + measuredWidth),
      y: positionedLines.length >= 2 ? Math.min(bounds.y, -height / 2) : bounds.y,
      height,
    }
  },
})
// d3-selection 的 Sankey 节点 join 依赖 compareDocumentPosition；svgdom 未实现它，
// 这里按 DOM 祖先链补齐节点顺序关系，供光栅化器使用。
if (window.Node?.prototype && typeof window.Node.prototype.compareDocumentPosition !== 'function') {
  Object.defineProperty(window.Node.prototype, 'compareDocumentPosition', {
    configurable: true,
    value(other) {
      if (this === other) return 0
      const thisAncestors = []
      const otherAncestors = []
      for (let node = this; node; node = node.parentNode) thisAncestors.unshift(node)
      for (let node = other; node; node = node.parentNode) otherAncestors.unshift(node)
      if (thisAncestors[0] !== otherAncestors[0]) return 1 | 32

      let commonIndex = 0
      while (
        commonIndex < thisAncestors.length && commonIndex < otherAncestors.length &&
        thisAncestors[commonIndex] === otherAncestors[commonIndex]
      ) commonIndex += 1
      if (commonIndex === thisAncestors.length) return 4 | 16
      if (commonIndex === otherAncestors.length) return 2 | 8

      const parent = thisAncestors[commonIndex - 1]
      const siblings = Array.from(parent.childNodes || [])
      return siblings.indexOf(thisAncestors[commonIndex]) < siblings.indexOf(otherAncestors[commonIndex])
        ? 4
        : 2
    },
  })
}
globalThis.CSSStyleSheet ??= class {
  cssRules = []
  insertRule(rule, index = this.cssRules.length) {
    this.cssRules.splice(index, 0, { cssText: String(rule) })
    return index
  }
  replaceSync(css) {
    this.cssRules = css ? [{ cssText: String(css) }] : []
  }
}
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0)
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle)
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }

const [{ default: mermaid }, { default: zenuml }] = await Promise.all([
  import('mermaid'),
  import('@mermaid-js/mermaid-zenuml'),
])
await mermaid.registerExternalDiagrams([zenuml])
mermaid.initialize({
  startOnLoad: false,
  // 输出只会进入 Resvg，不会作为 SVG 回传浏览器；对 Mermaid loose 模式产生的
  // SVG 做严格元素/属性校验，拒绝链接、脚本、动画、HTML 与外部资源。
  securityLevel: 'loose',
  htmlLabels: false,
  // Mermaid 的 Journey 默认使用 foreignObject 包裹标签；IM 图片渲染拒绝 HTML 节点，
  // 改用 SVG 文字，避免整张图被安全校验拒绝。
  journey: { textPlacement: 'svg' },
  // 时序图的 actor/message/note 有独立字体配置，themeVariables.fontFamily 和 themeCSS
  // 不会覆盖其默认的 Trebuchet + 400；显式指定可变字体和栅格化需要的字重。
  sequence: {
    actorFontFamily: '"Noto Sans SC", sans-serif',
    actorFontWeight: 600,
    messageFontFamily: '"Noto Sans SC", sans-serif',
    messageFontWeight: 600,
    noteFontFamily: '"Noto Sans SC", sans-serif',
    noteFontWeight: 600,
  },
  suppressErrorRendering: true,
  maxTextSize: MAX_SOURCE_CHARS,
  maxEdges: 1_000,
  secure: [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering',
    'maxEdges', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'flowchart', 'journey', 'sequence', 'look', 'layout',
  ],
  ...createMermaidThemeConfig(colors, '"Noto Sans SC", sans-serif'),
})

function diagramType(source) {
  const body = source.replace(/^\s*---\s*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
  const firstLine = body.split(/\r?\n/).find((line) => line.trim()) || ''
  const match = firstLine.trim().match(/^([a-z][a-z0-9-]*)\b/i)
  return match?.[1].toLowerCase() || 'unknown'
}

for (let index = 0; index < sources.length; index += 1) {
  let png = Buffer.alloc(0)
  const prepared = prepareMermaidDiagramSource(sources[index], { forRasterizer: true })
  const source = prepared.source
  const type = diagramType(source)
  try {
    let svg
    try {
      ({ svg } = await mermaid.render(`gugu-${process.pid}-${index}`, source))
    } catch {
      throw new Error('diagram_parse_or_render_failed')
    }
    if (Buffer.byteLength(svg, 'utf8') > MAX_SVG_BYTES) throw new Error('svg_too_large')
    const document = new DOMParser({
      errorHandler: (level) => {
        if (level !== 'warning') throw new Error('invalid_svg')
      },
    }).parseFromString(svg, 'image/svg+xml')
    const root = document.documentElement
    if (!root || root.localName.toLowerCase() !== 'svg') {
      throw new Error('invalid_svg')
    }
    normalizeMermaidMindmapRootLabel(root)
    restoreMermaidDiagramLabels(root, prepared.labels)
    normalizeMermaidNodeCorners(root)
    if (type === 'kanban') normalizeMermaidKanbanSectionTitles(root)
    normalizeMermaidEdgeLabelBounds(root)
    const rasterTextOptions = {
      allText: true,
      fontFamily: 'Noto Sans SC',
      fontWeight: 600,
      colorAllText: type === 'sequencediagram' || type === 'journey',
      // Resvg 的可变字体在甘特图、饼图和 Journey 上即使设为 600 仍明显偏细；
      // 与 flowchart 的 CJK 标签采用同样的轻描边补偿，统一所有图片的视觉字重。
      strokeAllText: true,
    }
    normalizeMermaidRasterText(root, colors.primaryTextColor, rasterTextOptions)
    normalizeMermaidEdgeStyles(root, colors.arrowheadColor)
    for (const element of document.getElementsByTagName('*')) {
      if (element.namespaceURI !== 'http://www.w3.org/2000/svg') {
        throw new Error('non_svg_content_rejected')
      }
      if (FORBIDDEN_SVG_ELEMENTS.has(element.localName.toLowerCase())) {
        throw new Error('active_svg_content_rejected')
      }
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase()
        const value = attribute.value
        if (
          name === 'href' || name.endsWith(':href') || /^on[a-z]/i.test(name) ||
          /javascript\s*:/i.test(value)
        ) {
          throw new Error('unsafe_svg_attribute_rejected')
        }
        for (const match of value.matchAll(/url\(([^)]*)\)/gi)) {
          const target = match[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim()
          if (!target.startsWith('#')) throw new Error('external_svg_reference_rejected')
        }
      }
      if (element.localName.toLowerCase() === 'style') {
        const css = element.textContent || ''
        if (/@import|@font-face|expression\s*\(|behavior\s*:/i.test(css)) {
          throw new Error('unsafe_svg_css_rejected')
        }
      }
    }

    const viewBox = root.getAttribute('viewBox')?.match(/^\s*[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)\s*$/i)
    if (!viewBox) throw new Error('svg_dimensions_missing')
    const width = Math.ceil(Number(viewBox[1]))
    const height = Math.ceil(Number(viewBox[2]))
    if (
      !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS
    ) {
      throw new Error('pixel_limit_exceeded')
    }

    root.setAttribute('width', String(width))
    root.setAttribute('height', String(height))
    const validatedSvg = new XMLSerializer().serializeToString(root)
    try {
      png = new Resvg(validatedSvg, {
        background: colors.background,
        font: {
          fontFiles: [CJK_FONT_FILE],
          defaultFontFamily: 'Noto Sans SC',
          sansSerifFamily: 'Noto Sans SC',
        },
      }).render().asPng()
    } catch {
      throw new Error('png_conversion_failed')
    }
    if (png.byteLength > MAX_PNG_BYTES) throw new Error('png_too_large')
  } catch (error) {
    const knownReasons = new Set([
      'diagram_parse_or_render_failed', 'svg_too_large', 'invalid_svg',
      'non_svg_content_rejected', 'active_svg_content_rejected',
      'unsafe_svg_attribute_rejected', 'external_svg_reference_rejected',
      'unsafe_svg_css_rejected', 'svg_dimensions_missing', 'pixel_limit_exceeded',
      'png_conversion_failed', 'png_too_large',
    ])
    const reason = knownReasons.has(error?.message) ? error.message : 'render_failed'
    process.stderr.write(
      `MERMAID_RENDER_FAILURE index=${index} type=${type} reason=${reason}\n`,
    )
    png = Buffer.alloc(0)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(png.byteLength)
  process.stdout.write(header)
  if (png.byteLength) process.stdout.write(png)
}
