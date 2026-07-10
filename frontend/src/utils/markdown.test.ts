import { describe, it, expect } from 'vitest'
import { sanitizeHtml, renderMarkdown } from './markdown'

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
