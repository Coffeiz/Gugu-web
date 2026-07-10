import { describe, it, expect } from 'vitest'
import { sanitizeHtml, sanitizeChatHtml, renderMarkdown } from './markdown'

// P0 XSS 回归（见 docs/security/代码审查-GPT复审核实版-2026-07-10.md）。
// 全站 Markdown 直出经 sanitizeHtml；这里钉死「危险载荷被中和 + 正常渲染无损」两面，
// 防将来有人换回裸 marked / 漏接某个 v-html sink。

describe('sanitizeHtml — 危险载荷必须被中和', () => {
  it('剥离 <img onerror>', () => {
    const out = sanitizeHtml('<img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/onerror/i)
  })
  it('剥离 <script>', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>')
    expect(out).not.toMatch(/<script/i)
    expect(out).toContain('<p>hi</p>')
  })
  it('剥离 <svg onload>', () => {
    expect(sanitizeHtml('<svg onload=alert(1)></svg>')).not.toMatch(/onload/i)
  })
  it('剥离 javascript: 链接协议', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i)
  })
})

describe('sanitizeHtml — 正常渲染不能被误伤', () => {
  it('保留 hljs 代码高亮 span.class', () => {
    const out = sanitizeHtml('<pre><code><span class="hljs-keyword">def</span></code></pre>')
    expect(out).toContain('hljs-keyword')
  })
  it('保留代码块复制按钮 + 内联 SVG', () => {
    const out = sanitizeHtml('<button class="md-copy-btn"><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></button>')
    expect(out).toContain('md-copy-btn')
    expect(out).toMatch(/<svg/i)
  })
  it('保留链接新标签打开（target=_blank）', () => {
    const out = sanitizeHtml('<a href="https://ok.com" target="_blank" rel="noopener">x</a>')
    expect(out).toMatch(/target="_blank"/)
    expect(out).toContain('https://ok.com')
  })
})

describe('renderMarkdown — marked → 消毒 一体', () => {
  it('空输入返回空串', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown(null)).toBe('')
  })
  it('正文里的原始 HTML 载荷被中和', () => {
    expect(renderMarkdown('前 <img src=x onerror=alert(1)> 后')).not.toMatch(/onerror/i)
  })
  it('link renderer：javascript: 协议丢弃', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toMatch(/javascript:/i)
  })
  it('link renderer：https 链接保留且新标签打开', () => {
    const out = renderMarkdown('[x](https://ok.com)')
    expect(out).toContain('https://ok.com')
    expect(out).toMatch(/target="_blank"/)
  })
  it('link renderer：title 属性逃逸被挡（不产生真实 img / onerror 元素）', () => {
    // escAttr 把 title 里的 " 转成 &quot;，注入片段被关在属性值里当惰性文本——
    // 断言要看「有没有真实可执行元素」，不能用字符串匹配（惰性文本里出现 "onerror" 字样不算漏洞）。
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('[x](https://a.com "z\\"><img src=y onerror=alert(1)>")')
    expect(div.querySelector('img')).toBeNull()        // 注入未逃出属性 → 无真实 img
    expect(div.querySelector('[onerror]')).toBeNull()  // 无任何元素带 onerror 处理器
  })
  it('正常 markdown 正常渲染', () => {
    const out = renderMarkdown('**粗** 和 `码`\n\n- 一\n- 二')
    expect(out).toContain('<strong>粗</strong>')
    expect(out).toMatch(/<code>码<\/code>/)
    expect(out).toMatch(/<li>/)
  })
})

// 聊天路径消毒（覆盖 P0 修复引入的两个回归：复制按钮 on* 被剥、gugu:// 动作链接被剥）
describe('sanitizeChatHtml — 聊天路径只额外放行 gugu://', () => {
  it('保住 gugu:// 动作链接的 href', () => {
    const div = document.createElement('div')
    div.innerHTML = sanitizeChatHtml('<a href="gugu://bind-im/qq">连接 QQ</a>')
    expect(div.querySelector('a')?.getAttribute('href')).toBe('gugu://bind-im/qq')
  })
  it('通用 sanitizeHtml 仍剥掉 gugu://（least-privilege，只有聊天放行）', () => {
    const div = document.createElement('div')
    div.innerHTML = sanitizeHtml('<a href="gugu://bind-im/qq">连接 QQ</a>')
    expect(div.querySelector('a')?.getAttribute('href')).toBeNull()   // 非聊天路径不放行
  })
  it('聊天路径仍是 XSS 安全：script / on* / javascript: 照样剥', () => {
    expect(sanitizeChatHtml('<img src=x onerror=alert(1)>')).not.toMatch(/onerror/i)
    expect(sanitizeChatHtml('<script>alert(1)</script>hi')).not.toMatch(/<script/i)
    const div = document.createElement('div')
    div.innerHTML = sanitizeChatHtml('<a href="javascript:alert(1)">x</a>')
    expect(div.querySelector('a')?.getAttribute('href')).toBeNull()   // gugu 放行了，但 javascript: 仍剥
  })
  it('复制按钮的内联 onclick 被剥（故走事件委托，不靠 onclick）', () => {
    const div = document.createElement('div')
    div.innerHTML = sanitizeChatHtml('<button class="md-copy-btn" onclick="steal()">复制</button>')
    const btn = div.querySelector('.md-copy-btn')
    expect(btn).not.toBeNull()                       // 按钮保留
    expect(btn?.getAttribute('onclick')).toBeNull()  // 但 onclick 没了 → 必须靠委托
  })
  it('通用 renderMarkdown（MarkdownView text 分支）连渲染时都剥 gugu://——故聊天必须由 GuguChat 自出 html', () => {
    // markdown.ts 的 md link renderer 用 safeHref 白名单（无 gugu），渲染层就丢了 href；
    // 所以 chat 的 text 回退不能走这条，GuguChat 用自己的 marked 出 html（见 GuguChat 模板 msg.html ?? renderMd）。
    const div = document.createElement('div')
    div.innerHTML = renderMarkdown('[连接 QQ](gugu://bind-im/qq)')
    expect(div.querySelector('a')?.getAttribute('href') ?? '').not.toContain('gugu://')
  })
})
