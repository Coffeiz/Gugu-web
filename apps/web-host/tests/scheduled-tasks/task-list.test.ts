import assert from 'node:assert/strict'
import test from 'node:test'
import { registerScheduledTaskList } from '../../src/modules/scheduled-tasks/task-list.js'
import Fastify from 'fastify'
import type { UserFromRequest } from '../../src/app.js'

test('非法 event_id 返回 422，省略时仍可读取独立任务', async () => {
  const app = Fastify()
  const calls: Array<[string, number | null]> = []
  const user = (() => ({ requestContext: { data: { ownerId: 'owner' } } })) as unknown as UserFromRequest
  registerScheduledTaskList(app, user, async (owner, eventId) => { calls.push([owner, eventId]); return { tasks: [] } })
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks?event_id=bad' })).statusCode, 422)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks' })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/scheduled-tasks?event_id=12' })).statusCode, 200)
    assert.deepEqual(calls, [['owner', null], ['owner', 12]])
  } finally { await app.close() }
})
