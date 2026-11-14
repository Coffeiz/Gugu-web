import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'
import type { PublicUserRecord } from '../../src/domains/auth/auth.js'
import type { PreferencesStore } from '../../src/domains/preferences/preferences.js'

const ownerId = '00000000-0000-4000-8000-000000000031'
const secret = 'synthetic-test-secret-for-preferences'
const owner: PublicUserRecord = {
  id: ownerId,
  username: 'preferences-user',
  displayName: '偏好用户',
  email: 'preferences-user@example.test',
  isActive: true,
  accountStatus: 'active',
  securityVersion: 1,
  avatarUrl: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  timezone: 'Asia/Shanghai',
  emailSubscribed: false,
  imChannels: [],
}

test('Node Host protects preferences and derives persistence owner from the authenticated session', async () => {
  const reads: string[] = []
  const writes: string[] = []
  const stored = new Map<string, Record<string, unknown>>()
  const store: PreferencesStore = {
    async read(userId) {
      reads.push(userId)
      return stored.get(userId) ?? null
    },
    async write(userId, data) {
      writes.push(userId)
      stored.set(userId, data)
    },
  }
  const app = createApp({
    appName: 'preferences-host-test',
    async isReady() { return true },
    userAuth: {
      secret,
      async lookupUser(userId) { return userId === ownerId ? owner : null },
    },
    preferences: store,
    emailChange: {
      store: {
        async findUser() { return null },
        async emailOccupied() { return false },
        async createRequest() {},
        async activeRequest() { return null },
        async replaceActiveToken() { return null },
        async revokeActive() {},
        async completeToken() { return { kind: 'invalid' as const } },
      },
      async rateLimit() {},
      systemEmailAvailable: true,
      mail: null,
      async publishAuthStateChanged() {},
    },
  })

  try {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/preferences' })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(reads, [])

    const authorization = `Bearer ${createUserToken(ownerId, 1, secret)}`
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/preferences',
      headers: { authorization, 'x-owner-id': '00000000-0000-4000-8000-000000000099' },
      payload: { locale: 'ja-JP', theme: 'dark' },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().locale, 'ja-JP')
    assert.equal(updated.json().theme, 'dark')
    assert.equal(updated.json().emailChangeEnabled, true)
    assert.deepEqual(reads, [ownerId])
    assert.deepEqual(writes, [ownerId])
  } finally {
    await app.close()
  }
})
