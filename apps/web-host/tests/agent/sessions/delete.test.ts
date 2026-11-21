import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../src/app.js'
import { signedUserToken } from '../../helpers/auth.js'

test('会话删除认证后只使用可信 owner，并保留 Python 的 204/404/422 语义', async () => {
  const secret = 'synthetic-session-delete-secret'
  const owner = '8f5048f4-8e16-43d0-9a8d-3c08087f5131'
  const calls: Array<{ ownerId: string; sessionId: number }> = []
  const app = createApp({
    appName: '会话删除测试', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return {
      id, username: 'moon_example', displayName: null, email: 'moon@example.test', avatarUrl: null,
      createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true,
    } } },
    deleteAgentSession: { async remove(ownerId, sessionId) {
      calls.push({ ownerId, sessionId })
      return ownerId === owner && sessionId === 7
    } },
  })
  try {
    const anonymous = await app.inject({ method: 'DELETE', url: '/api/v1/agent/sessions/7' })
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/agent/sessions/7?ownerId=00000000-0000-4000-8000-000000000000', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/agent/sessions/8', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    const invalid = await app.inject({ method: 'DELETE', url: '/api/v1/agent/sessions/not-an-id', headers: {
      authorization: `Bearer ${signedUserToken(secret, owner)}`,
    } })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(deleted.statusCode, 204)
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '对话不存在' })
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(calls, [{ ownerId: owner, sessionId: 7 }, { ownerId: owner, sessionId: 8 }])
  } finally { await app.close() }
})
