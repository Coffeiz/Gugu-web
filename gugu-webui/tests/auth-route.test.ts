import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { signedUserToken } from './helpers/auth.js'

const secret = 'synthetic-test-secret-with-sufficient-length'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

test('GET /api/v1/auth/me returns the existing public user fields for an active user', async () => {
  let markedActive: string | undefined
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id,
        username: 'synthetic-user',
        displayName: '测试用户',
        email: 'synthetic@example.test',
        isActive: true,
        accountStatus: 'active',
        securityVersion: 2,
        avatarUrl: null,
        createdAt: '2026-11-01T00:00:00.000Z',
        timezone: 'Asia/Shanghai',
        emailSubscribed: false,
        imChannels: ['qq'],
      }),
      markUserActive: async (id) => { markedActive = id },
    },
  })

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId, 2)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(markedActive, userId)
    assert.deepEqual(response.json(), {
      id: userId,
      username: 'synthetic-user',
      display_name: '测试用户',
      email: 'synthetic@example.test',
      is_active: true,
      avatar_url: null,
      created_at: '2026-11-01',
      im_channels: ['qq'],
      timezone: 'Asia/Shanghai',
      email_subscribed: false,
    })
  } finally {
    await app.close()
  }
})

test('GET /api/v1/auth/me rejects missing and revoked credentials without exposing user records', async () => {
  let markCount = 0
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id,
        username: 'synthetic-user',
        displayName: null,
        email: 'synthetic@example.test',
        isActive: true,
        accountStatus: 'active',
        securityVersion: 3,
        avatarUrl: null,
        createdAt: null,
        timezone: null,
        emailSubscribed: false,
        imChannels: [],
      }),
      markUserActive: async () => { markCount += 1 },
    },
  })

  try {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
    assert.equal(missing.statusCode, 401)
    assert.deepEqual(missing.json(), { detail: '未提供认证凭据' })

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId, 2)}` },
    })
    assert.equal(revoked.statusCode, 401)
    assert.deepEqual(revoked.json(), { detail: '用户不存在或已停用' })
    assert.equal(JSON.stringify(revoked.json()).includes('synthetic@example.test'), false)
    assert.equal(markCount, 0)
  } finally {
    await app.close()
  }
})
