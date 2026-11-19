import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'

test('Host 注入聊天服务时先认证，再用可信 owner 转发并返回 SSE', async () => {
  const owner = '00000000-0000-4000-8000-000000000001', secret = 'synthetic-secret'
  const owners: string[] = []
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    userAuth: { secret, async lookupUser(id) { return id === owner ? { id, username: 'sample', displayName: '示例', email: 'sample@example.invalid', avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [], isActive: true, securityVersion: 1 } : null } },
    agentChat: { async start(id) { owners.push(id); return (async function* () { yield { type: 'done' } })() }, async resume() { return null }, async cancel() { return null } },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', payload: { message: '合成消息' } })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(owners, [])
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}` }, payload: { message: '合成消息' } })
    assert.equal(allowed.statusCode, 200)
    assert.match(allowed.headers['content-type']!, /^text\/event-stream/)
    assert.deepEqual(owners, [owner])
    assert.match(allowed.body, /"type":"done"/)
  } finally { await app.close() }
})
