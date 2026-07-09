import { Marked } from 'marked'

// 通知/轻量场景专用的独立 marked 实例。
// 与 GuguChat 聊天里的全局 marked 配置互不影响（那套带 hljs 代码高亮 + 复制按钮，是聊天专用）。
// 这里只要标准 GFM + 软换行，渲染加粗/斜体/链接/列表/标题/行内代码/引用/表格等完整 markdown。
const md = new Marked({ breaks: true, gfm: true })

// 链接统一新标签打开 + 安全 rel
md.use({
  renderer: {
    link(token) {
      const href  = token.href || ''
      const title = token.title ? ` title="${token.title}"` : ''
      const text  = this.parser.parseInline(token.tokens)
      return `<a href="${href}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

export function renderMarkdown(text) {
  return text ? md.parse(String(text)) : ''
}
