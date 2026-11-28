import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

test('Undo 路由要求认证并使用认证身份处理预览与操作', async () => {
  const secret = 'synthetic-undo-secret'
  const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const calls: unknown[][] = []
  const app = createApp({ appName: 'Gugu', isReady: async () => true, userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) }, undo: {
    async preview(...args) { calls.push(args); return { available: true } },
    async apply(...args) { calls.push(args); return { idempotent: false } },
  } })
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/undo/preview?context_id=ctx' })).statusCode, 401)
    const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/undo/preview?context_id=ctx', headers })).statusCode, 200)
    for (const path of ['/api/v1/undo', '/api/v1/undo/redo']) assert.equal((await app.inject({ method: 'POST', url: path, headers, payload: { operation_id: 'op', context_id: 'ctx' } })).statusCode, 200)
    assert.deepEqual(calls, [[owner, 'ctx'], [owner, 'ctx', 'op', 'undo'], [owner, 'ctx', 'op', 'redo']])
  } finally { await app.close() }
})
