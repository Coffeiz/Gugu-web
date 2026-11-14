import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const secret = 'synthetic-project-trash-host-secret'

test('Host exposes owner-scoped project trash routes and forwards write metadata', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        if (id !== ownerId) return null
        return {
          id: ownerId, username: 'host-user', displayName: 'Host User', email: '',
          isActive: true, avatarUrl: null, createdAt: '2026-11-01', imChannels: [],
          timezone: 'UTC', emailSubscribed: false, securityVersion: 1,
        }
      },
    },
    deleteProject: async (owner: string, projectId: number, metadata: { idempotencyKey: string | null; undoContextId: string | null; clientId: string | null }) => {
      calls.push(['delete', owner, projectId, metadata])
    },
    restoreProject: async (owner: string, projectId: number, metadata: { idempotencyKey: string | null; undoContextId: string | null; clientId: string | null }) => {
      calls.push(['restore', owner, projectId, metadata])
      return { id: projectId, name: 'Restored project' }
    },
  })

  try {
    const token = signedUserToken(secret, ownerId)
    const headers = {
      authorization: `Bearer ${token}`,
      'x-undo-context-id': 'tab-undo',
      'x-client-id': 'web-client',
    }
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/17', headers })
    const restored = await app.inject({
      method: 'POST', url: '/api/v1/projects/17/restore',
      headers: { ...headers, 'content-type': 'application/json' },
    })
    const malformed = await app.inject({
      method: 'POST', url: '/api/v1/projects/17/restore',
      headers: { ...headers, 'content-type': 'application/json' }, payload: '{',
    })

    assert.equal(deleted.statusCode, 204)
    assert.equal(restored.statusCode, 200)
    assert.equal(malformed.statusCode, 400)
    assert.deepEqual(restored.json(), { id: 17, name: 'Restored project' })
    assert.deepEqual(calls, [
      ['delete', ownerId, 17, { idempotencyKey: null, undoContextId: 'tab-undo', clientId: 'web-client' }],
      ['restore', ownerId, 17, { idempotencyKey: null, undoContextId: 'tab-undo', clientId: 'web-client' }],
    ])
  } finally {
    await app.close()
  }
})

test('project trash routes remain unavailable without configured callbacks', async () => {
  const app = createApp({ appName: 'Gugu', isReady: async () => true })
  try {
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/projects/17' })
    const restored = await app.inject({ method: 'POST', url: '/api/v1/projects/17/restore' })
    assert.equal(deleted.statusCode, 404)
    assert.equal(restored.statusCode, 404)
  } finally {
    await app.close()
  }
})
