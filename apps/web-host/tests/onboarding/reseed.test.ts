import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/session/token.js'

test('生产 Host 认证后只按 JWT owner 重播种，并对未认证请求拒绝副作用', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000071'
  const secret = 'synthetic-onboarding-host-secret'
  const calls: string[] = []
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
    onboardingReseed: async id => {
      calls.push(id)
      return { ok: true, state: { seed: { seeded: true, project_id: 72 }, should_show: true } }
    },
  })
  try {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/onboarding/dev/reseed' })
    const response = await app.inject({
      method: 'POST', url: '/api/v1/onboarding/dev/reseed',
      headers: { authorization: `Bearer ${createUserToken(ownerId, 1, secret)}` },
    })
    assert.equal(denied.statusCode, 401)
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, state: { seed: { seeded: true, project_id: 72 }, should_show: true } })
    assert.deepEqual(calls, [ownerId])
  } finally { await app.close() }
})
