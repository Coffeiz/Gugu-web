import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { EventUpdateError } from '../../src/domains/calendar/application/event-update.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-events-route-secret'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function makeApp(events: {
  list: (ownerId: string, year?: number, month?: number) => Promise<unknown[]>
  get: (ownerId: string, eventId: number) => Promise<unknown | null>
  update?: (context: { data: { ownerId: string } }, eventId: number, body: unknown, metadata: {
    idempotencyKey: string | null
    undoContextId: string | null
    clientId: string | null
  }) => Promise<unknown>
  delete?: (context: { data: { ownerId: string } }, eventId: number, version: number, metadata: {
    idempotencyKey: string | null
    undoContextId: string | null
    clientId: string | null
  }) => Promise<void>
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

test('PATCH /api/v1/events/:eventId forwards authenticated context, body, metadata, and response', async () => {
  const calls: unknown[][] = []
  const updated = {
    id: 10, title: 'Updated event', date: '2026-11-14', time: '11:00', endTime: null,
    type: 'event', client: null, projectId: 12, description: null, version: 4,
  }
  const app = makeApp({
    list: async () => [],
    get: async () => null,
    async update(context, eventId, body, metadata) {
      calls.push([context.data.ownerId, eventId, body, metadata])
      return updated
    },
  })
  try {
    const response = await app.inject({
      method: 'PATCH', url: '/api/v1/events/10',
      headers: {
        authorization: `Bearer ${signedUserToken(secret, userId)}`,
        'x-undo-context-id': 'calendar-tab',
        'x-client-id': 'browser-tab',
        'idempotency-key': 'ignored-for-patch',
      },
      payload: { title: 'Updated event', date: '2026-11-14', time: '11:00', projectId: 12, version: 3 },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), updated)
    assert.deepEqual(calls, [[
      userId,
      10,
      { title: 'Updated event', date: '2026-11-14', time: '11:00', projectId: 12, version: 3 },
      { idempotencyKey: 'ignored-for-patch', undoContextId: 'calendar-tab', clientId: 'browser-tab' },
    ]])
  } finally {
    await app.close()
  }
})

test('PATCH /api/v1/events/:eventId preserves validation, authentication, and domain errors', async () => {
  let updateCalls = 0
  const app = makeApp({
    list: async () => [],
    get: async () => null,
    async update(_context, eventId) {
      updateCalls += 1
      if (eventId === 10) throw new EventUpdateError(409, '数据已被其他用户修改，请刷新后重试')
      if (eventId === 11) throw new EventUpdateError(404, '事件不存在')
      throw new EventUpdateError(422, 'version 必须是整数')
    },
  })
  try {
    const headers = { authorization: `Bearer ${signedUserToken(secret, userId)}` }
    const stale = await app.inject({ method: 'PATCH', url: '/api/v1/events/10', headers, payload: { version: 2 } })
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/events/11', headers, payload: { version: 1 } })
    const invalidId = await app.inject({ method: 'PATCH', url: '/api/v1/events/nope', headers, payload: { version: 1 } })
    const unauthenticated = await app.inject({ method: 'PATCH', url: '/api/v1/events/10', payload: { version: 1 } })
    const invalidBody = await app.inject({ method: 'PATCH', url: '/api/v1/events/12', headers, payload: {} })

    assert.equal(stale.statusCode, 409)
    assert.deepEqual(stale.json(), { detail: '数据已被其他用户修改，请刷新后重试' })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), { detail: '事件不存在' })
    assert.equal(invalidId.statusCode, 422)
    assert.equal(unauthenticated.statusCode, 401)
    assert.equal(invalidBody.statusCode, 422)
    assert.equal(updateCalls, 3, 'invalid IDs and unauthenticated requests never reach the update handler')
  } finally {
    await app.close()
  }
})

