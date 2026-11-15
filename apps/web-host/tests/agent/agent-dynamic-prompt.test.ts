import assert from 'node:assert/strict'
import test from 'node:test'
import { agentCurrentTimeReminder, buildAgentDynamicSnapshot } from '../../src/domains/agent-sessions/context/agent-dynamic-prompt.js'

test('快照按业务顺序展示截断边界，当前时间只存在动态尾', () => {
  const snapshot = buildAgentDynamicSnapshot({ memoryBlock: '记忆快照', projectBlock: '项目资料', sourceBlock: '对话来源', events: [{ date: '2026-01-02', title: '会议' }], notes: [], files: { total: 2, folders: [{ name: '资料', file_count: 2 }], files: [{ name: '示例.md' }] }, knowledge: Array.from({ length: 41 }, (_, i) => ({ title: `标题${i}` })), includeProjects: true, includeCalendar: true, includeFiles: true, includeKnowledge: true })
  assert.ok(snapshot.indexOf('记忆快照') < snapshot.indexOf('## 项目'))
  assert.match(snapshot, /这里只是截断列表，不代表其它目录为空/); assert.match(snapshot, /另有 1 条更早条目未列出/)
  assert.equal(snapshot.includes('00:30'), false)
  assert.match(agentCurrentTimeReminder(new Date('2026-01-01T16:30:00Z'), 'Asia/Shanghai').content, /2026-01-02（星期五）00:30/)
})
