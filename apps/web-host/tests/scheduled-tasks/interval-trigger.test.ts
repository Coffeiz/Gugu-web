import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextIntervalFire } from '../../src/modules/scheduled-tasks/schedule/interval.js'

test('间隔任务从原始锚点计算并包含结束边界', () => {
  const input = { intervalMinutes: 5, startAt: 1000, endAt: 601000 }
  assert.equal(nextIntervalFire({ ...input, after: 0 }), 1000)
  assert.equal(nextIntervalFire({ ...input, after: 1001 }), 301000)
  assert.equal(nextIntervalFire({ ...input, after: 601000 }), 601000)
  assert.equal(nextIntervalFire({ ...input, after: 601001 }), null)
  assert.throws(() => nextIntervalFire({ ...input, intervalMinutes: 0, after: 0 }))
})
