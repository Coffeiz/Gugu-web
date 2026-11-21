import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { ProviderTransport } from '../providers/contracts.js'

type Node = DefaultTreeAdapterTypes.Node
type Egress = { withTransport<T>(signal: AbortSignal, execute: (transport: ProviderTransport) => Promise<T>): Promise<T> }
const maxBytes = 96 * 1024

function publicPage(input: unknown) {
  if (typeof input !== 'string' || input.length > 4096) return
  try {
    const url = new URL(input)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return
    url.search = ''
    url.hash = ''
    return url
  } catch { return undefined }
}

export function readCitationSiteName(html: string, homepage = false) {
  let site = ''
  let publisher = ''
  let application = ''
  let title = ''
  const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 64) : ''
  function readJson(value: unknown, depth = 0) {
    if (depth > 8 || !value || typeof value !== 'object' || publisher) return
    if (Array.isArray(value)) {
      value.slice(0, 32).forEach(item => readJson(item, depth + 1))
      return
    }
    const item = value as Record<string, unknown>
    const named = item.publisher
    if (named && typeof named === 'object') publisher = clean((named as Record<string, unknown>).name)
    if (!publisher && item['@type'] === 'WebSite') publisher = clean(item.name)
    if (!publisher) readJson(item['@graph'], depth + 1)
  }
  function visit(node: Node) {
    if ('tagName' in node) {
      const attr = (name: string) => node.attrs.find(item => item.name === name)?.value
      if (node.tagName === 'meta' && (attr('property') ?? attr('name'))?.toLowerCase() === 'og:site_name')
        site ||= clean(attr('content'))
      if (node.tagName === 'meta' && /^(?:application-name|apple-mobile-web-app-title)$/i.test(attr('name') ?? ''))
        application ||= clean(attr('content'))
      if (homepage && node.tagName === 'title')
        title ||= clean(node.childNodes.map(child => 'value' in child ? child.value : '').join(''))
      if (node.tagName === 'script' && attr('type')?.toLowerCase() === 'application/ld+json') {
        const text = node.childNodes.map(child => 'value' in child ? child.value : '').join('')
        try { readJson(JSON.parse(text)) } catch { /* 忽略无效结构化数据 */ }
      }
    }
    if ('childNodes' in node) node.childNodes.forEach(visit)
  }
  visit(parse(html))
  const homepageName = title.split(/\s+[-–—|]\s+|[_｜]/u)[0]?.trim()
  return site || publisher || application || (homepageName && homepageName.length <= 36 ? homepageName : null)
}

export function createCitationSiteLookup(egress: Egress) {
  const cache = new Map<string, { expires: number; result: Promise<string | null> }>()
  let active = 0
  return async (input: unknown): Promise<string | null> => {
    const page = publicPage(input)
    if (!page) return null
    const cached = cache.get(page.origin)
    if (cached && cached.expires > Date.now()) return cached.result
    if (active >= 4) return null
    active++
    const signal = AbortSignal.timeout(4500)
    const result = egress.withTransport(signal, async transport => {
      async function readPage(initial: URL) {
        let url = initial
        for (let hop = 0; hop <= 2; hop++) {
          const response = await transport.request({
            url: url.href, method: 'GET', timeoutMs: 4500, headers: { Accept: 'text/html' },
          }, signal)
          try {
            if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && hop < 2) {
              const target = publicPage(new URL(response.headers.location, url).href)
              if (!target) return null
              url = target
              continue
            }
            const type = response.headers['content-type'] ?? ''
            if (response.status < 200 || response.status >= 300 || !/^(text\/html|application\/xhtml\+xml)\b/i.test(type)) return null
            const chunks: Uint8Array[] = []
            let size = 0
            for await (const chunk of response.body) {
              const part = chunk.subarray(0, maxBytes - size)
              chunks.push(part)
              size += part.length
              if (size >= maxBytes) break
            }
            const bytes = Buffer.concat(chunks, size)
            const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] ??
              /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(bytes.toString('latin1'))?.[1] ?? 'utf-8'
            return readCitationSiteName(new TextDecoder(charset).decode(bytes), url.pathname === '/')
          } finally { await response.cancel() }
        }
        return null
      }
      const name = await readPage(page).catch(() => null)
      if (name || page.pathname === '/' || signal.aborted) return name
      return readPage(new URL('/', page))
    }).catch(() => null).finally(() => { active-- })
    const entry = { expires: Date.now() + 60_000, result }
    cache.delete(page.origin)
    cache.set(page.origin, entry)
    if (cache.size > 256) cache.delete(cache.keys().next().value!)
    void result.then(name => { if (name) entry.expires = Date.now() + 24 * 60 * 60_000 })
    return result
  }
}
