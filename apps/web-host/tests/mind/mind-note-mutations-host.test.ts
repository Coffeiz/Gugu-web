import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { MindNoteMutationError } from '../../src/domains/mind/application/mind-note-mutations.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-mutation-secret'
const ownerId = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const note = {
  id: 12, kind: 'note', title: '标题', contentMd: '正文', color: 'amber',
  capturedAt: '2026-11-14T10:00:00.000+00:00', version: 2,
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
    mindNoteMutations: {
      async update(ownerIdArg, noteId, body, metadata) {
        calls.push(['update', ownerIdArg, noteId, body, metadata.undoContextId, metadata.clientId, metadata.mutationId])
        if (typeof body === 'object' && body !== null && 'missing' in body)
          throw new MindNoteMutationError('便签不存在', 404)
        if (typeof body === 'object' && body !== null && 'stale' in body)
          throw new MindNoteMutationError('便签已被其他端修改，请刷新后重试', 409)
        if (typeof body === 'object' && body !== null && 'invalid' in body)
          throw new MindNoteMutationError('便签颜色必须是现有色板中的值', 422)
        return note
      },
      async delete(ownerIdArg, noteId, metadata) {
        calls.push(['delete', ownerIdArg, noteId, metadata.undoContextId, metadata.clientId, metadata.mutationId])
      },
    },
  })
}

const auth = { authorization: `Bearer ${signedUserToken(secret, ownerId)}` }

test('note mutations require auth and bind trusted owner plus Undo/client metadata', async () => {
  const calls: unknown[][] = []
  const app = makeApp(calls)
  try {
    const denied = await app.inject({ method: 'PATCH', url: '/api/v1/mind/notes/12', payload: { version: 1 } })
    const updated = await app.inject({
      method: 'PATCH', url: '/api/v1/mind/notes/12', payload: { version: 1, title: '新标题' },
      headers: { ...auth, 'x-undo-context-id': 'undo-a', 'x-client-id': 'tab-a', 'x-mutation-id': 'mutation-a' },
    })
    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/mind/notes/12',
      headers: { ...auth, 'x-undo-context-id': 'undo-b', 'x-client-id': 'tab-b', 'x-mutation-id': 'mutation-b' },
    })
    assert.equal(denied.statusCode, 401)
    assert.equal(updated.statusCode, 200)
    assert.deepEqual(updated.json(), note)
    assert.equal(deleted.statusCode, 204)
    assert.deepEqual(calls, [
      ['update', ownerId, 12, { version: 1, title: '新标题' }, 'undo-a', 'tab-a', 'mutation-a'],
      ['delete', ownerId, 12, 'undo-b', 'tab-b', 'mutation-b'],
    ])
  } finally {
    await app.close()
  }
})

test('note mutation routes map Python-compatible not-found, conflict, and validation outcomes', async () => {
  const app = makeApp([])
  try {
    for (const [payload, expected] of [
      [{ missing: true }, 404],
      [{ stale: true }, 409],
      [{ invalid: true }, 422],
    ] as const) {
      const response = await app.inject({
        method: 'PATCH', url: '/api/v1/mind/notes/12', payload, headers: auth,
      })
      assert.equal(response.statusCode, expected)
      assert.equal(typeof response.json().detail, 'string')
    }
    const invalidId = await app.inject({ method: 'DELETE', url: '/api/v1/mind/notes/not-a-number', headers: auth })
    assert.equal(invalidId.statusCode, 422)
  } finally {
    await app.close()
  }
})
