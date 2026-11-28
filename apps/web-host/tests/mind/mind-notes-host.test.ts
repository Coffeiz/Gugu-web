import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-route-secret'
const userId = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const noteResponse = {
  id: 8,
  kind: 'note',
  title: '记录',
  contentMd: '正文',
  color: null,
  capturedAt: '2026-11-13T10:00:00.000+00:00',
  version: 2,
  createdAt: '2026-11-13T10:00:00.000+00:00',
  updatedAt: '2026-11-13T10:00:00.000+00:00',
  deletedAt: null,
  refType: null,
  refId: null,
  refSnapshot: null,
}

function makeApp(calls: unknown[][]) {
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
    mindNotes: {
      async list(ownerId, limit, offset) {
        calls.push(['list', ownerId, limit, offset])
        return [noteResponse]
      },
      async get(ownerId, noteId) {
        calls.push(['get', ownerId, noteId])
        return noteId === 8 ? noteResponse : null
      },
    },
  })
}

test('Mind note read routes require authentication and bind operations to the verified owner', async () => {
  const calls: unknown[][] = []
  const app = makeApp(calls)
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/mind/notes' })
    const timeline = await app.inject({
      method: 'GET',
      url: '/api/v1/mind/notes?limit=20&offset=5',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })
    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/mind/notes/8',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })

    assert.equal(unauthenticated.statusCode, 401)
    assert.equal(timeline.statusCode, 200)
    assert.deepEqual(timeline.json(), [noteResponse])
    assert.equal(detail.statusCode, 200)
    assert.deepEqual(calls, [['list', userId, 20, 5], ['get', userId, 8]])
  } finally {
    await app.close()
  }
})

test('Mind note detail returns not found for notes hidden by owner-scoped persistence', async () => {
  const calls: unknown[][] = []
  const app = makeApp(calls)
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/mind/notes/999',
      headers: { authorization: `Bearer ${signedUserToken(secret, userId)}` },
    })

    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { detail: '便签不存在' })
  } finally {
    await app.close()
  }
})
