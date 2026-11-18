import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

const tags = new Set('a b blockquote br code div em h1 h2 h3 img hr i li ol p pre span strong table tbody td th thead tr u ul'.split(' '))
const blocked = new Set('script style iframe object embed svg math template noscript'.split(' '))
const empty = new Set(['br', 'hr', 'img'])
const attributes: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  table: ['role', 'width', 'cellpadding', 'cellspacing', 'align'],
  td: ['width', 'align', 'valign'],
  th: ['width', 'align', 'valign'],
}
const styles = new Set('background background-color border border-bottom border-left border-radius border-top color display color-scheme font-family font-size font-weight height line-height margin max-height max-width object-fit overflow padding text-align text-decoration width filter'.split(' '))
const color = /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,% /+-]+\)|transparent|none)$/iu
const border = /^(?:0|[\d.]+px)\s+(?:solid|dashed)\s+(?:#[0-9a-f]{3,8}|rgba?\([\d.,% /+-]+\)|transparent)$/iu
const safeFunctions = new Set(['rgb', 'rgba', 'brightness', 'contrast', 'grayscale', 'saturate', 'opacity'])

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

function sanitizeStyle(value: string): string {
  // 拒绝 CSS 注释和转义，避免把 url 等关键字藏在不同的词法表示中。
  if (/[\\@]|\/\*|url\s*\(|expression|behavior|-moz-binding/iu.test(value)) return ''
  return value.split(';').flatMap(declaration => {
    const colon = declaration.indexOf(':')
    if (colon < 1) return []
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const raw = declaration.slice(colon + 1).trim()
    if (!styles.has(name) || !raw || /[{}<>\p{Cc}\p{Cf}]/u.test(raw)) return []
    if ([...raw.matchAll(/([\w-]+)\s*\(/gu)].some(match => !safeFunctions.has(match[1]!.toLowerCase()))) return []
    if (['color', 'background', 'background-color'].includes(name) && !color.test(raw)) return []
    if (['border', 'border-bottom', 'border-left', 'border-top'].includes(name) && !border.test(raw)) return []
    return [`${name}:${raw}`]
  }).join(';')
}

function safeAttribute(tag: string, name: string, value: string): string | null {
  if (name === 'style') return sanitizeStyle(value) || null
  if (!attributes[tag]?.includes(name)) return null
  if (name === 'href' && (!/^(?:https?:\/\/|mailto:)/iu.test(value) || /[\p{Cc}\p{Cf}]/u.test(value))) return null
  if (name === 'src' && !/^cid:[A-Za-z0-9._-]+$/iu.test(value)) return null
  if (name === 'role' && value.toLowerCase() !== 'presentation') return null
  if (['align', 'valign'].includes(name) && !/^(?:left|center|right|top|middle|bottom)$/iu.test(value)) return null
  if (['width', 'height', 'cellpadding', 'cellspacing'].includes(name) && !/^\d{1,4}%?$/u.test(value.trim())) return null
  return value
}

/** 解析 HTML 后仅重建邮件安全子集，不保留原始标记或远程图片。 */
export function sanitizeEmailHtml(input: string): string {
  const root = parseFragment(input)
  const output: string[] = []
  const stack: Array<DefaultTreeAdapterTypes.ChildNode | string> = [...root.childNodes].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (typeof node === 'string') { output.push(node); continue }
    if ('value' in node && node.nodeName === '#text') { output.push(escape(node.value)); continue }
    if (!('tagName' in node) || blocked.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue
    const tag = node.tagName
    if (tags.has(tag)) {
      const attrs = node.attrs.flatMap(attr => {
        if (attr.namespace || attr.prefix) return []
        const value = safeAttribute(tag, attr.name, attr.value)
        return value === null ? [] : [` ${attr.name}="${escape(value)}"`]
      })
      output.push(`<${tag}${attrs.join('')}>`)
      if (!empty.has(tag)) stack.push(`</${tag}>`)
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!)
  }
  return output.join('')
}
