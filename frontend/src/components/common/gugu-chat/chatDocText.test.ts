import { describe, expect, it } from 'vitest'

import { chatTextFromDoc } from './chatDocText'

const text = (t: string) => ({ type: 'text', text: t })
const para = (...content: any[]) => ({ type: 'paragraph', content })
const listItem = (...content: any[]) => ({ type: 'listItem', content })
const bulletList = (...items: any[]) => ({ type: 'bulletList', content: items })

describe('chatTextFromDoc', () => {
  it('空 doc / 无 content → 空串', () => {
    expect(chatTextFromDoc(null)).toBe('')
    expect(chatTextFromDoc({ type: 'doc' })).toBe('')
  })

  it('简单段落与 hardBreak：与旧两层实现行为一致', () => {
    const doc = { type: 'doc', content: [
      para(text('第一行'), { type: 'hardBreak' }, text('第二行')),
      para(text('第二段')),
    ] }
    expect(chatTextFromDoc(doc as any)).toBe('第一行\n第二行\n第二段')
  })

  it('mindRef 输出 @label', () => {
    const doc = { type: 'doc', content: [para(
      { type: 'mindRef', attrs: { label: '项目A' } }, text(' 看看这个'),
    )] }
    expect(chatTextFromDoc(doc as any)).toBe('@项目A 看看这个')
  })

  it('回归：粘贴的深层嵌套列表/引用块不再丢失内容', () => {
    // 结构来自真实事故：bulletList → listItem → (paragraph, bulletList → …)，
    // 旧实现只遍历两层，嵌套文字全部序列化为空 → 发送被静默吞掉
    const doc = { type: 'doc', content: [
      bulletList(
        listItem(
          para(text('很多东西必须和咕咕绑得很紧'), text('：项目、日历、文件。')),
          bulletList(
            listItem(para(text('哪些上下文什么时候注入'))),
            listItem(para(text('记忆怎么召回'))),
          ),
          para(text('这类东西套通用抽象反而要绕着框架改。')),
        ),
        listItem(
          para(text('你很在意这一轮到底发生了什么')),
          { type: 'blockquote', content: [
            para(text('每轮塞了什么、模型看到了什么，你都能自己控制。')),
            para(text('有，而且我觉得理由是抽象成本。')),
          ] },
        ),
      ),
      para(text('这个理由比"框架太重"都更站得住。')),
    ] }
    const result = chatTextFromDoc(doc as any)
    expect(result).toContain('很多东西必须和咕咕绑得很紧：项目、日历、文件。')
    expect(result).toContain('哪些上下文什么时候注入')
    expect(result).toContain('记忆怎么召回')
    expect(result).toContain('每轮塞了什么、模型看到了什么，你都能自己控制。')
    expect(result).toContain('这个理由比"框架太重"都更站得住。')
    expect(result.trim().length).toBeGreaterThan(50)
  })

  it('行内标记序列化成 markdown 语法，气泡端可渲染回来', () => {
    const doc = { type: 'doc', content: [para(
      { type: 'text', text: '加粗', marks: [{ type: 'bold' }] },
      text(' 和 '),
      { type: 'text', text: 'code', marks: [{ type: 'code' }] },
    )] }
    expect(chatTextFromDoc(doc as any)).toBe('**加粗** 和 `code`')
  })

  it('列表/代码块序列化成 markdown 块级语法，嵌套列表缩进', () => {
    const doc = { type: 'doc', content: [
      bulletList(
        listItem(para(text('甲')), para(text('乙'))),
        listItem(para(text('丙')), bulletList(listItem(para(text('丁'))))),
      ),
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1')] },
    ] }
    expect(chatTextFromDoc(doc as any)).toBe(
      '- 甲\n'
      + '  乙\n'
      + '- 丙\n'
      + '  - 丁\n'
      + '```ts\n'
      + 'const a = 1\n'
      + '```',
    )
  })

  it('块级节点之间插入换行，段落内 inline 直连', () => {
    const doc = { type: 'doc', content: [
      bulletList(
        listItem(para(text('甲')), para(text('乙'))),
        listItem(para(text('丙'))),
      ),
      para(text('丁')),
    ] }
    expect(chatTextFromDoc(doc as any)).toBe('- 甲\n  乙\n- 丙\n丁')
  })

  it('chatDoc 往返：按 \\n 分段的 paragraph 数组序列化还原原文本', () => {
    // chatDoc(text) 把文本按 \n 拆成顶层 paragraph；序列化必须与之往返一致
    const original = '第一行\n\n第三行'
    const doc = { type: 'doc', content: original.split('\n').map(line => (
      line ? para(text(line)) : para()
    )) }
    expect(chatTextFromDoc(doc as any)).toBe(original)
  })
})
