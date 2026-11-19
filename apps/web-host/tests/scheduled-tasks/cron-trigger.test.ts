import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesCronMinute } from '../../src/modules/scheduled-tasks/schedule/cron.js'

test('cron 按上海时间同时匹配日期与星期，并验证字段', () => {
  const sunday = Date.parse('2026-11-14T16:30:00Z')
  assert.equal(matchesCronMinute('30 0 15 nov sun', sunday), true)
  assert.equal(matchesCronMinute('30 0 16 nov sun', sunday), false)
  assert.equal(matchesCronMinute('*/15 0 * * 0-6/2', sunday), true)
  assert.throws(() => matchesCronMinute('0 1 * 99 *', sunday))
  // 1991 年上海夏令时为 UTC+9，不能固定使用 UTC+8。
  assert.equal(matchesCronMinute('30 9 1 jun *', Date.parse('1991-06-01T00:30:00Z')), true)
  assert.equal(matchesCronMinute('30 8 1 jun *', Date.parse('1991-06-01T00:30:00Z')), false)
})
