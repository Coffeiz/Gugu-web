import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp, type TrackOptions } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const userId = 'ca6a4280-a961-4e71-9ac0-6e577612e03f'
const secret = 'synthetic-track-route-secret'
const auth = { authorization: `Bearer ${signedUserToken(secret, userId)}` }

function makeApp(track: TrackOptions) {
  return createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id,
        username: 'alice',
        displayName: 'Alice',
        email: 'alice@example.test',
        isActive: true,
        avatarUrl: null,
        createdAt: '2026-01-02T03:04:05.000Z',
        timezone: null,
        emailSubscribed: false,
        imChannels: [],
      }),
    },
    track,
  })
}

test('POST /api/v1/track authenticates, binds the user, and returns the existing response', async () => {
  const calls: unknown[][] = []
  const app = makeApp({ track: async (...args) => { calls.push(args) } })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/track', headers: auth,
      payload: { event: 'chat_open', properties: { surface: 'dialog', count: 2 } },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(calls, [[userId, 'chat_open', { surface: 'dialog', count: 2 }]])
    assert.equal((await app.inject({
      method: 'POST', url: '/api/v1/track', payload: { event: 'chat_open' },
    })).statusCode, 401)
  } finally {
    await app.close()
  }
})

test('track preserves Python code-point truncation and accepts omitted properties', async () => {
  const calls: unknown[][] = []
  const app = makeApp({ track: async (...args) => { calls.push(args) } })
  const event = `${'x'.repeat(63)}🙂z`
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/track', headers: auth, payload: { event },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(calls, [[userId, `${'x'.repeat(63)}🙂`, null]])
  } finally {
    await app.close()
  }
})

test('track rejects malformed event and properties without persisting them', async () => {
  let calls = 0
  const app = makeApp({ track: async () => { calls += 1 } })
  try {
    const missingEvent = await app.inject({
      method: 'POST', url: '/api/v1/track', headers: auth, payload: { properties: {} },
    })
    const invalidProperties = await app.inject({
      method: 'POST', url: '/api/v1/track', headers: auth, payload: { event: 'chat_open', properties: [] },
    })
    assert.equal(missingEvent.statusCode, 422)
    assert.deepEqual(missingEvent.json(), { detail: '埋点请求字段无效' })
    assert.equal(invalidProperties.statusCode, 422)
    assert.deepEqual(invalidProperties.json(), { detail: '埋点请求字段无效' })
    assert.equal(calls, 0)
  } finally {
    await app.close()
  }
})

test('track does not acknowledge an event when persistence fails', async () => {
  const app = makeApp({
    async track() {
      throw new Error('synthetic persistence failure')
    },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/track', headers: auth,
      payload: { event: 'chat_open', properties: { surface: 'dialog' } },
    })
    assert.equal(response.statusCode, 500)
    assert.deepEqual(response.json(), { detail: '服务器内部错误，请稍后重试' })
  } finally {
    await app.close()
  }
})
