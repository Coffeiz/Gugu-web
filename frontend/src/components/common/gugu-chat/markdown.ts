import { marked, type Tokens } from 'marked'
import hljs from 'highlight.js'
import { i18n } from '@/i18n'
import { MIND_REF_TYPE_ICON_PATH } from '@/composables/mind/useMindEditor'
import type { ChatReference } from './chatTypes'

// Markdown 渲染器输出的是 HTML 字符串，不能直接挂载 Vue 图标组件；这里复用
// Remix Icon 的 path 数据，保持对象卡片和应用内 Icon 的视觉语义一致。
const CHAT_OBJECT_ICON_PATH: Record<string, string> = {
  project: 'M5.00098 5V19H19.001V5H5.00098ZM5.00098 3H19.001C20.1055 3 21.001 3.89543 21.001 5V19C21.001 20.1046 20.1055 21H5.00098C3.89641 21 3.00098 20.1046 3.00098 19V5C3.00098 3.89543 3.89641 3 5.00098 3ZM8.00098 7H10.001C10.5533 7 11.001 7.44772 11.001 8V16C11.001 16.5523 10.5533 17 10.001 17H8.00098C7.44869 17 7.00098 16.5523 7.00098 16V8C7.00098 7.44772 7.44869 7 8.00098 7ZM14.001 7H16.001C16.5533 7 17.001 7.44772 17.001 8V12C17.001 12.5523 16.5533 13 16.001 13H14.001C13.4487 13 13.001 12.5523 13.001 12V8C13.001 7.44772 13.4487 7 14.001 7Z',
  event: 'M9 1V3H15V1H17V3H21C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H7V1H9ZM20 11H4V19H20V11ZM11 13V17H6V13H11ZM7 5H4V9H20V5H17V7H15V5H9V7H7V5Z',
  canvas: 'M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM11 13H4V19H11V13ZM20 13H13V19H20V13ZM11 5H4V11H11V5ZM20 5H13V11H20V5Z',
  note: 'M20.0049 2C21.1068 2 22 2.89821 22 3.9908V20.0092C22 21.1087 21.1074 22 20.0049 22H4V18H2V16H4V13H2V11H4V8H2V6H4V2H20.0049ZM8 4H6V20H8V4ZM20 4H10V20H20V4Z',
  'scheduled-task': 'M12.0001 22.0001C7.02956 22.0001 3.00012 17.9707 3.00012 13.0001C3.00012 8.02956 7.02956 4.00012 12.0001 4.00012C16.9707 4.00012 21.0001 8.02956 21.0001 13.0001C21.0001 17.9707 16.9707 22.0001 12.0001 22.0001ZM12.0001 20.0001C15.8661 20.0001 19.0001 16.8661 19.0001 13.0001C19.0001 9.13412 15.8661 6.00012 12.0001 6.00012C8.13412 6.00012 5.00012 9.13412 5.00012 13.0001C5.00012 16.8661 8.13412 20.0001 12.0001 20.0001ZM13.0001 13.0001H16.0001V15.0001H11.0001V8.00012H13.0001V13.0001ZM1.74707 6.2826L5.2826 2.74707L6.69682 4.16128L3.16128 7.69682L1.74707 6.2826ZM18.7176 2.74707L22.2532 6.2826L20.839 7.69682L17.3034 4.16128L18.7176 2.74707Z',
}
const CHAT_OBJECT_TYPE_LABEL: Record<string, string> = {
  project: '项目', event: '活动', canvas: '画布', note: '笔记', 'scheduled-task': '定时任务',
}
const CHAT_SKILL_ICON_PATH = 'M12 2C6.477 2 2 6.477 2 12C2 17.523 6.477 22 12 22C17.523 22 22 17.523 22 12C22 6.477 17.523 2 12 2ZM12 4C16.418 4 20 7.582 20 12C20 16.418 16.418 20 12 20C7.582 20 4 16.418 4 12C4 7.582 7.582 4 12 4ZM11 7H13V11H17V13H13V17H11V13H7V11H11V7Z'
const CHAT_SKILL_LABEL = '技能'
const CHAT_PROJECT_ICON_PATH = 'M4 5V19H20V7H11.5858L9.58579 5H4ZM12.4142 5H21C21.5523 5 22 5.44772 22 6V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H10.4142L12.4142 5Z'
const CHAT_OBJECT_LINK_PATH = 'M13.0607 8.11097L14.4749 9.52518C17.2086 12.2589 17.2086 16.691 14.4749 19.4247L14.1214 19.7782C11.3877 22.5119 6.95555 22.5119 4.22188 19.7782C1.48821 17.0446 1.48821 12.6124 4.22188 9.87874L5.6361 11.293C3.68348 13.2456 3.68348 16.4114 5.6361 18.364C7.58872 20.3166 10.7545 20.3166 12.7072 18.364L13.0607 18.0105C15.0133 16.0578 15.0133 12.892 13.0607 10.9394L11.6465 9.52518L13.0607 8.11097ZM19.7782 14.1214L18.364 12.7072C20.3166 10.7545 20.3166 7.58872 18.364 5.6361C16.4114 3.68348 13.2456 3.68348 11.293 5.6361L10.9394 5.98965C8.98678 7.94227 8.98678 11.1081 10.9394 13.0607L12.3536 14.4749L10.9394 15.8891L9.52518 14.4749C6.79151 11.7413 6.79151 7.30911 9.52518 4.57544L9.87874 4.22188C12.6124 1.48821 17.0446 1.48821 19.7782 4.22188C22.5119 6.95555 22.5119 11.3877 19.7782 14.1214Z'

