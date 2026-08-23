import { Marked } from 'marked'
import DOMPurify from 'dompurify'

// 通知/轻量场景专用的独立 marked 实例。
// 与 GuguChat 聊天里的全局 marked 配置互不影响（那套带 hljs 代码高亮 + 复制按钮，是聊天专用）。
// 这里只要标准 GFM + 软换行，渲染加粗/斜体/链接/列表/标题/行内代码/引用/表格等完整 markdown。
const md = new Marked({ breaks: true, gfm: true })

// ── XSS 防护（见 docs/security/代码审查-GPT复审核实版-2026-07-10.md P0）──
// 属性值转义：防 title/href 里的引号逃逸出属性、注入新标签。
const _ATTR_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escAttr(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => _ATTR_ESC[c])
}
// 链接协议白名单：只放行 http(s)/mailto/tel/锚点/相对路径；javascript:/data: 等一律丢成空 href。
const _SAFE_HREF = /^(?:https?:|mailto:|tel:|#|\/|\.)/i
function safeHref(href: string): string {
  const h = String(href || '').trim()
  return _SAFE_HREF.test(h) ? h : ''
}

// 链接统一新标签打开 + 安全 rel；href 走协议白名单、title 走属性转义（防属性逃逸注入）。
md.use({
  renderer: {
    link(token) {
      const href     = safeHref(token.href)
      const hrefAttr = href ? ` href="${escAttr(href)}"` : ''
      const title    = token.title ? ` title="${escAttr(token.title)}"` : ''
      const text     = this.parser.parseInline(token.tokens)
      return `<a${hrefAttr}${title} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

// 全站唯一 HTML 消毒出口：任何 v-html 前都必经它（marked 直出的、或后端/流式预渲染好的 HTML）。
// DOMPurify 默认即剥离 <script> / on* 事件属性 / javascript: 协议，同时保留标准排版标签、
// hljs 代码高亮的 span.class、代码块复制按钮及其内联 SVG 图标；ADD_ATTR:['target'] 保住链接新标签打开。
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(String(html ?? ''), { ADD_ATTR: ['target'] })
}

// 聊天专用消毒：在通用严格策略之上，**只额外放行 `gugu://` 协议**——咕咕回复里的动作链接
// `[文案](gugu://bind-im/qq)` / `gugu://open-file/<id>` 靠它保住 href，由 GuguChat 的
// onChatActionClick 委托严格匹配处理（受控白名单动作）。on*/script/javascript: 仍照样剥。
// URI 白名单 = DOMPurify 默认协议 + gugu（不删默认项，只加一个）。
const _CHAT_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|gugu):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
export function sanitizeChatHtml(html: string): string {
  return DOMPurify.sanitize(String(html ?? ''), {
    ADD_ATTR: ['target', 'loading', 'decoding', 'referrerpolicy'],
    ALLOWED_URI_REGEXP: _CHAT_URI_REGEXP,
  })
}

export function renderMarkdown(text: string | null | undefined): string {
  return text ? sanitizeHtml(md.parse(String(text)) as string) : ''
}
