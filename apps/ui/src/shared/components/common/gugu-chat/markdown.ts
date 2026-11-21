import { marked, type Tokens } from 'marked'
import { escapeHtml } from '@/utils/escapeHtml'
import hljs from 'highlight.js'
import { i18n } from '@/i18n'
import { MIND_REF_TYPE_ICON_PATH } from '@/composables/mind/useMindEditor'
import type { ChatReference } from './chatTypes'
import { renderObjectCardParagraph } from './chatObjectCards'
import { renderSmartView } from './chatSmartViews'
import { renderSmartStream } from './chatSmartStream'
import { sanitizeChatHtml } from '@/utils/markdown'
import { normalizeMarkdownMathSource, prepareLatexCodeForMath } from '@/utils/chart/math'

marked.use({
  breaks: true, gfm: true,
  renderer: (() => {
    const r = new marked.Renderer()
    const renderParagraph = r.paragraph
    r.paragraph = function (token: Tokens.Paragraph) {
      return renderObjectCardParagraph(token.tokens, tokens => this.parser.parseInline(tokens))
        ?? renderParagraph.call(this, token)
    }
    // 关掉删除线渲染：口语里 ~ 很常见（好的~、稍等~），~~ 叠出来会被 GFM 当删除线；
    // 伙伴语气几乎不需要真删除线，把 ~~x~~ 直接渲染成纯文本 x（保留表格等其它 GFM 能力）。
    r.del = (t: Tokens.Del) => (t && t.text) || ''
    r.code = ({ text, lang }: Tokens.Code) => {
      if (String(lang || '').trim() === 'gugu-ui') return renderSmartView(text)
      if (String(lang || '').trim() === 'gugu-ui-stream') return renderSmartStream(text)
      if (String(lang || '').trim().toLowerCase() === 'mermaid') {
        return `<pre class="md-mermaid-source"><code>${escapeHtml(text)}</code></pre>`
      }
      if (/^(?:latex|tex)$/i.test(String(lang || '').trim())) {
        const escaped = escapeHtml(text)
        const math = escapeHtml(prepareLatexCodeForMath(text))
        return `<div class="md-math-block"><div class="md-math-result">${math}</div><pre class="md-mermaid-source-view md-math-source-view" hidden><code>${escaped}</code></pre></div>`
      }
      // 没写语言或语言未注册时自动探测，而不是直接按 plaintext 放弃高亮；
      // 探测失败 hljs 内部会退回纯文本，不会抛错。
      // highlightAuto 是全语言扫描的主线程同步操作，超长代码块直接放弃探测，
      // 避免卡住渲染帧。
      const AUTO_DETECT_MAX_CHARS = 32_000
      const registered = lang && hljs.getLanguage(lang) ? lang : ''
      const canAutoDetect = !registered && text.length <= AUTO_DETECT_MAX_CHARS
      let highlighted: string
      let language: string
      let label: string
      if (registered) {
        language = registered
        label = registered
        highlighted = hljs.highlight(text, { language }).value
      } else if (canAutoDetect) {
        const result = hljs.highlightAuto(text)
        language = result.language || 'plaintext'
        // 标签与实际高亮语言保持一致：未注册/未写的语言名不能照抄。
        label = lang && result.language ? result.language : (lang || result.language || 'code')
        highlighted = result.value
      } else {
        language = 'plaintext'
        label = lang || 'code'
        // 超长块不探测，但内容仍要按纯文本转义输出（置空会整块消失）。
        highlighted = hljs.highlight(text, { language: 'plaintext' }).value
      }
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
  return normalizeMarkdownMathSource(fixLooseBold(fixEscapedTablePipes(text)))
}

export function renderMd(text: string) {
  if (!text) return ''
  const html = marked.parse(prepareMarkdown(text)) as string
  if (!html.includes('class="chat-object-cards') || typeof document === 'undefined') return html
  const output = document.createElement('template')
  output.innerHTML = html
  for (const group of output.content.querySelectorAll('.chat-object-cards')) {
    let next = group.nextElementSibling
    while (next?.classList.contains('chat-object-cards')) {
      group.append(...next.children)
      next.remove()
      group.classList.add('is-multiple')
      next = group.nextElementSibling
    }
  }
  return output.innerHTML
}

/** 从聊天专用 Markdown 中提取复制文本；HTML 解析前必须经过聊天白名单净化。 */
export function markdownToSafePlainText(html: string): string {
  const tmp = document.createElement('div')
  tmp.innerHTML = sanitizeChatHtml(html)
  return tmp.innerText || tmp.textContent || ''
}

function renderChatReference(reference: ChatReference, safeLabel: string) {
  const iconPath = MIND_REF_TYPE_ICON_PATH[reference.type] ?? ''
  return `<span class="mind-ref chat-reference" data-mind-ref="" data-ref-type="${escapeHtml(reference.type)}" data-ref-id="${escapeHtml(String(reference.id))}">` +
    `<svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor" class="mind-ref-icon"><path d="${iconPath}"/></svg>` +
    `<span class="mind-ref-label">${safeLabel}</span></span>`
}

/** 聊天中的 @ 引用直接复用笔记 mind-ref 的结构、图标和样式契约。
 *  用户消息与 AI 消息同走这条 MD 链路（sanitize 后），紫底气泡的配色差异
 *  由 .user-md 样式覆盖，不在这里分叉。 */
export function renderChatMd(text: string, references: ChatReference[] = []) {
  const byLabel = new Map<string, ChatReference>()
  for (const reference of references)
    if (reference.label && !byLabel.has(reference.label)) byLabel.set(reference.label, reference)
  if (!byLabel.size) return renderMd(text)
  function appendUnmentionedReferences(html: string, mentioned: readonly ChatReference[]) {
    const key = (reference: ChatReference) => JSON.stringify([reference.type, String(reference.id)])
    const rendered = new Set(mentioned.map(key))
    const chips: string[] = []
    for (const reference of references) {
      const identity = key(reference)
      if (!reference.label || rendered.has(identity)) continue
      rendered.add(identity)
      chips.push(renderChatReference(reference, escapeHtml(reference.label)))
    }
    return chips.length ? `${html}<p>${chips.join(' ')}</p>` : html
  }

  let marker = 'GUGUCHATREF'
  while (text.includes(marker)) marker += 'X'
  const labels = [...byLabel.keys()].sort((left, right) => right.length - left.length)
  const pattern = new RegExp(`@(${labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g')
  const matches: ChatReference[] = []
  const markdown = text.replace(pattern, (_match, label: string) => {
    matches.push(byLabel.get(label)!)
    return `${marker}${matches.length - 1}END`
  })
  const html = renderMd(markdown)
  if (!matches.length) return appendUnmentionedReferences(html, matches)

  // 标记只在 HTML 文本节点中转换成卡片。链接属性和代码中的标记还原为普通文字。
  const output = document.createElement('template')
  output.innerHTML = html
  const placeholders = new RegExp(`${marker}(\\d+)END`, 'g')
  const restore = (value: string) => value.replace(placeholders, (match, index: string) => {
    const reference = matches[Number(index)]
    return reference ? `@${reference.label}` : match
  })
  for (const element of output.content.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (attribute.value.includes(marker)) attribute.value = restore(attribute.value)
    }
  }
  const walker = document.createTreeWalker(output.content, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const part = node as Text
    if (part.data.includes(marker)) nodes.push(part)
  }
  for (const node of nodes) {
    if (node.parentElement?.closest('pre, code, script, style, textarea, a')) {
      node.data = restore(node.data)
      continue
    }
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (const match of node.data.matchAll(placeholders)) {
      const reference = matches[Number(match[1])]
      if (!reference) continue
      fragment.append(node.data.slice(offset, match.index))
      const chip = document.createElement('template')
      chip.innerHTML = renderChatReference(reference, escapeHtml(reference.label))
      fragment.append(chip.content)
      offset = match.index! + match[0].length
    }
    fragment.append(node.data.slice(offset))
    node.replaceWith(fragment)
  }
  return appendUnmentionedReferences(output.innerHTML, matches)
}

export function scanChatMarkdownFences(lines: string[]) {
  const smartRanges: { start: number; end: number }[] = []
  let offset = 0
  let smartStart = 0
  let openFence: { char: string; size: number; line: number; info: string } | null = null
  for (let index = 0; index < lines.length; offset += lines[index++].length + 1) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index])
    if (!match) continue
    const marker = match[1]
    if (!openFence) {
      openFence = { char: marker[0], size: marker.length, line: index, info: match[2].trim() }
      if (openFence.info === 'gugu-ui' || openFence.info === 'gugu-ui-stream') smartStart = offset
    } else if (marker[0] === openFence.char && marker.length >= openFence.size && !match[2].trim()) {
      if (openFence.info === 'gugu-ui' || openFence.info === 'gugu-ui-stream') smartRanges.push({ start: smartStart, end: offset + lines[index].length })
      openFence = null
    }
  }
  if (openFence?.info === 'gugu-ui' || openFence?.info === 'gugu-ui-stream') smartRanges.push({ start: smartStart, end: offset - 1 })
  return { openFence, smartRanges }
}

// 流式渲染保留普通代码块，并为未完成的智能界面显示占位。
let _mdStreamCache: { text: string; locale: string; html: string } | null = null
export function renderMdStream(text: string) {
  if (!text) return ''
  const locale = i18n.global.locale.value
  if (_mdStreamCache?.text === text && _mdStreamCache.locale === locale) return _mdStreamCache.html
  const lines = text.split('\n')
  const { openFence } = scanChatMarkdownFences(lines)
  let staged = ''
  if (openFence?.info === 'gugu-ui-stream') {
    const [, ...records] = lines.splice(openFence.line)
    staged = renderSmartStream(records.join('\n'), true)
  } else if (openFence?.info === 'gugu-ui') {
    lines.splice(openFence.line)
  } else if (openFence) {
    if (openFence.info.split(/\s+/)[0]?.toLowerCase() === 'mermaid') {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[openFence.line])
      if (opening) lines[openFence.line] = `${opening[1]}${opening[2]}text`
    }
    lines.push(`${openFence.char.repeat(openFence.size)}`)
  }
  const prose = marked.parse(prepareMarkdown(lines.join('\n'))) as string
  const html = openFence?.info === 'gugu-ui'
    ? prose + `<section class="chat-smart-view chat-smart-view-generating"><span role="status">${escapeHtml(i18n.global.t('smartView.generating'))}</span></section>`
    : prose + staged
  _mdStreamCache = { text, locale, html }
  return html
}
