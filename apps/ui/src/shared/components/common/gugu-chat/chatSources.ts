import { sanitizeChatHtml } from '@/utils/markdown'

export interface ChatSource {
  url: string
  site: string
  title: string
  summary: string
  date: string
  icon?: string
  needsSiteName?: boolean
}

function sourceIcon(url: URL) {
  const { hostname, port } = url
  if (port || !/\.[a-z][a-z0-9-]*$/i.test(hostname) || /\.(local|localhost|internal|lan|home|test|invalid|example)$/i.test(hostname)) return
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(hostname)}.ico`
}

function sourceUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 4096) return
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url
  } catch { /* 忽略无效来源地址 */ }
}

function field(row: Record<string, unknown>, keys: string[], limit: number) {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, limit)
  }
  return ''
}

function sourceSite(row: Record<string, unknown>, url: URL) {
  const hostname = url.hostname.replace(/^www\./, '').replace(/\.$/, '')
  const publisher = row.publisher
  const publisherName = publisher && typeof publisher === 'object' && !Array.isArray(publisher)
    ? field(publisher as Record<string, unknown>, ['name'], 60)
    : field(row, ['publisher'], 60)
  const name = field(row, ['site_name', 'siteName', 'og:site_name', 'source_name'], 60) ||
    publisherName || field(row, ['website', 'media'], 60)
  if (name && !sourceUrl(name) && !/^[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(name))
    return { site: name }
  return { site: hostname, needsSiteName: true }
}

export function readChatSources(result: unknown): ChatSource[] {
  if (typeof result === 'string' && result.length <= 128_000) {
    try { result = JSON.parse(result) } catch { return [] }
  }
  const sources = new Map<string, ChatSource>()
  function visit(value: unknown, depth: number) {
    if (depth > 8 || sources.size >= 40 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.slice(0, 40).forEach(item => visit(item, depth + 1))
      return
    }
    const row = value as Record<string, unknown>
    const url = sourceUrl(field(row, ['url', 'link', 'source_url', 'detail_url'], 4097))
    const title = field(row, ['title', 'headline', 'page_title', 'name'], 200)
    const summary = field(row, ['snippet', 'content', 'description', 'summary', 'abstract'], 400)
    if (url && (title || summary) && !sources.has(url.href)) {
      sources.set(url.href, {
        url: url.href, title, summary,
        ...sourceSite(row, url),
        date: field(row, ['published_date', 'publishedDate', 'publish_date', 'published_at', 'date'], 40),
        icon: sourceIcon(url),
      })
    }
    Object.values(row).slice(0, 40).forEach(item => visit(item, depth + 1))
  }
  visit(result, 0)
  return [...sources.values()]
}

const chatSourceLabel = /^\s*(?:(?:以下(?:是|为)|下列(?:是|为))\s*)?(?:(?:本次新增)?(?:主要|参考|数据|信息|引用|一手)?来源(?:\s*(?:与|及|和)\s*(?:不确定性|口径)(?:说明)?)?|参考(?:链接|资料)|(?:Data\s+)?Sources?)(?:\s*[（(][^\n（）()]{1,80}[）)])?\s*(?:[:：]|$)/iu

export function decorateChatSources(html: string, sources: readonly ChatSource[]) {
  const groups: ChatSource[][] = []
  const root = document.createElement('div')
  root.innerHTML = sanitizeChatHtml(html)
  for (const element of root.querySelectorAll('[data-chat-source], .chat-source-pill')) {
    element.removeAttribute('data-chat-source')
    element.classList.remove('chat-source-pill')
  }
  const sourceBlocks = new Set<Element>()
  for (const label of root.querySelectorAll('p, h1, h2, h3, h4, h5, h6')) {
    const text = label.textContent ?? ''
    const standaloneHeading = label.tagName !== 'P' && !`${text}：`.replace(chatSourceLabel, '').trim()
    if (!standaloneHeading && !chatSourceLabel.test(text)) continue
    const next = label.nextElementSibling
    if (next?.matches('ul, ol') || (next?.matches('p') && (standaloneHeading || !text.replace(chatSourceLabel, '').trim())
      && next.firstElementChild?.matches('a[href]') && (next.firstChild === next.firstElementChild || !next.firstChild?.textContent?.trim())))
      sourceBlocks.add(next)
  }
  const byUrl = new Map(sources.map(source => [source.url, source]))
  // 同路径的查询参数可能指向不同内容。仅复用胶囊外观，摘要和标题仍以精确匹配为准。
  const pathsWithQuery = new Set(sources.flatMap(source => {
    const url = sourceUrl(source.url)
    return url?.search ? [url.origin + url.pathname] : []
  }))
  function withLinkTitle(source: ChatSource, anchor: Element): ChatSource {
    const label = (anchor.textContent ?? '').trim()
    const title = source.title
    const hostname = new URL(source.url).hostname
    const meaningful = (value: string) => value && value !== source.site &&
      value.replace(/^www\./i, '').toLowerCase() !== hostname.replace(/^www\./i, '') && !sourceUrl(value)
    if (meaningful(title)) return source
    return { ...source, title: meaningful(label) ? label.slice(0, 200) : '' }
  }
  function inSourceColumn(anchor: Element) {
    const cell = anchor.closest<HTMLTableCellElement>('td')
    const table = cell?.closest('table')
    const header = cell && table?.tHead?.rows[0]?.cells[cell.cellIndex]
    return Boolean(header && /^(?:出处|(?:(?:参考|数据|信息|引用)\s*)?来源|(?:data\s+)?sources?|references?)[:：]?$/iu
      .test(header.textContent?.trim() ?? ''))
  }

  function match(anchor: Element | null) {
    if (anchor?.tagName !== 'A' || anchor.closest('pre, code') || anchor.querySelector('img')) return
    const url = sourceUrl(anchor.getAttribute('href'))
    if (!url) return
    const exact = byUrl.get(url.href)
    if (exact) return exact
    const paragraph = anchor.closest('p, li')
    const inSourceParagraph = paragraph && chatSourceLabel.test(paragraph.textContent ?? '')
    const matchesKnownPath = !url.search && !url.hash && pathsWithQuery.has(url.origin + url.pathname)
    const list = anchor.closest('ul, ol')
    const inSourceBlock = (paragraph && sourceBlocks.has(paragraph)) || (list && sourceBlocks.has(list))
    const attribution = anchor.closest('blockquote')
      && anchor.previousSibling?.nodeType === Node.TEXT_NODE
      && /(?:^|\n)\s*(?:——|—|–|--|[-–—]{2,})\s*$/u.test(anchor.previousSibling.textContent ?? '')
    const previous = anchor.previousSibling
    const next = anchor.nextSibling
    const parentheticalCitation = paragraph
      && previous?.nodeType === Node.TEXT_NODE && next?.nodeType === Node.TEXT_NODE
      && /（\s*$/u.test(previous.textContent ?? '') && /^\s*）/u.test(next.textContent ?? '')
    const asciiParentheticalCitation = paragraph
      && previous?.nodeType === Node.TEXT_NODE && next?.nodeType === Node.TEXT_NODE
      && /\(\s*$/u.test(previous.textContent ?? '') && /^\s*\)/u.test(next.textContent ?? '')
    if (!inSourceParagraph && !inSourceBlock && !matchesKnownPath && !inSourceColumn(anchor)
      && !attribution && !parentheticalCitation && !asciiParentheticalCitation) return
    return { url: url.href, site: url.hostname, title: '', summary: '', date: '', icon: sourceIcon(url) }
  }
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!root.contains(anchor)) continue
    const matched = match(anchor)
    if (!matched) continue
    const first = withLinkTitle(matched, anchor)
    const group = [first]
    let sibling = anchor.nextSibling
    while (sibling) {
      const separator = sibling.nodeType === Node.TEXT_NODE && !sibling.textContent?.trim() ? sibling : null
      const candidate = (separator ? separator.nextSibling : sibling) as Element | null
      const source = match(candidate)
      if (!source || !candidate) break
      if (!group.some(item => item.url === source.url)) group.push(withLinkTitle(source, candidate))
      sibling = candidate.nextSibling
      candidate.remove()
      separator?.parentNode?.removeChild(separator)
    }
    anchor.dataset.chatSource = String(groups.push(group) - 1)
    anchor.classList.add('chat-source-pill')
    const label = document.createElement('span')
    label.className = 'chat-source-title'
    const linkLabel = anchor.textContent?.trim()
    label.textContent = linkLabel && !sourceUrl(linkLabel) ? linkLabel : first.site
    const icon = document.createElement('span')
    icon.className = 'chat-source-icon'
    icon.setAttribute('aria-hidden', 'true')
    if (first.icon) {
      const image = document.createElement('img')
      image.alt = ''
      image.loading = 'lazy'
      image.decoding = 'async'
      image.referrerPolicy = 'no-referrer'
      image.src = first.icon
      icon.append(image)
    }
    anchor.replaceChildren(icon, label)
    if (group.length > 1) {
      const count = document.createElement('span')
      count.className = 'chat-source-count'
      count.textContent = ` +${group.length - 1}`
      anchor.append(count)
    }
    if (group.length > 1) anchor.setAttribute('aria-haspopup', 'dialog')
  }
  return { html: root.innerHTML, groups }
}
