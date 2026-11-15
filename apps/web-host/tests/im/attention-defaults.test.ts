import assert from 'node:assert/strict'
import test from 'node:test'
import { getAttentionDefaults } from '@gugu/core/im/attention/defaults'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

test('注意力默认值接口要求认证并返回 Python 兼容算法契约', async () => {
  const secret = 'synthetic-attention-secret', owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
  let reads = 0
  const app = createApp({ appName: 'Gugu', isReady: async () => true,
    userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
    attentionDefaults: { read: () => { reads++; return getAttentionDefaults() } },
  })
  try {
    assert.equal((await app.inject('/api/v1/dev/attention/defaults')).statusCode, 401)
    assert.equal(reads, 0)
    const response = await app.inject({ url: '/api/v1/dev/attention/defaults', headers: { authorization: `Bearer ${signedUserToken(secret, owner)}` } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      algorithm_version: 'attention-v3.0.7',
      thresholds: { quiet: 85, natural: 65, active: 55 },
      topic_ttl_seconds: 600,
      topic_half_life_seconds: 360,
      member_active_ttl_seconds: 180,
    })
    assert.equal(reads, 1)
  } finally { await app.close() }
})
