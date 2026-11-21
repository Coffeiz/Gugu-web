import type { Token, Tokens } from 'marked'
import { h, render, type Component } from 'vue'
import { resolveIcon } from '@/components/common/icons/iconRegistry'
import { i18n } from '@/i18n'
import { escapeHtml } from '@/utils/escapeHtml'
import { decodeMindFileReference } from '@/composables/mind/fileReference'
import { fileIconColor, fileListIcon } from '@/utils/fileTypes'

// Markdown 渲染器输出的是 HTML 字符串，不能直接挂载 Vue 图标组件；这里复用
// Remix Icon 的 path 数据，保持对象卡片和应用内 Icon 的视觉语义一致。
const CHAT_OBJECT_ICON_PATH: Record<string, string> = {
  event: 'M9 1V3H15V1H17V3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H7V1H9ZM20 11H4V19H20V11ZM11 13V17H6V13H11ZM7 5H4V9H20V5H17V7H15V5H9V7H7V5Z',
  canvas: 'M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM11 13H4V19H11V13ZM20 13H13V19H20V13ZM11 5H4V11H11V5ZM20 5H13V11H20V5Z',
  note: 'M20.0049 2C21.1068 2 22 2.89821 22 3.9908V20.0092C22 21.1087 21.1074 22 20.0049 22H4V18H2V16H4V13H2V11H4V8H2V6H4V2H20.0049ZM8 4H6V20H8V4ZM20 4H10V20H20V4Z',
  'scheduled-task': 'M12.0001 22.0001C7.02956 22.0001 3.00012 17.9707 3.00012 13.0001C3.00012 8.02956 7.02956 4.00012 12.0001 4.00012C16.9707 4.00012 21.0001 8.02956 21.0001 13.0001C21.0001 17.9707 16.9707 22.0001 12.0001 22.0001ZM12.0001 20.0001C15.8661 20.0001 19.0001 16.8661 19.0001 13.0001C19.0001 9.13412 15.8661 6.00012 12.0001 6.00012C8.13412 6.00012 5.00012 9.13412 5.00012 13.0001C5.00012 16.8661 8.13412 20.0001 12.0001 20.0001ZM13.0001 13.0001H16.0001V15.0001H11.0001V8.00012H13.0001V13.0001ZM1.74707 6.2826L5.2826 2.74707L6.69682 4.16128L3.16128 7.69682L1.74707 6.2826ZM18.7176 2.74707L22.2532 6.2826L20.839 7.69682L17.3034 4.16128L18.7176 2.74707Z',
}
const CHAT_SKILL_ICON_PATH = 'M12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2ZM12 4C16.418 4 20 7.582 20 12C20 16.418 16.418 20 12 20C7.582 20 4 16.418 4 12C4 7.582 7.582 4 12 4ZM11 7H13V11H17V13H13V17H11V13H7V11H11V7Z'
const CHAT_PROJECT_ICON_PATH = 'M4 5V19H20V7H11.5858L9.58579 5H4ZM12.4142 5H21C21.5523 5 22 5.44772 22 6V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H10.4142L12.4142 5Z'
const CHAT_OBJECT_LINK_PATH = 'M13.0607 8.11097L14.4749 9.52518C17.2086 12.2589 17.2086 16.691 14.4749 19.4247L14.1214 19.7782C11.3877 22.5119 6.95555 22.5119 4.22188 19.7782C1.48821 17.0446 1.48821 12.6124 4.22188 9.87874L5.6361 11.293C3.68348 13.2456 3.68348 16.4114 5.6361 18.364C7.58872 20.3166 10.7545 20.3166 12.7072 18.364L13.0607 18.0105C15.0133 16.0578 15.0133 12.892 13.0607 10.9394L11.6465 9.52518L13.0607 8.11097ZM19.7782 14.1214L18.364 12.7072C20.3166 10.7545 20.3166 7.58872 18.364 5.6361C16.4114 3.68348 13.2456 3.68348 11.293 5.6361L10.9394 5.98965C8.98678 7.94227 8.98678 11.1081 10.9394 13.0607L12.3536 14.4749L10.9394 15.8891L9.52518 14.4749C6.79151 11.7413 6.79151 7.30911 9.52518 4.57544L9.87874 4.22188C12.6124 1.48821 17.0446 1.48821 19.7782 4.22188C22.5119 6.95555 22.5119 11.3877 19.7782 14.1214Z'

function chatObjectIcon(path: string, className: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${className}"><path d="${path}"/></svg>`
}


type ObjectCard = { href: string; type: string; icon?: string; title: string; context: string; description?: string; badge?: string }

const cardIconMarkup = new Map<Component, string>()

function renderCardIcon(icon: Component) {
  if (typeof document === 'undefined') return ''
  const cached = cardIconMarkup.get(icon)
  if (cached !== undefined) return cached
  const host = document.createElement('span')
  render(h(icon, { size: '22' }), host)
  const svg = host.querySelector('svg')?.outerHTML ?? ''
  render(null, host)
  cardIconMarkup.set(icon, svg)
  return svg
}

