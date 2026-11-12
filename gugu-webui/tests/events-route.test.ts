import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { signedUserToken } from './helpers/auth.js'

const secret = 'synthetic-events-route-secret'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function makeApp(events: {
  list: (ownerId: string, year?: number, month?: number) => Promise<unknown[]>
  get: (ownerId: string, eventId: number) => Promise<unknown | null>
}) {
  return createApp({
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
        securityVersion: 1,
        avatarUrl: null,
        createdAt: null,
        timezone: null,
        emailSubscribed: false,
        imChannels: [],
      }),
    },
    events,
  })
}

test('GET /api/v1/events binds owner and forwards optional year/month filters', async () => {
  const calls: Array<[string, number | undefined, number | undefined]> = []
  const app = makeApp({
    list: async (ownerId, year, month) => {
      calls.push([ownerId, year, month])
      return [{ id: 10, title: 'Calendar item' }]
    },
    get: async () => null,
  })
  try {
    const filtered = await app.inject({
      method: 'GET', url: '/api/v1/events?year=2026&month=11',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const unfiltered = await app.inject({
      method: 'GET', url: '/api/v1/events',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const missing = await app.inject({ method: 'GET', url: '/api/v1/events' })
    assert.equal(filtered.statusCode, 200)
    assert.deepEqual(filtered.json(), [{ id: 10, title: 'Calendar item' }])
    assert.equal(unfiltered.statusCode, 200)
    assert.equal(missing.statusCode, 401)
    assert.deepEqual(calls, [[userId, 2026, 11], [userId, undefined, undefined]])
  } finally {
    await app.close()
  }
})

test('GET /api/v1/events validates filters and scopes event detail to its owner', async () => {
  const calls: Array<[string, number]> = []
  const app = makeApp({
    list: async () => [],
    get: async (ownerId, eventId) => {
      calls.push([ownerId, eventId])
      return eventId === 10 ? { id: 10, title: 'Owned event' } : null
    },
  })
  try {
    const found = await app.inject({
      method: 'GET', url: '/api/v1/events/10',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const missing = await app.inject({
      method: 'GET', url: '/api/v1/events/11',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const invalid = await app.inject({
      method: 'GET', url: '/api/v1/events/not-an-id',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const invalidFilter = await app.inject({
      method: 'GET', url: '/api/v1/events?year=not-a-year',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    assert.equal(found.statusCode, 200)
    assert.deepEqual(found.json(), { id: 10, title: 'Owned event' })
    assert.equal(missing.statusCode, 404)
    assert.equal(invalid.statusCode, 422)
    assert.equal(invalidFilter.statusCode, 422)
    assert.deepEqual(calls, [[userId, 10], [userId, 11]])
  } finally {
    await app.close()
  }
})
