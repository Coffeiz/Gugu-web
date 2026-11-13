import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp, type NotificationOptions } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const userId = '4c2d3567-cf55-4805-935a-f2db4e76d155'
const secret = 'synthetic-notifications-route-secret'
const createdAt = '2026-01-02T03:04:05.000Z'
const auth = { authorization: `Bearer ${signedUserToken(secret, userId)}` }

function makeApp(notifications: NotificationOptions) {
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
        createdAt,
        timezone: null,
        emailSubscribed: false,
        imChannels: [],
      }),
    },
    notifications,
  })
}

test('notification list is authenticated, owner-scoped, and preserves the requested limit', async () => {
  const calls: unknown[][] = []
  const app = makeApp({
    list: async (...args) => { calls.push(args); return [{ id: 11, unread: true }] },
    latestBubble: async () => ({ bubble: null }),
    markRead: async () => 0,
    clear: async () => 0,
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=12', headers: auth })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), [{ id: 11, unread: true }])
    assert.deepEqual(calls, [[userId, createdAt, 12]])
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/notifications' })).statusCode, 401)
  } finally {
    await app.close()
  }
})

test('notification routes preserve bubble, read-count, and per-user clear responses', async () => {
  const calls: unknown[][] = []
  const bubble = { bubble: { id: 12, title: 'Update', content: 'Ready', color: '#abc' } }
  const app = makeApp({
    list: async () => [],
    latestBubble: async (...args) => { calls.push(args); return bubble },
    markRead: async (...args) => { calls.push(args); return 2 },
    clear: async (...args) => { calls.push(args); return 3 },
  })
  try {
    const latest = await app.inject({ method: 'GET', url: '/api/v1/notifications/bubble', headers: auth })
    const marked = await app.inject({
      method: 'POST', url: '/api/v1/notifications/read', headers: auth,
      payload: { ids: [11, 12] },
    })
    const cleared = await app.inject({ method: 'DELETE', url: '/api/v1/notifications', headers: auth })
    assert.equal(latest.statusCode, 200)
    assert.deepEqual(latest.json(), bubble)
    assert.equal(marked.statusCode, 200)
    assert.deepEqual(marked.json(), { ok: true, marked: 2 })
    assert.equal(cleared.statusCode, 200)
    assert.deepEqual(cleared.json(), { ok: true, dismissed: 3 })
    assert.deepEqual(calls, [[userId, createdAt], [userId, createdAt, [11, 12]], [userId, createdAt]])
  } finally {
    await app.close()
  }
})

test('notification routes reject malformed limits and read IDs without calling persistence', async () => {
  let calls = 0
  const app = makeApp({
    list: async () => { calls += 1; return [] },
    latestBubble: async () => ({ bubble: null }),
    markRead: async () => { calls += 1; return 0 },
    clear: async () => 0,
  })
  try {
    const badLimit = await app.inject({
      method: 'GET', url: '/api/v1/notifications?limit=1.5', headers: auth,
    })
    const badIds = await app.inject({
      method: 'POST', url: '/api/v1/notifications/read', headers: auth,
      payload: { ids: ['not-an-id'] },
    })
    assert.equal(badLimit.statusCode, 422)
    assert.equal(badIds.statusCode, 422)
    assert.equal(calls, 0)
  } finally {
    await app.close()
  }
})

test('notification list accepts signed integer limits and applies Python service bounds', async () => {
  const receivedLimits: number[] = []
  const app = makeApp({
    list: async (_ownerId, _createdAt, limit) => { receivedLimits.push(limit); return [] },
    latestBubble: async () => ({ bubble: null }),
    markRead: async () => 0,
    clear: async () => 0,
  })
  try {
    for (const [query, expected] of [
      ['+12', 12],
      ['%2B12', 12],
      ['0', 1],
      ['-4', 1],
      ['101', 100],
    ] as const) {
      const response = await app.inject({
        method: 'GET', url: `/api/v1/notifications?limit=${query}`, headers: auth,
      })
      assert.equal(response.statusCode, 200, `limit=${query} should be accepted`)
      assert.equal(receivedLimits.at(-1), expected)
    }
  } finally {
    await app.close()
  }
})
