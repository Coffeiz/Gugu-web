import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAgentMemory, formatAgentSource } from '../../src/domains/agent-sessions/context/agent-memory-source-prompt.js'

test('记忆衰减、时间锚点、字符预算和无依据声明保持业务语义', () => {
  const now = 20 * 86400 * 1000
  const text = formatAgentMemory({ summary: '旧状态', summary_ts: 9 * 86400, first_ts: 86400, profile: '画像', daily: '😀'.repeat(2001) }, now)
  assert.match(text, /较早前的状态（约 11 天前/)
  assert.match(text, /从 19 天前 开始积累/)
  assert.ok(text.indexOf('旧状态') < text.indexOf('用户画像'))
  assert.equal(Array.from(text.split('## 最近的记忆\n\n')[1]).length, 2000)
  assert.match(formatAgentMemory({}, now), /不代表完整历史/)
  assert.equal(formatAgentMemory({ summary: '状态' }, now, false), '')
  assert.match(formatAgentMemory({ summary: '状态', summary_ts: 16 * 86400 }, now), /约 4 天前记的/)
})

test('IM 状态尊重连接数据并保证当前来源可达', () => {
  const text = formatAgentSource('qq', { feishu: true, qq: false })
  assert.match(text, /飞书：已连 ✅；QQ：已连 ✅；微信：未连 ❌；Telegram：未连 ❌/)
  assert.match(text, /无需再绑定/)
  assert.doesNotMatch(formatAgentSource('web', {}), /无需再绑定/)
})
