import { describe, expect, it } from 'vitest'
import { renderMd, renderMdStream } from '@/components/common/gugu-chat/markdown'
import { splitYamlFrontmatter } from '@/utils/markdown'

const escapedTable = [
  '\\| 测试 \\| 期望 \\| 实际 \\| 结论 \\|',
  '\\|------\\|------\\|------\\|------\\|\\',
  '\\| `cat a.md` 看 \\| 不应执行 \\| 字面输出 \\| ✅ 安全 \\|',
].join('\n')

describe('Markdown YAML frontmatter', () => {
  it('预览时剥离闭合的元数据，并保留正文起始行以正确映射待办', () => {
    const source = [
      '---',
      'name: demo',
      'description: a demo skill',
      '---',
      '## 正文标题',
    ].join('\n')

    expect(splitYamlFrontmatter(source)).toEqual({
      body: '## 正文标题',
      bodyStartLine: 4,
      entries: [
        { key: 'name', value: 'demo' },
        { key: 'description', value: 'a demo skill' },
      ],
    })
  })

  it('支持 BOM、CRLF 和 YAML 文档结束符', () => {
    expect(splitYamlFrontmatter('\uFEFF---\r\nname: demo\r\n...\r\n正文')).toEqual({
      body: '正文',
      bodyStartLine: 3,
      entries: [{ key: 'name', value: 'demo' }],
    })
  })

  it('没有完整 frontmatter 时保留普通 Markdown 内容', () => {
    const source = '---\n普通分隔线后的正文'
    expect(splitYamlFrontmatter(source)).toEqual({ body: source, bodyStartLine: 0, entries: [] })
  })

  it('将数组和多行描述整理为可读表格值', () => {
    const source = [
      '---',
      'related_tools:',
      '  - shell',
      '  - run_script',
      'description: >-',
      '  第一行描述',
      '  第二行描述',
      '---',
      '正文',
    ].join('\n')

    expect(splitYamlFrontmatter(source).entries).toEqual([
      { key: 'related_tools', value: 'shell, run_script' },
      { key: 'description', value: '第一行描述 第二行描述' },
    ])
  })
})

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

describe('聊天业务对象卡片', () => {
  it('把项目、活动、画布、笔记和定时任务链接统一渲染成卡片', () => {
    const html = renderMd([
      '[项目](gugu://open-object/project/1)',
      '[活动](gugu://open-object/event/2)',
      '[画布](gugu://open-object/canvas/3)',
      '[笔记](gugu://open-object/note/4)',
      '[任务](gugu://open-object/scheduled-task/5)',
    ].join('\n'))

    expect((html.match(/class="chat-object-card"/g) || []).length).toBe(5)
    expect(html).toContain('data-object-type="canvas" data-object-id="3"')
    expect(html).not.toContain('target="_blank"')
  })

  it('不把普通 gugu 动作链接误判为业务对象卡片', () => {
    const html = renderMd('[打开文件](gugu://open-file/9)')
    expect(html).not.toContain('chat-object-card')
    expect(html).toContain('gugu://open-file/9')
  })
})

describe('聊天技能卡片', () => {
  it('使用独立的 open-skill 协议渲染为可点击技能卡片', () => {
    const html = renderMd('[晨间简报](gugu://open-skill/morning-briefing)')

    expect(html).toContain('class="chat-object-card chat-skill-card"')
    expect(html).toContain('data-skill-slug="morning-briefing"')
    expect(html).toContain('<small>技能</small>')
    expect(html).not.toContain('data-object-type=')
  })

  it('拒绝不安全的技能 slug', () => {
    const html = renderMd('[技能](gugu://open-skill/../../admin)')
    expect(html).not.toContain('chat-skill-card')
  })
})
