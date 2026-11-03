import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { createHTMLWindow } from 'svgdom'
import MathJax from 'mathjax'
import { normalizeMermaidEdgeLabelBounds, normalizeMermaidEdgeStyles, normalizeMermaidKanbanSectionColors, normalizeMermaidKanbanSectionTitles, normalizeMermaidMindmapRootLabel, normalizeMermaidNodeCorners, normalizeMermaidRasterColors, normalizeMermaidRasterText, normalizeMermaidRasterTextContrast, normalizeMermaidStateDiagramLabelAlignment, normalizeMermaidTimelineSectionColors } from './svg-style.mjs'
import { calculateMathRasterDimensions, calculateMermaidRasterDimensions } from './raster-dimensions.mjs'
import { prepareMermaidDiagramSource, restoreMermaidDiagramLabels } from './diagram-source.mjs'
import { createMermaidThemeConfig, resolveMermaidThemeColors } from './theme.mjs'

const MAX_SOURCE_CHARS = 20_000
const MAX_CHARTS = 4
const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_PNG_BYTES = 3 * 1024 * 1024
const MATH_IMAGE_PADDING = 16
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
    if (size > MAX_SOURCE_CHARS * MAX_CHARTS * 4 + 1024) {
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
const charts = Array.isArray(request) ? request.map((source) => ({ type: 'mermaid', source })) : request?.charts
const colors = resolveMermaidThemeColors(Array.isArray(request) ? {} : request?.theme)
if (
  !Array.isArray(charts) || charts.length > MAX_CHARTS ||
  charts.some((chart) => !chart || !['mermaid', 'math'].includes(chart.type)
    || typeof chart.source !== 'string' || !chart.source || chart.source.length > MAX_SOURCE_CHARS)
) throw new Error('input_too_large')

let mathJaxPromise
if (charts.some((chart) => chart.type === 'math')) {
  // 初始化时还没有安装 Mermaid 所需的 svgdom 全局 window/document。MathJax
  // 在 Node 环境应使用自己的 lite adaptor，避免误选浏览器启动路径。
  mathJaxPromise = (async () => {
    await MathJax.init({
      loader: { load: ['input/tex', 'output/svg'] },
      startup: { typeset: false },
      tex: { packages: ['base', 'ams'], maxBuffer: MAX_SOURCE_CHARS, maxMacros: 500 },
      svg: { fontCache: 'none' },
    })
    return MathJax
  })()
  await mathJaxPromise
}

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
// Mermaid 12.1 的 block 布局会 JSON.stringify 尺寸对象，其中保留了 D3 selection。
// 浏览器原生 DOM 节点没有可枚举的循环引用字段；svgdom 会枚举 ownerDocument，导致循环引用异常。
// 让 svgdom 节点按浏览器节点的 JSON 行为序列化，供 Mermaid 内部诊断字符串使用。
if (window.Node?.prototype && typeof window.Node.prototype.toJSON !== 'function') {
  Object.defineProperty(window.Node.prototype, 'toJSON', {
    configurable: true,
    value() {
      return {}
    },
  })
}
// svgdom 的 getBBox 会漏算 flowchart 多行标签的行高，也会低估中文字符宽度，导致节点过窄；
// Resvg 再按完整字体绘制时，文字会穿出节点。测量阶段补齐行高和中文宽度，让 Mermaid 同步调整布局。
const originalGetTextBBox = window.SVGGraphicsElement.prototype.getBBox
const fullWidthTextCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u
function estimateRasterTextWidth(text, fontSize) {
  return [...text].reduce((width, character) => {
    if (fullWidthTextCharacter.test(character)) return width + fontSize
    if (/\s/u.test(character)) return width + fontSize * 0.33
    if (/[ilI.,:;'|!]/u.test(character)) return width + fontSize * 0.32
    if (/[MW@%]/u.test(character)) return width + fontSize * 0.85
    if (character === '→') return width + fontSize * 0.95
    return width + fontSize * 0.56
  }, 0)
}
// Mermaid Kanban 在逐词拆行时会直接测量内层 tspan。svgdom 的原始字宽不含中文字宽，
// 导致混排项目名在计算阶段被判断为可放进单行，最终光栅化后溢出卡片。
const textContentPrototype = window.SVGTextContentElement?.prototype
const originalGetComputedTextLength = textContentPrototype?.getComputedTextLength
if (textContentPrototype && typeof originalGetComputedTextLength === 'function') {
  Object.defineProperty(textContentPrototype, 'getComputedTextLength', {
    configurable: true,
    value() {
      const originalWidth = originalGetComputedTextLength.call(this)
      const text = this.textContent || ''
      if (![...text].some(character => fullWidthTextCharacter.test(character))) return originalWidth
      const fontSize = Number.parseFloat(window.getComputedStyle(this).fontSize || '16') || 16
      return Math.max(originalWidth, estimateRasterTextWidth(text, fontSize))
    },
  })
}
function getIshikawaTextAnchor(element) {
  const classes = ` ${element.getAttribute('class') || ''} `
  if (classes.includes(' ishikawa-head-label ') || classes.includes(' ishikawa-label cause ')) return 'middle'
  return classes.includes(' ishikawa-label ') ? 'end' : null
}

function expandTextBounds(bounds, width, textAnchor, anchorX) {
  let x = bounds.x
  if (Number.isFinite(anchorX)) {
    if (textAnchor === 'middle') x = anchorX - width / 2
    else if (textAnchor === 'end') x = anchorX - width
    else x = anchorX
  } else if (textAnchor === 'middle') {
    x = bounds.x + bounds.width / 2 - width / 2
  } else if (textAnchor === 'end') {
    x = bounds.x + bounds.width - width
  }
  return { ...bounds, x, left: x, width, right: x + width }
}

function getIshikawaTextBounds(element, bounds, width) {
  const textAnchor = getIshikawaTextAnchor(element)
  if (!textAnchor) return null
  const attributeAnchor = Number.parseFloat(element.getAttribute('x') || '')
  const lineAnchor = [...element.getElementsByTagName('tspan')]
    .map(line => Number.parseFloat(line.getAttribute('x') || ''))
    .find(Number.isFinite)
  const anchorX = Number.isFinite(attributeAnchor) ? attributeAnchor : lineAnchor
  return Number.isFinite(anchorX) ? expandTextBounds(bounds, width, textAnchor, anchorX) : null
}

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
      ? Math.max(...lines.map(line => estimateRasterTextWidth(line, fontSize)))
      : bounds.width
    const height = positionedLines.length >= 2 ? positionedLines.length * fontSize * 1.1 : bounds.height
    // 鱼骨图把 text-anchor 写在 SVG 样式表里，svgdom 的 getBBox 看不到该 CSS；
    // 它会把居中/右对齐标签当成从 x 起绘制，错误计算鱼头位置、骨刺间距和 viewBox。
    const width = Math.max(bounds.width, measuredWidth)
    const ishikawaBounds = getIshikawaTextBounds(this, bounds, width)
    if (measuredWidth <= bounds.width && height <= bounds.height && !ishikawaBounds) return bounds
    return {
      ...(ishikawaBounds || expandTextBounds(
        bounds,
        width,
        this.getAttribute('text-anchor') || this.style?.textAnchor || 'start',
        NaN,
      )),
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

async function renderMathSvg(source) {
  const mathJax = await mathJaxPromise
  const container = await mathJax.tex2svgPromise(source, { display: true })
  const svg = mathJax.startup.adaptor.firstChild(container)
  if (!svg || mathJax.startup.adaptor.kind(svg) !== 'svg') throw new Error('svg_dimensions_missing')
  return mathJax.startup.adaptor.outerHTML(svg)
}

function getSvgViewBoxDimensions(root) {
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite)) {
    throw new Error('svg_dimensions_missing')
  }
  const [, , width, height] = viewBox
  if (width < 1 || height < 1) throw new Error('svg_dimensions_missing')
  return viewBox
}

function addMathImagePadding(root, padding) {
  const [x, y, width, height] = getSvgViewBoxDimensions(root)
  root.setAttribute(
    'viewBox',
    `${x - padding} ${y - padding} ${width + padding * 2} ${height + padding * 2}`,
  )
  return { width: width + padding * 2, height: height + padding * 2 }
}

for (let index = 0; index < charts.length; index += 1) {
  let png = Buffer.alloc(0)
  const chart = charts[index]
  const chartType = chart.type
  const prepared = chartType === 'mermaid'
    ? prepareMermaidDiagramSource(chart.source, { forRasterizer: true })
    : { source: chart.source, labels: [] }
  const source = prepared.source
  const type = chartType === 'mermaid' ? diagramType(source) : 'math'
  try {
    let svg
    if (chartType === 'math') {
      svg = await renderMathSvg(source)
    } else {
      try {
        ({ svg } = await mermaid.render(`gugu-${process.pid}-${index}`, source))
      } catch {
        throw new Error('diagram_parse_or_render_failed')
      }
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
    if (chartType === 'mermaid') {
      normalizeMermaidStateDiagramLabelAlignment(root)
      normalizeMermaidMindmapRootLabel(root)
      restoreMermaidDiagramLabels(root, prepared.labels)
      normalizeMermaidNodeCorners(root)
      if (type === 'kanban') {
        normalizeMermaidKanbanSectionColors(root)
        normalizeMermaidKanbanSectionTitles(root)
      }
      if (type === 'timeline' || type === 'timeline-beta') normalizeMermaidTimelineSectionColors(root)
      normalizeMermaidEdgeLabelBounds(root)
      normalizeMermaidRasterColors(root)
      normalizeMermaidRasterText(root, colors.primaryTextColor, {
        allText: true,
        fontFamily: 'Noto Sans SC',
        fontWeight: type === 'ishikawa-beta' ? 700 : 600,
        strokeWidth: type === 'ishikawa-beta' ? '0.6px' : '0.4px',
        colorAllText: type === 'sequencediagram' || type === 'journey',
        strokeAllText: true,
      })
      // 时序图和 Journey 的全部文字已经按图表主题强制着色。对比度修正会
      // 从外层 SVG 分组猜背景色，可能把参与者标题误判为深色底并覆盖成白字。
      if (type !== 'sequencediagram' && type !== 'journey') {
        normalizeMermaidRasterTextContrast(root, colors.primaryTextColor)
      }
      normalizeMermaidEdgeStyles(root, colors.arrowheadColor)
    } else {
      root.setAttribute('color', colors.primaryTextColor)
    }
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

    let dimensions
    if (chartType === 'math') {
      dimensions = addMathImagePadding(root, MATH_IMAGE_PADDING)
    } else {
      const viewBox = getSvgViewBoxDimensions(root)
      dimensions = { width: viewBox[2], height: viewBox[3] }
    }
    const width = Math.ceil(dimensions.width)
    const height = Math.ceil(dimensions.height)
    // 保留 viewBox 坐标系，只增大 SVG 根元素的输出尺寸，让 Resvg 直接按矢量内容
    // 栅格化；Mermaid 按 2x 输出，公式按原始尺寸输出，均受边长和像素预算约束。
    const { width: rasterWidth, height: rasterHeight } = chartType === 'math'
      ? calculateMathRasterDimensions(width, height)
      : calculateMermaidRasterDimensions(width, height)
    root.setAttribute('width', String(rasterWidth))
    root.setAttribute('height', String(rasterHeight))
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
      `CHART_RENDER_FAILURE index=${index} type=${type} reason=${reason}\n`,
    )
    png = Buffer.alloc(0)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(png.byteLength)
  process.stdout.write(header)
  if (png.byteLength) process.stdout.write(png)
}
