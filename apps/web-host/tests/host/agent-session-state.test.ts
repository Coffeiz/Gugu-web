import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'

test('生产 App 通过 bearer 身份 owner-scoped 读取 Agent 会话状态', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000099'
  const secret = 'synthetic-session-state-secret'
  const reads: Array<[string, number]> = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    async readAgentSessionState(userId, sessionId) {
      reads.push([userId, sessionId])
      return { executionState: 'idle', pendingMessageCount: 3, active: false }
    },
  })
  try {
    const denied = await app.inject({ url: '/api/v1/agent/sessions/42/state' })
    const allowed = await app.inject({
      url: '/api/v1/agent/sessions/42/state?ownerId=00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
    })

    assert.equal(denied.statusCode, 401)
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(allowed.json(), { executionState: 'idle', pendingMessageCount: 3, active: false })
    assert.deepEqual(reads, [[ownerId, 42]])
  } finally { await app.close() }
})