function chatObjectIcon(path: string, className: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${className}"><path d="${path}"/></svg>`
}

marked.use({
  breaks: true, gfm: true,
  renderer: (() => {
    const r = new marked.Renderer()
    const renderLink = r.link
    r.link = function (this: unknown, token: Tokens.Link) {
      const href = String(token.href || '')
      const match = href.match(/^gugu:\/\/open-object\/(project|event|canvas|note|scheduled-task)\/(\d+)$/i)
      if (!match) return renderLink.call(this, token)
      const type = match[1].toLowerCase()
      const id = match[2]
      const label = String(token.text || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
      const iconPath = type === 'project' ? CHAT_PROJECT_ICON_PATH : (CHAT_OBJECT_ICON_PATH[type] || CHAT_PROJECT_ICON_PATH)
      const typeLabel = CHAT_OBJECT_TYPE_LABEL[type] || '对象'
      return `<a class="chat-object-card" href="gugu://open-object/${type}/${id}" data-object-type="${type}" data-object-id="${id}" aria-label="${label}"><span class="chat-object-card-icon">${chatObjectIcon(iconPath, 'chat-object-card-icon-svg')}</span><span class="chat-object-card-body"><strong>${label}</strong><small>${typeLabel}</small></span><span class="chat-object-card-arrow">${chatObjectIcon(CHAT_OBJECT_LINK_PATH, 'chat-object-card-arrow-svg')}</span></a>`
    }
    const renderLinkAfterObject = r.link
    r.link = function (this: unknown, token: Tokens.Link) {
      const href = String(token.href || '')
      const match = href.match(/^gugu:\/\/open-skill\/([a-z0-9][a-z0-9-]{0,79})$/i)
      if (!match) return renderLinkAfterObject.call(this, token)
      const slug = match[1].toLowerCase()
      const label = String(token.text || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
      return `<a class="chat-object-card chat-skill-card" href="gugu://open-skill/${slug}" data-skill-slug="${slug}" aria-label="${label}"><span class="chat-object-card-icon">${chatObjectIcon(CHAT_SKILL_ICON_PATH, 'chat-object-card-icon-svg')}</span><span class="chat-object-card-body"><strong>${label}</strong><small>${CHAT_SKILL_LABEL}</small></span><span class="chat-object-card-arrow">${chatObjectIcon(CHAT_OBJECT_LINK_PATH, 'chat-object-card-arrow-svg')}</span></a>`
    }
    // 关掉删除线渲染：口语里 ~ 很常见（好的~、稍等~），~~ 叠出来会被 GFM 当删除线；
    // 伙伴语气几乎不需要真删除线，把 ~~x~~ 直接渲染成纯文本 x（保留表格等其它 GFM 能力）。
    r.del = (t: Tokens.Del) => (t && t.text) || ''
    r.code = ({ text, lang }: Tokens.Code) => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const label = lang || 'code'
      // 复制按钮不写内联 onclick——DOMPurify 会剥掉所有 on* 属性；改由 onChatActionClick 事件委托处理
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${label}</span><button class="md-copy-btn" type="button">${i18n.global.t('chatUi.copy')}</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
    }
    // 搜索结果图片经常来自有防盗链策略的站点。禁止携带聊天页面 Referer，避免图片
    // 在模型回复里只显示 alt 文本；其余 URL 仍交给聊天 HTML 的 DOMPurify 白名单清洗。
    const renderImage = r.image
    r.image = function (this: unknown, token: Tokens.Image) {
      return renderImage.call(this, token).replace(
        '<img ',
        '<img loading="lazy" decoding="async" referrerpolicy="no-referrer" ',
      )
    }
    return r
  })(),
})

// 兜底：模型有时把加粗小标题写成 `** 标题**`（** 后带空格 = 无效 md，不渲染加粗）。
// 在代码块/行内代码之外，把成对 ** 内侧紧邻的空格去掉，让它正常加粗（不碰代码里的 `x ** 2`）。
function fixLooseBold(text: string) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((seg, i) =>
    i % 2 ? seg
      : seg.replace(/\*\*[ \t]+([^*\n]+?)\*\*/g, '**$1**')
           .replace(/\*\*([^*\n]+?)[ \t]+\*\*/g, '**$1**')
  ).join('')
}

