import { parse, parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

const tags = new Set('a b blockquote br code div em h1 h2 h3 img hr i li ol p pre span strong table tbody td th thead tr u ul'.split(' '))
const blocked = new Set('head title script style iframe object embed svg math template noscript'.split(' '))
const empty = new Set(['br', 'hr', 'img'])
const attributes: Readonly<Record<string, readonly string[]>> = {
  div: ['bgcolor'],
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  table: ['role', 'width', 'cellpadding', 'cellspacing', 'align', 'bgcolor'],
  tr: ['bgcolor'],
  td: ['width', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
  th: ['width', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
}
const styles = new Set('background background-color border border-bottom border-left border-radius border-top color display color-scheme font-family font-size font-weight background-position background-repeat background-size height line-height margin max-height max-width object-fit overflow padding text-align text-decoration width filter'.split(' '))
const readingStyles = new Set('position top right bottom left z-index opacity vertical-align min-width min-height letter-spacing border-spacing border-collapse table-layout margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left'.split(' '))
const color = /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,% /+-]+\)|transparent|none)$/iu
const border = /^(?:0|[\d.]+px)\s+(?:solid|dashed)\s+(?:#[0-9a-f]{3,8}|rgba?\([\d.,% /+-]+\)|transparent)$/iu
const safeFunctions = new Set(['rgb', 'rgba', 'brightness', 'contrast', 'grayscale', 'saturate', 'opacity'])

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

function sanitizeStyle(value: string, reading = false): string {
  return value.split(';').flatMap(declaration => {
    const colon = declaration.indexOf(':')
    if (colon < 1) return []
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const raw = declaration.slice(colon + 1).trim()
    if ((!styles.has(name) && !(reading && readingStyles.has(name))) || !raw || /[{}<>\\@\p{Cc}\p{Cf}]|\/\*|url\s*\(|expression|behavior|-moz-binding/iu.test(raw)) return []
    if ([...raw.matchAll(/([\w-]+)\s*\(/gu)].some(match => !safeFunctions.has(match[1]!.toLowerCase()))) return []
    if (name === 'position' && !/^(?:static|relative|absolute)$/iu.test(raw)) return []
    if (['color', 'background', 'background-color'].includes(name) && !color.test(raw)) return []
    if (['border', 'border-bottom', 'border-left', 'border-top'].includes(name) && !border.test(raw)) return []
    return [`${name}:${raw}`]
  }).join(';')
}

function safeAttribute(tag: string, name: string, value: string, reading = false): string | null {
  if (name === 'style') return sanitizeStyle(value, reading) || null
  if (!attributes[tag]?.includes(name)) return null
  if (name === 'href' && (!/^(?:https?:\/\/|mailto:)/iu.test(value) || /[\p{Cc}\p{Cf}]/u.test(value))) return null
  if (name === 'src' && !/^cid:[A-Za-z0-9._-]+$/iu.test(value)) return null
  if (name === 'bgcolor') return color.test(value.trim()) ? value.trim() : null
  if (['colspan', 'rowspan'].includes(name) && !/^[1-9]\d?$/u.test(value)) return null
  if (name === 'role' && value.toLowerCase() !== 'presentation') return null
  if (['align', 'valign'].includes(name) && !/^(?:left|center|right|top|middle|bottom)$/iu.test(value)) return null
  if (['width', 'height', 'cellpadding', 'cellspacing'].includes(name) && !/^\d{1,4}%?$/u.test(value.trim())) return null
  return value
}

function remoteImageUrl(value: string): string | undefined {
  if (!/^https:\/\//iu.test(value) || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return url.href
  } catch { /* 无效地址不保留。 */ }
}

function mailBackground(element: DefaultTreeAdapterTypes.Element): string | undefined {
  const inline = element.attrs.find(attr => attr.name === 'style')?.value ?? ''
  const url = /(?:^|;)\s*background(?:-image)?\s*:\s*[^;]*?url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)'"]+))\s*\)/iu.exec(inline)
  const raw = url?.[1] ?? url?.[2] ?? url?.[3] ?? element.attrs.find(attr => attr.name === 'background')?.value
  return raw ? remoteImageUrl(raw) : undefined
}

function isMailTrackingPixel(node: DefaultTreeAdapterTypes.Element): boolean {
  const inline = node.attrs.find(attr => attr.name === 'style')?.value ?? ''
  const dimension = (name: 'width' | 'height') => {
    const css = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([01])(?:px)?\\s*(?:!important\\s*)?(?:;|$)`, 'i').exec(inline)
    const attr = node.attrs.find(attr => attr.name === name)?.value.trim()
    return Boolean(css || attr && /^[01](?:px)?$/i.test(attr))
  }
  return dimension('width') && dimension('height')
}

/** 解析 HTML 后仅重建邮件安全子集，不保留原始标记或远程图片。 */
export function sanitizeEmailHtml(input: string, preserveRemoteImages = false): string {
  // 完整邮件的 head 由文档解析器处理，避免把 title 当成正文文本。
  const document = preserveRemoteImages ? parse(input) : undefined
  const html = document?.childNodes.find(node => node.nodeName === 'html') as DefaultTreeAdapterTypes.Element | undefined
  const body = html?.childNodes.find(node => node.nodeName === 'body') as DefaultTreeAdapterTypes.Element | undefined
  const root = body ?? parseFragment(input)
  const output: string[] = []
  if (body) {
    const style = sanitizeStyle(body.attrs.find(attr => attr.name === 'style')?.value ?? '', true)
    const background = safeAttribute('div', 'bgcolor', body.attrs.find(attr => attr.name === 'bgcolor')?.value ?? '')
    const presentation = [background && `background-color:${background}`, style].filter(Boolean).join(';')
    const backgroundImage = mailBackground(body)
    if (presentation || backgroundImage)
      output.push(`<div${presentation ? ` style="${escape(presentation)}"` : ''}${backgroundImage ? ` data-mail-background="${escape(backgroundImage)}"` : ''}>`)
  }
  const wrapped = output.length > 0
  const stack: Array<DefaultTreeAdapterTypes.ChildNode | string> = [...root.childNodes].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (typeof node === 'string') { output.push(node); continue }
    if ('value' in node && node.nodeName === '#text') { output.push(escape(node.value)); continue }
    if (!('tagName' in node) || blocked.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
    const tag = node.tagName
    if (preserveRemoteImages && tag === 'img' && isMailTrackingPixel(node)) continue
    if (tags.has(tag)) {
      const attrs = node.attrs.flatMap(attr => {
        if (attr.namespace || attr.prefix) return []
        if (preserveRemoteImages && tag === 'img' && attr.name === 'src') {
          const url = remoteImageUrl(attr.value)
          if (url) return [` data-mail-image="${escape(url)}"`]
        }
        const value = safeAttribute(tag, attr.name, attr.value, preserveRemoteImages)
        return value === null ? [] : [` ${attr.name}="${escape(value)}"`]
      })
      const background = preserveRemoteImages && ['div', 'table', 'td', 'th'].includes(tag) ? mailBackground(node) : undefined
      if (background) attrs.push(` data-mail-background="${escape(background)}"`)
      output.push(`<${tag}${attrs.join('')}>`)
      if (!empty.has(tag)) stack.push(`</${tag}>`)
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!)
  }
  if (wrapped) output.push('</div>')
  return output.join('')
}
