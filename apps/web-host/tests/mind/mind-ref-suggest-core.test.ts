import assert from 'node:assert/strict'
import test from 'node:test'
import { createMindReferenceSuggester } from '../../../../packages/core/src/mind/ref-suggest.js'

const owner = 'd1e37042-3229-4cbe-a260-a63dcb95e001'

test('空查询按 Python 引用类别顺序返回最近候选并限制聚合结果', async () => {
  const calls: unknown[][] = []
  const suggest = createMindReferenceSuggester({
    async recent(ownerId, limit) {
      calls.push([ownerId, limit])
      return Array.from({ length: 20 }, (_, index) => ({ type: 'project', id: index, label: `项目${index}`, subtitle: null }))
    },
    async search() { throw new Error('空查询不得触发站内搜索') },
    async matchingMessages() { throw new Error('空查询不得读取对话消息') },
  })

  const result = await suggest.suggest(owner, '  ', 1)

  assert.equal(result.length, 8)
  assert.deepEqual(result.map(item => item.id), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(calls, [[owner, 1]])
})

test('关键词查询使用 owner 限定的八类全局搜索，追加逐消息锚点并保留总量上限', async () => {
  const calls: unknown[][] = []
  const suggest = createMindReferenceSuggester({
    async recent() { throw new Error('关键词查询不得读取最近候选') },
    globalSearch: { async search(ownerId, query) {
      calls.push([ownerId, query])
      return { groups: [
        { type: 'project', items: [{ id: 7, title: '项目结果', subtitle: '客户' }] },
        { type: 'file', items: [{ id: 8, title: '无副标题结果' }] },
        { type: 'conversation', items: [{ id: 900, title: '整段会话不应进入候选' }] },
      ] }
    } },
    async matchingMessages(ownerId, query, limit) {
      calls.push([ownerId, query, limit])
      return [{ id: 19, content: '前文需要准确定位检索词以及后续说明', sessionTitle: '讨论记录' }]
    },
  })

  const result = await suggest.suggest(owner, '  检索词  ', 2)

  assert.deepEqual(calls, [
    [owner, { q: '检索词', queries: ['检索词'], mode: 'OR', perType: 2,
      types: ['project', 'file', 'folder', 'event', 'canvas_note', 'skill', 'mcp', 'scheduled_task'] }],
    [owner, '检索词', 2],
  ])
  assert.deepEqual(result, [
    { type: 'project', id: 7, label: '项目结果', subtitle: '客户' },
    { type: 'file', id: 8, label: '无副标题结果', subtitle: null },
    { type: 'conversation', id: 19, label: '前文需要准确定位检索词以及后续说明', subtitle: '讨论记录' },
  ])
})

test('消息片段超长时按命中词裁剪，并保留命中附近的完整 emoji', async () => {
  const text = `${'前'.repeat(30)}😀命中词${'后'.repeat(30)}`
  const suggest = createMindReferenceSuggester({
    async recent() { return [] },
    globalSearch: { async search() { return { groups: [] } } },
    async matchingMessages() { return [{ id: 1, content: text, sessionTitle: null }] },
  })

  const [item] = await suggest.suggest(owner, '命中词', 1)

  assert.equal(item?.type, 'conversation')
  assert.equal(item?.label.includes('命中词'), true)
  assert.equal(item?.label.includes('😀'), true)
  assert.equal([...item!.label].length <= 54, true)
})
