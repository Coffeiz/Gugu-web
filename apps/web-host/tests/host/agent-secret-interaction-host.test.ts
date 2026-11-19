import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import { createAgentSecretInteractionService } from '../../src/modules/agent-sessions/agent-secret-interaction-route.js'

test('createApp 将敏感交互提交和取消置于认证域，提交后以可信 owner 唤醒原 Run', async () => {
  const owner = '00000000-0000-4000-8000-000000000001', secret = 'synthetic-secret'
  const calls: Array<{ owner: string; id: number; values: Record<string, string> | null }> = []
  const wakes: Array<{ owner: string; id: number; status?: string }> = []
  const app = createApp({
    appName: '合成应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) {
      return id === owner ? { id, username: 'sample', displayName: '示例', email: 'sample@example.invalid', avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1 } : null
    } },
    agentSecretInteraction: createAgentSecretInteractionService({
      async consume(requestOwner, id, values) {
        calls.push({ owner: requestOwner, id, values })
        return values === null ? { ok: true, prompt_id: id, status: 'cancelled' } : { ok: true, prompt_id: id }
      },
      async wake(requestOwner, id, result) { wakes.push({ owner: requestOwner, id, ...(result.status ? { status: result.status } : {}) }) },
      diagnose() {},
    }),
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/12/secrets?owner_id=forged', payload: { values: { key: 'synthetic-value' } } })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(calls, [])
    const auth = { authorization: `Bearer ${createUserToken(owner, 1, secret)}` }
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/12/secrets?owner_id=forged', headers: auth, payload: { values: { key: 'synthetic-value' } } })
    assert.equal(accepted.statusCode, 200)
    assert.deepEqual(accepted.json(), { ok: true, prompt_id: 12 })
    const cancelled = await app.inject({ method: 'POST', url: '/api/v1/agent/interactions/13/secrets/cancel', headers: auth })
    assert.equal(cancelled.statusCode, 200)
    assert.deepEqual(calls, [
      { owner, id: 12, values: { key: 'synthetic-value' } },
      { owner, id: 13, values: null },
    ])
    assert.deepEqual(wakes, [{ owner, id: 12 }, { owner, id: 13, status: 'cancelled' }])
  } finally { await app.close() }
})
