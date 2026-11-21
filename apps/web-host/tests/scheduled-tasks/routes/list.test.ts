import assert from 'node:assert/strict'
import test from 'node:test'
import { registerScheduledTaskList } from '../../../src/modules/scheduled-tasks/routes.js'
import Fastify from 'fastify'
import type { UserFromRequest } from '../../../src/app.js'

test('非法 event_id 返回 422，省略时仍可读取独立任务', async () => {
  const app = Fastify()
  const calls: Array<[string, number | null | 'all']> = []
  const user = (() => ({ requestContext: { data: { ownerId: 'owner' } } })) as unknown as UserFromRequest
  registerScheduledTaskList(app, user, async (owner, eventId) => { calls.push([owner, eventId]); return { tasks: [] } })
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks?event_id=bad' })).statusCode, 422)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks?event_id=12' })).statusCode, 200)
    assert.deepEqual(calls, [['owner', null], ['owner', 12]])
  } finally { await app.close() }
})

test('通知权限检查覆盖日历提醒，只计入当前用户待执行的 Web 任务', async () => {
  const app = Fastify()
  const user = (() => ({ requestContext: { data: { ownerId: 'synthetic-owner' } } })) as unknown as UserFromRequest
  const base = { enabled: true, schedule_status: 'active', schedule_kind: 'once' }
  let includePending = false
  registerScheduledTaskList(app, user, async (owner, scope) => {
    assert.equal(owner, 'synthetic-owner')
    assert.equal(scope, 'all')
    return { tasks: [
      { ...base, channels: ['qq'] },
      { ...base, channels: ['web'], enabled: false },
      { ...base, channels: ['web'], last_run_at: '2026-01-01T00:00:00Z' },
      ...(includePending ? [{ ...base, channels: ['web'] }] : []),
    ] }
  })
  try {
    const url = '/api/v1/scheduled-tasks/pending-web-notifications'
    assert.deepEqual((await app.inject({ url })).json(), { pending: false })
    includePending = true
    assert.deepEqual((await app.inject({ url })).json(), { pending: true })
  } finally { await app.close() }
})
