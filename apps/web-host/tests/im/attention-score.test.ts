import assert from 'node:assert/strict'
import test from 'node:test'
import { getAttentionDefaults } from '@gugu/core/im/attention/defaults'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

test('开发 attention 评分走认证 Core v3 用例并仅返回安全诊断', async () => {
  const secret = 'synthetic-attention-secret', owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  const app = createApp({ appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    attentionDefaults: { read: getAttentionDefaults },
  })
  try {
    const body = { anchor_text: '翻个跟斗——来了，落地了', text: '他哪会翻跟斗', gap_seconds: 124 }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/dev/attention/score', payload: body })).statusCode, 401)
    const response = await app.inject({ method: 'POST', url: '/api/v1/dev/attention/score', headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` }, payload: body })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().state, 'TOPIC')
    assert.equal(response.json().kind, 'PROACTIVE')
    assert.ok(Math.abs(response.json().score - 68.34) < .5)
    assert.ok(!response.body.includes('翻个跟斗'))
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/dev/attention/score', headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` }, payload: { text: '问题？', idf_window_size: 101 } })
    assert.equal(invalid.statusCode, 422)
  } finally { await app.close() }
})
