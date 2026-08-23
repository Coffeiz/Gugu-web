import { marked, type Tokens } from 'marked'
import hljs from 'highlight.js'

marked.use({
  breaks: true, gfm: true,
  renderer: (() => {
    const r = new marked.Renderer()
    // 关掉删除线渲染：口语里 ~ 很常见（好的~、稍等~），~~ 叠出来会被 GFM 当删除线；
    // 伙伴语气几乎不需要真删除线，把 ~~x~~ 直接渲染成纯文本 x（保留表格等其它 GFM 能力）。
    r.del = (t: Tokens.Del) => (t && t.text) || ''
    r.code = ({ text, lang }: Tokens.Code) => {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const label = lang || 'code'
      // 复制按钮不写内联 onclick——DOMPurify 会剥掉所有 on* 属性；改由 onChatActionClick 事件委托处理
      return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${label}</span><button class="md-copy-btn" type="button">复制</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
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

export function renderMd(text: string) { return text ? marked.parse(fixLooseBold(text)) as string : '' }

// 流式渲染专用：补全未闭合的代码围栏，避免 marked 把半段代码块解析成残缺 HTML
// 单条缓存：同一帧内 text 未变则直接返回上次结果，避免重复解析
let _mdStreamCache: { text: string; html: string } | null = null
export function renderMdStream(text: string) {
  if (!text) return ''
  if (_mdStreamCache?.text === text) return _mdStreamCache.html
  const fences = (text.match(/^```/gm) || []).length
  const patched = fences % 2 === 1 ? text + '\n```' : text
  const html = marked.parse(patched) as string
  _mdStreamCache = { text, html }
  return html
}
