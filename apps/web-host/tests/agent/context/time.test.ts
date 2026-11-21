import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAgentHistoryMessageTime } from '../../../src/modules/agent/context/time.js'

test('历史消息时间按可信用户时区格式化，分钟精度与 Python 基准一致', () => {
  assert.equal(formatAgentHistoryMessageTime('2026-11-17T23:26:00Z', 'Asia/Shanghai'), '2026-11-18 07:26')
  assert.equal(formatAgentHistoryMessageTime('2026-11-17T23:26:00', 'UTC'), '2026-11-17 23:26')
  assert.equal(formatAgentHistoryMessageTime(Date.parse('2026-11-17T23:26:00Z'), 'America/Los_Angeles'), '2026-11-17 15:26')
})

test('历史消息时间拒绝无效时间或无效可信时区', () => {
  assert.throws(() => formatAgentHistoryMessageTime('not-a-time', 'UTC'), RangeError)
  assert.throws(() => formatAgentHistoryMessageTime('2026-11-17T23:26:00Z', 'Invalid/Timezone'), RangeError)
})
