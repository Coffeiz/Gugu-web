import test from 'node:test'
import assert from 'node:assert/strict'
import { createWebCalendarReminderTargets } from '../../src/modules/agent/tools/calendar.js'

test('Web 日历提醒按有效 lease 解析 owner 私聊，并拒绝错身份、群目标和失效租约', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
  const lease = { identity, input: { v: 2, source: 'web' }, token: 'lease-token', fence: 1 } as never
  let active = true, releases = 0
  const calls: unknown[] = []
  const pool = { async connect() { return {
    async query(_sql: string, params: unknown[]) { assert.deepEqual(params, ['owner-a', '7', 'run-a', 'lease-token', 1]); return { rowCount: active ? 1 : 0 } },
    release() { releases++ },
  } } } as never
  const targets = createWebCalendarReminderTargets({ pool, lease, delivery: { async resolveDelivery(_client, owner, input) {
    calls.push({ owner, input }); return { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } }
  } } })
  const signal = new AbortController().signal
  const result = await targets.resolve(identity, [{ lead_minutes: 10, channels: ['qq'] }], signal)
  assert.deepEqual(result, { ok: true, reminders: [{ channels: ['qq'], deliveryTargets: { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } }, enabled: true }] })
  assert.deepEqual(calls, [{ owner: 'owner-a', input: { channels: ['qq'] } }])
  assert.equal((await targets.resolve({ ...identity, ownerId: 'owner-b' }, [], signal)).ok, false)
  assert.equal((await targets.resolve(identity, [{ lead_minutes: 0, delivery_mode: 'current_group' }], signal)).ok, false)
  active = false
  assert.equal((await targets.resolve(identity, [{ lead_minutes: 0 }], signal)).ok, false)
  assert.equal(calls.length, 1)
  assert.equal(releases, 2)
})

test('解析投递目标期间租约失效时不返回目标，取消仍向调用方传播', async () => {
  const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'run-a' }
  const lease = { identity, input: { v: 2, source: 'web' }, token: 'lease-token', fence: 1 } as never
  let checks = 0, released = 0
  const pool = { async connect() { return {
    async query() { checks++; return { rowCount: checks === 1 ? 1 : 0 } },
    release() { released++ },
  } } } as never
  const targets = createWebCalendarReminderTargets({ pool, lease, delivery: { async resolveDelivery() { return { qq: { puid: 'synthetic' } } } } })
  const result = await targets.resolve(identity, [{ lead_minutes: 0, channels: ['qq'] }], new AbortController().signal)
  assert.equal(result.ok, false)
  assert.equal(released, 1)
  const controller = new AbortController()
  controller.abort(new Error('取消'))
  await assert.rejects(targets.resolve(identity, [], controller.signal), /取消/)
  assert.equal(released, 1)
})
