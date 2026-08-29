import { describe, expect, it } from 'vitest'
import { renderMd, renderMdStream } from './markdown'

const escapedTable = [
  '\\| 测试 \\| 期望 \\| 实际 \\| 结论 \\|',
  '\\|------\\|------\\|------\\|------\\|\\',
  '\\| `cat a.md` 看 \\| 不应执行 \\| 字面输出 \\| ✅ 安全 \\|',
].join('\n')

describe('聊天 Markdown 表格', () => {
  it('还原模型转义的表格竖线并渲染为 GFM table', () => {
    const html = renderMd(escapedTable)

    expect(html).toContain('<table>')
    expect(html).toContain('<th>测试</th>')
    expect(html).toContain('<td><code>cat a.md</code> 看</td>')
  })

  it('流式渲染也使用相同的表格预处理', () => {
    expect(renderMdStream(escapedTable)).toContain('<table>')
  })

  it('标题与表头粘连时仍能识别表格', () => {
    const html = renderMd([
      '第一轮结果| 测试 | 期望 | 实际 | 结论 |',
      '|------|------|------|------|',
      '| `cat a.md` | 不应执行 | 字面输出 | ✅ 安全 |',
    ].join('\n'))

    expect(html).toContain('<p>第一轮结果</p>')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>测试</th>')
  })

  it('普通文本中的转义竖线不被全局改写', () => {
    const html = renderMd('路径 a\\|b')

    expect(html).toContain('<p>路径 a|b</p>')
    expect(html).not.toContain('<table>')
  })
})
