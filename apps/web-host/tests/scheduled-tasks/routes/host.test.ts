import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('生产 Host 定时任务创建和更新经过认证身份并转发到写入用例', async () => {
  const secret = 'synthetic-task-write-secret', owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const calls: unknown[][] = []
  const scheduledTaskWrites = {
    async create(...args: unknown[]) { calls.push(args); return { task: { id: 8, name: '任务' }, created: true } },
    async update(...args: unknown[]) { calls.push(args); return { id: 8, name: '更新任务' } },
  }
  const app = createApp({ appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    scheduledTaskWrites,
  })
  try {
    const path = '/api/v1/scheduled-tasks'
    assert.equal((await app.inject({ method: 'POST', url: path, payload: { name: '任务', schedule_kind: 'once', start_at: 1893456000 } })).statusCode, 401)
    const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    const created = await app.inject({ method: 'POST', url: path, headers, payload: { name: '任务', schedule_kind: 'once', start_at: 1893456000 } })
    assert.equal(created.statusCode, 201, created.body)
    assert.deepEqual(created.json(), { id: 8, name: '任务' })
    const updated = await app.inject({ method: 'PATCH', url: `${path}/8`, headers, payload: { name: '更新任务' } })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.deepEqual(updated.json(), { id: 8, name: '更新任务' })
    assert.equal(calls[0]?.[0], owner)
    assert.equal(calls[1]?.[0], owner)
  } finally { await app.close() }
})
