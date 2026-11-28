import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'
import { createUserToken } from '../../../../src/modules/auth/session/token.js'

test('Host 交互响应先认证，再将可信 owner 交给服务', async () => {
  const owner = '00000000-0000-4000-8000-000000000001', secret = 'synthetic-secret'
  const calls: string[] = []
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return id === owner ? { id, username: 'sample', displayName: '示例', email: 'sample@example.invalid', avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1 } : null } },
    agentInteractionRespond: { async respond(id, promptId) {
      calls.push(id)
      return { prompt_id: promptId, session_id: 1, kind: 'confirm', option_id: 'confirm', action_type: 'select', context: {}, result: { status: 'confirmed' } }
    } },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/12/respond', payload: { token: 'synthetic-token', ownerId: 'forged' } })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(calls, [])
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/12/respond', headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}` }, payload: { token: 'synthetic-token', ownerId: 'forged' } })
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(calls, [owner])
    assert.equal(allowed.json().prompt_id, 12)
  } finally { await app.close() }
})
