import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dispatchRepeatingFire } from '@gugu/core/scheduled-task-run-now'

test('重复触发只执行一次，执行结果不明时保留收据避免重放', async () => {
  const states = new Map<string, string>()
  let held = false
  const lease = {
    async acquire() { if (held) return false; held = true; return true },
    async renew() { return held }, async release() { held = false }, async isHeld() { return held },
  }
  const receipts = {
    async claim(fire: { taskId: string; fireAt: number }) {
      const key = `${fire.taskId}:${fire.fireAt}`
      if (states.has(key)) return false
      states.set(key, 'claimed'); return true
    },
    async finish(fire: { taskId: string; fireAt: number }, _owner: string, state: 'completed' | 'unknown') {
      states.set(`${fire.taskId}:${fire.fireAt}`, state)
    },
  }
  let count = 0
  const input = { fire: { taskId: '1', fireAt: 100 }, owner: 'worker', lease, receipts, leaseMs: 1000,
    async isCurrent() { return true },
    async execute() { count++; throw new Error('执行结果未知') } }
  assert.equal(await dispatchRepeatingFire(input), 'unknown')
  assert.equal(await dispatchRepeatingFire(input), 'duplicate')
  assert.equal(count, 1)
  assert.equal(states.get('1:100'), 'unknown')
})

test('租约丢失时执行结果标记未知，不声明成功', async () => {
  let state = ''
  let executions = 0
  const result = await dispatchRepeatingFire({ fire: { taskId: '1', fireAt: 1 }, owner: 'a', leaseMs: 1000,
    lease: { async acquire() { return true }, async renew() { return false }, async release() {}, async isHeld() { return false } },
    receipts: { async claim() { return true }, async finish(_fire, _owner, value) { state = value } },
    async isCurrent() { return true }, async execute() { executions++ } })
  assert.equal(result, 'unknown')
  assert.equal(state, 'unknown')
  assert.equal(executions, 0)
})

test('开始执行前 Redis 续租异常时保留未知收据且不执行副作用', async () => {
  let state = '', executions = 0
  const result = await dispatchRepeatingFire({ fire: { taskId: '2', fireAt: 1 }, owner: 'a', leaseMs: 1000,
    lease: { async acquire() { return true }, async renew() { throw new Error('Redis 不可用') }, async release() {}, async isHeld() { return false } },
    receipts: { async claim() { return true }, async finish(_fire, _owner, value) { state = value } },
    async isCurrent() { return true }, async execute() { executions++ } })
  assert.equal(result, 'unknown')
  assert.equal(state, 'unknown')
  assert.equal(executions, 0)
})

test('执行中失去租约后终止后续投递并保留未知收据', async () => {
  let held = true
  let state = ''
  let deliveries = 0
  const result = await dispatchRepeatingFire({
    fire: { taskId: '3', fireAt: 1 }, owner: 'a', leaseMs: 1000,
    lease: { async acquire() { return true }, async renew() { return held }, async release() {}, async isHeld() { return held } },
    receipts: { async claim() { return true }, async finish(_fire, _owner, value) { state = value } },
    async isCurrent() { return true },
    async execute(assertLease) {
      held = false
      await assertLease()
      deliveries++
    },
  })
  assert.equal(result, 'unknown')
  assert.equal(state, 'unknown')
  assert.equal(deliveries, 0)
})