function objectCard(href: string, title = '', description?: string): ObjectCard | undefined {
  const base = { href, title, description }
  const object = /^gugu:\/\/open-object\/(project|event|canvas|note|scheduled-task)\/(\d+)$/i.exec(href)
  if (object) {
    const type = object[1]!.toLowerCase()
    const context = i18n.global.t(`chatUi.objectCardTypes.${type}`)
    return { ...base, title: title || `${context} #${object[2]}`, href: `gugu://open-object/${type}/${object[2]}`, type,
      icon: CHAT_OBJECT_ICON_PATH[type] ?? CHAT_PROJECT_ICON_PATH, context }
  }
  const focus = /^gugu:\/\/focus-canvas\/(\d+)\/(\d+)$/i.exec(href)
  if (focus) {
    const context = i18n.global.t('chatUi.focusCanvasItem')
    return { ...base, title: title || `${context} #${focus[2]}`, href: `gugu://focus-canvas/${focus[1]}/${focus[2]}`, type: 'canvas',
      icon: CHAT_OBJECT_ICON_PATH.canvas!, context }
  }
  const skill = /^gugu:\/\/open-skill\/([SU][1-9][0-9]*)$/i.exec(href)
  if (skill) {
    const id = skill[1]!.toUpperCase()
    const builtin = id.startsWith('S')
    const metadata = builtin ? __BUILTIN_SKILL_CARDS__[id] : undefined
    const context = i18n.global.t('chatUi.objectCardTypes.skill')
    return { ...base, title: metadata?.name || title || (builtin ? context : id),
      description: metadata?.description || description, href: builtin ? '' : `gugu://open-skill/${id}`,
      type: 'skill', icon: CHAT_SKILL_ICON_PATH, context }
  }
  const file = /^gugu:\/\/open-object\/file\/((?:path|drop)-[A-Za-z0-9_-]{1,24000})$/.exec(href)
  if (file) {
    const name = decodeMindFileReference(file[1]!)?.relativePath.split('/').at(-1)
    const filename = name || base.title
    const dot = filename.lastIndexOf('.')
    const typeLabel = i18n.global.t('chatUi.objectCardTypes.file')
    const badge = dot > 0 && /^[a-z\d]{1,10}$/i.test(filename.slice(dot + 1)) ? filename.slice(dot + 1).toUpperCase() : undefined
    return { ...base, title: filename, type: 'file', context: typeLabel, badge }
  }
}

function renderCard(card: ObjectCard) {
  const title = escapeHtml(card.title || card.context)
  const icon = card.icon
    ? `<span class="chat-object-card-icon">${card.type === 'canvas'
        ? renderCardIcon(resolveIcon('canvas.graph'))
        : chatObjectIcon(card.icon, 'chat-object-card-icon-svg')}</span>` : ''
  const heading = card.type === 'file' ? '' : `<span class="chat-object-card-heading">${icon}
    <span class="chat-object-card-kind">${escapeHtml(card.context)}</span>
    <span class="chat-object-card-arrow">${chatObjectIcon(CHAT_OBJECT_LINK_PATH, 'chat-object-card-arrow-svg')}</span></span>`
  const description = card.description
    ? `<span class="chat-object-card-description">${escapeHtml(card.description)}</span>`
    : ''
  const titleMarkup = `<strong class="chat-object-card-title">${title}</strong>`
  let identity = titleMarkup
  if (card.type === 'file') {
    identity = `<span class="chat-object-file-identity">
      <span class="chat-object-file-icon" aria-hidden="true" style="--chat-file-icon-color:${fileIconColor(card.badge)}">${renderCardIcon(fileListIcon(card.badge))}</span>
      ${titleMarkup}
    </span>`
  }
  const action = card.href ? ` href="${escapeHtml(card.href)}"` : ''
  return `<a class="chat-object-card" data-object-type="${escapeHtml(card.type)}"${action} aria-label="${title}">
    ${heading}${identity}${description}
  </a>`
}

/** 仅将段落里独占一行的对象链接升级成卡片，正文和表格中的链接保留行内语义。 */
export function renderObjectCardParagraph(tokens: Token[], renderInline: (tokens: Token[]) => string) {
  const lines: Token[][] = [[]]
  for (const token of tokens) {
    if (token.type === 'br') lines.push([])
    else lines.at(-1)!.push(token)
  }
  const chunks = lines.map(line => {
    const content = line.filter(token => token.type !== 'text' || token.raw.trim())
    const [token] = content
    let card: ObjectCard | undefined
    if (content.length === 1 && token?.type === 'link') {
      const link = token as Tokens.Link
      if (!link.tokens.some(item => item.type === 'image'))
        card = objectCard(link.href, link.text.trim() === link.href ? '' : link.text.trim(), link.title?.trim())
    } else if (content.every(item => item.type === 'text')) {
      const address = content.map(item => item.raw).join('').trim()
      if (/^gugu:\/\//i.test(address)) card = objectCard(address)
    }
    return { line, card }
  })
  if (!chunks.some(chunk => chunk.card)) return undefined
  const blocks: string[] = []
  let inline: string[] = []
  let cards: string[] = []
  function flushInline() {
    if (inline.length) blocks.push(`<p>${inline.join('<br>')}</p>`)
    inline = []
  }
  function flushCards() {
    if (cards.length) blocks.push(`<div class="chat-object-cards${cards.length > 1 ? ' is-multiple' : ''}">${cards.join('')}</div>`)
    cards = []
  }
  for (const { line, card } of chunks) {
    if (card) { flushInline(); cards.push(renderCard(card)) }
    else { flushCards(); inline.push(renderInline(line)) }
  }
  flushInline()
  flushCards()
  return blocks.join('\n')
}

export function objectCardLoading(label: string, waitingForImageOnly = false) {
  const span = document.createElement('span')
  span.className = waitingForImageOnly ? 'chat-object-card-loading is-image-only' : 'chat-object-card-loading'
  span.setAttribute('role', 'status')
  span.textContent = label
  return span
}

/** 共用对象卡的只读字段，值以纯文本写入。 */
export function objectCardFact(label: string, value: string) {
  const fact = document.createElement('span')
  fact.className = 'chat-object-card-fact'
  const caption = document.createElement('span')
  caption.className = 'chat-object-card-fact-label'
  caption.textContent = label
  const field = document.createElement('span')
  field.className = 'chat-object-card-fact-value'
  field.textContent = value
  fact.append(caption, field)
  return fact
}
