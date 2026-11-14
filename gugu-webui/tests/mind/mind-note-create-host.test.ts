import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { MindNoteCreateError } from '../../src/domains/mind/application/mind-note-create.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-create-secret'
const ownerId = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const note = {
  id: 12, kind: 'note', title: null, contentMd: 'saved', color: null,
  capturedAt: '2026-11-14T10:00:00.000+00:00', version: 1,
  createdAt: '2026-11-14T10:00:00.000+00:00', updatedAt: '2026-11-14T10:00:00.000+00:00',
  deletedAt: null, refType: null, refId: null, refSnapshot: null,
}

function makeApp(calls: unknown[][]) {
  return createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async (id) => ({
        id, username: 'synthetic-user', displayName: null, email: 'synthetic@example.test',
        isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null,
        createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
      }),
    },
    mindNoteCreate: {
      async create(owner, input, metadata) {
        calls.push([owner, input, metadata.undoContextId, metadata.clientId, metadata.mutationId])
        if (typeof input === 'object' && input !== null && 'invalid' in input)
          throw new MindNoteCreateError('便签内容无效')
        return note
      },
    },
  })
}

test('note create requires auth and binds the trusted owner and write metadata before returning 201', async () => {
  const calls: unknown[][] = []
  const app = makeApp(calls)
  try {
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/v1/mind/notes', payload: { contentMd: 'saved' } })
    const created = await app.inject({
      method: 'POST', url: '/api/v1/mind/notes', payload: { contentMd: 'saved' },
      headers: {
        authorization: `Bearer ${signedUserToken(secret, ownerId)}`,
        'x-undo-context-id': 'undo-a', 'x-client-id': 'client-a', 'x-mutation-id': 'mutation-a',
      },
    })

    assert.equal(unauthenticated.statusCode, 401)
    assert.equal(created.statusCode, 201)
    assert.deepEqual(created.json(), note)
    assert.deepEqual(calls, [[ownerId, { contentMd: 'saved' }, 'undo-a', 'client-a', 'mutation-a']])
  } finally {
    await app.close()
  }
})

test('note create maps Python-compatible validation failures to HTTP 422', async () => {
  const app = makeApp([])
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/mind/notes', payload: { invalid: true },
      headers: { authorization: `Bearer ${signedUserToken(secret, ownerId)}` },
    })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(response.json(), { detail: '便签内容无效' })
  } finally {
    await app.close()
  }
})
