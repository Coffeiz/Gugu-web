import { Resvg } from '@resvg/resvg-js'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { createHTMLWindow } from 'svgdom'

const MAX_SOURCE_CHARS = 20_000
const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_DIMENSION = 2_048
const MAX_PIXELS = 2_000_000
const MAX_PNG_BYTES = 3 * 1024 * 1024
const FORBIDDEN_SVG_ELEMENTS = new Set([
  'a', 'animate', 'animatemotion', 'animatetransform', 'audio', 'foreignobject',
  'iframe', 'image', 'script', 'set', 'video',
])

const input = await new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  process.stdin.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_SOURCE_CHARS * 4 * 3 + 1024) {
      reject(new Error('input_too_large'))
      process.stdin.destroy()
      return
    }
    chunks.push(chunk)
  })
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  process.stdin.on('error', reject)
})

const sources = JSON.parse(input)
if (
  !Array.isArray(sources) || sources.length > 3 ||
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

const { default: mermaid } = await import('mermaid')
mermaid.initialize({
  startOnLoad: false,
  // 输出只会进入 Resvg，不会作为 SVG 回传浏览器；对 Mermaid loose 模式产生的
  // SVG 做严格元素/属性校验，拒绝链接、脚本、动画、HTML 与外部资源。
  securityLevel: 'loose',
  htmlLabels: false,
  suppressErrorRendering: true,
  maxTextSize: MAX_SOURCE_CHARS,
  maxEdges: 1_000,
  secure: [
    'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering',
    'maxEdges', 'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'flowchart',
  ],
  theme: 'base',
  themeVariables: {
    background: '#ffffff',
    primaryColor: '#f3f1f5',
    primaryTextColor: '#28242b',
    primaryBorderColor: '#8073aa',
    lineColor: '#8073aa',
    secondaryColor: '#e8e3f2',
    tertiaryColor: '#ffffff',
    fontFamily: 'sans-serif',
  },
})

for (let index = 0; index < sources.length; index += 1) {
  let png = Buffer.alloc(0)
  try {
    const { svg } = await mermaid.render(`gugu-${process.pid}-${index}`, sources[index])
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
    png = new Resvg(validatedSvg).render().asPng()
    if (png.byteLength > MAX_PNG_BYTES) throw new Error('png_too_large')
  } catch {
    png = Buffer.alloc(0)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(png.byteLength)
  process.stdout.write(header)
  if (png.byteLength) process.stdout.write(png)
}