test('calendar integer paths and filters preserve FastAPI signed-int parsing and query semantics', async () => {
  const calls: unknown[][] = []
  const app = makeApp({
    list: async (ownerId, year, month) => { calls.push(['list', ownerId, year, month]); return [] },
    get: async (ownerId, eventId) => {
      calls.push(['get', ownerId, eventId])
      return eventId === 13 ? { id: 13, title: 'Signed path event' } : null
    },
  })
  try {
    const signedId = await app.inject({
      method: 'GET', url: '/api/v1/events/%2B13',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const negativeId = await app.inject({
      method: 'GET', url: '/api/v1/events/-1',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const zeroId = await app.inject({
      method: 'GET', url: '/api/v1/events/0',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const signedFilters = await app.inject({
      method: 'GET', url: '/api/v1/events?year=%2B2026&month=%2B11',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const negativeFilters = await app.inject({
      method: 'GET', url: '/api/v1/events?year=-2026&month=-11',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const zeroFilter = await app.inject({
      method: 'GET', url: '/api/v1/events?year=0&month=11',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const malformed = await app.inject({
      method: 'GET', url: '/api/v1/events?year=2026.5',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })

    assert.equal(signedId.statusCode, 200)
    assert.equal(negativeId.statusCode, 404)
    assert.equal(zeroId.statusCode, 404)
    assert.equal(signedFilters.statusCode, 200)
    assert.equal(negativeFilters.statusCode, 200)
    assert.equal(zeroFilter.statusCode, 200)
    assert.equal(malformed.statusCode, 422)
    assert.deepEqual(calls, [
      ['get', userId, 13], ['get', userId, -1], ['get', userId, 0],
      ['list', userId, 2026, 11], ['list', userId, -2026, -11], ['list', userId, 0, 11],
    ])
  } finally {
    await app.close()
  }
})

test('calendar PATCH and DELETE parse signed IDs and versions before owner/version outcomes', async () => {
  const patchCalls: number[] = []
  const deleteCalls: Array<[number, number]> = []
  const app = makeApp({
    list: async () => [],
    get: async () => null,
    async update(_context, eventId) {
      patchCalls.push(eventId)
      if (eventId <= 0) throw new EventUpdateError(404, '事件不存在')
      return { id: eventId, title: 'Updated', version: 2 }
    },
    async delete(_context, eventId, version) {
      deleteCalls.push([eventId, version])
      if (eventId <= 0) throw Object.assign(new Error('事件不存在'), { statusCode: 404 })
      throw Object.assign(new Error('数据已被其他端修改，请刷新后重试'), { statusCode: 409 })
    },
  })
  try {
    const headers = { authorization: `Bearer ${signedUserToken(secret, userId)}` }
    const signedPatch = await app.inject({
      method: 'PATCH', url: '/api/v1/events/%2B13', headers, payload: { version: 1 },
    })
    const negativePatch = await app.inject({
      method: 'PATCH', url: '/api/v1/events/-1', headers, payload: { version: 1 },
    })
    const zeroPatch = await app.inject({
      method: 'PATCH', url: '/api/v1/events/0', headers, payload: { version: 1 },
    })
    const signedDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/events/%2B13?version=%2B4', headers,
    })
    const zeroVersion = await app.inject({
      method: 'DELETE', url: '/api/v1/events/13?version=0', headers,
    })
    const negativeVersion = await app.inject({
      method: 'DELETE', url: '/api/v1/events/13?version=-1', headers,
    })
    const negativeDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/events/-1?version=4', headers,
    })
    const zeroDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/events/0?version=0', headers,
    })
    const badVersion = await app.inject({
      method: 'DELETE', url: '/api/v1/events/13?version=1.5', headers,
    })
    const badVersionText = await app.inject({
      method: 'DELETE', url: '/api/v1/events/13?version=oops', headers,
    })

    assert.equal(signedPatch.statusCode, 200)
    assert.equal(negativePatch.statusCode, 404)
    assert.equal(zeroPatch.statusCode, 404)
    assert.equal(signedDelete.statusCode, 409)
    assert.equal(zeroVersion.statusCode, 409)
    assert.equal(negativeVersion.statusCode, 409)
    assert.equal(negativeDelete.statusCode, 404)
    assert.equal(zeroDelete.statusCode, 404)
    assert.equal(badVersion.statusCode, 422)
    assert.equal(badVersionText.statusCode, 422)
    assert.deepEqual(patchCalls, [13, -1, 0])
    assert.deepEqual(deleteCalls, [[13, 4], [13, 0], [13, -1], [-1, 4], [0, 0]])
  } finally {
    await app.close()
  }
})