function normalizeTableLine(line: string) {
  return line.replace(/\\\|/g, '|').replace(/\|\\\s*$/, '|')
}

function isTableDelimiter(line: string) {
  const normalized = normalizeTableLine(line).trim()
  return /^\|?\s*:?-{3,}(?:\s*\|\s*:?-{3,})+\s*\|?$/.test(normalized)
}

// 有些模型为了把 Markdown 放进 JSON/富文本，会把表格竖线输出成 \\|。
// 只在已确认的“表头 + 分隔行”表格块内还原，避免破坏正文、代码和 URL 中的转义符。
function fixEscapedTablePipes(text: string) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes('|') || !isTableDelimiter(lines[index + 1])) continue
    // 模型偶尔会把标题和表头粘成“标题|列 1|列 2”。只有下一行已经确认是
    // 分隔行时才拆开，避免把普通含竖线的句子误判成表格。
    const firstPipe = lines[index].indexOf('|')
    let tableStart = index
    if (firstPipe > 0 && lines[index].slice(firstPipe).split('|').length >= 4) {
      const heading = lines[index].slice(0, firstPipe).trimEnd()
      const header = lines[index].slice(firstPipe)
      lines[index] = heading
      lines.splice(index + 1, 0, '', header)
      tableStart = index + 2
    }
    let row = tableStart
    while (row < lines.length && lines[row].trim() && lines[row].includes('|')) {
      lines[row] = normalizeTableLine(lines[row])
      row += 1
    }
    index = row - 1
  }
  return lines.join('\n')
}

function prepareMarkdown(text: string) {
  return fixLooseBold(fixEscapedTablePipes(text))
}

export function renderMd(text: string) { return text ? marked.parse(prepareMarkdown(text)) as string : '' }

function renderChatReference(reference: ChatReference, safeLabel: string) {
  const iconPath = MIND_REF_TYPE_ICON_PATH[reference.type] ?? ''
  return `<span class="mind-ref chat-reference" data-mind-ref="" data-ref-type="${reference.type}" data-ref-id="${reference.id}">` +
    `<svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" class="mind-ref-icon"><path d="${iconPath}"/></svg>` +
    `<span class="mind-ref-label">${safeLabel}</span></span>`
}

/** 聊天中的 @ 引用直接复用笔记 mind-ref 的结构、图标和样式契约。 */
export function renderChatMd(text: string, references: ChatReference[] = []) {
  let html = renderMd(text)
  for (const reference of references) {
    const label = reference.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const safeLabel = reference.label.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
    html = html.replace(new RegExp(`@${label}`, 'g'), renderChatReference(reference, safeLabel))
  }
  return html
}

/** 用户消息保持纯文本排版，仅把已选中的 @ 对象替换成可点击引用标签。 */
export function renderChatText(text: string, references: ChatReference[] = []) {
  let html = text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char)).replace(/\n/g, '<br>')
  for (const reference of references) {
    const label = reference.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const safeLabel = reference.label.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char))
    html = html.replace(new RegExp(`@${label}`, 'g'), renderChatReference(reference, safeLabel))
  }
  return html
}

// 流式渲染专用：补全未闭合的代码围栏，避免 marked 把半段代码块解析成残缺 HTML
// 单条缓存：同一帧内 text 未变则直接返回上次结果，避免重复解析
let _mdStreamCache: { text: string; html: string } | null = null
export function renderMdStream(text: string) {
  if (!text) return ''
  if (_mdStreamCache?.text === text) return _mdStreamCache.html
  const fences = (text.match(/^```/gm) || []).length
  const patched = fences % 2 === 1 ? text + '\n```' : text
  const html = marked.parse(prepareMarkdown(patched)) as string
  _mdStreamCache = { text, html }
  return html
}
