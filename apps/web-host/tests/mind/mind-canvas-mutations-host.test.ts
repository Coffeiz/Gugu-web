import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { MindCanvasMutationError } from '../../src/domains/mind/application/mind-canvas-mutations.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-canvas-mutation-secret'
const userId = 'bc941c76-01dd-42ba-a4ba-61fb9df283fa'

test('Mind canvas mutation routes authenticate, scope by verified owner, pass write metadata, and map domain errors', async () => {
  const calls: unknown[][] = []
  const app = createApp({
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
    mindCanvasMutations: {
      async create(...args) {
        calls.push(['create', ...args])
        return { id: 7, title: '新画布', projectId: null, data: {}, createdAt: '2026-11-14T00:00:00+00:00', updatedAt: '2026-11-14T00:00:00+00:00' }
      },
      async update(...args) {
        calls.push(['update', ...args])
        if (args[1] === 8)
          throw new MindCanvasMutationError(404, '画布不存在')
        return { id: args[1], title: '更新画布', projectId: null, data: {}, createdAt: '2026-11-14T00:00:00+00:00', updatedAt: '2026-11-14T00:00:00+00:00' }
      },
      async delete(...args) {
        calls.push(['delete', ...args])
        if (args[1] === 8) throw new MindCanvasMutationError(404, '画布不存在')
      },
    },
  })

  try {
    const unauthorized = await app.inject({ method: 'POST', url: '/api/v1/mind/canvases', payload: {} })
    const headers = {
      authorization: `Bearer ${signedUserToken(secret, userId)}`,
      'x-undo-context-id': 'undo-context',
      'x-client-id': 'mind-client',
    }
    const created = await app.inject({ method: 'POST', url: '/api/v1/mind/canvases', headers, payload: { title: '新画布' } })
    const updated = await app.inject({ method: 'PATCH', url: '/api/v1/mind/canvases/7', headers, payload: { title: '更新画布' } })
    const invalidId = await app.inject({ method: 'PATCH', url: '/api/v1/mind/canvases/nope', headers, payload: {} })
    const missing = await app.inject({ method: 'PATCH', url: '/api/v1/mind/canvases/8', headers, payload: {} })
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/mind/canvases/7', headers })
    const missingDelete = await app.inject({ method: 'DELETE', url: '/api/v1/mind/canvases/8', headers })
    const invalidDelete = await app.inject({ method: 'DELETE', url: '/api/v1/mind/canvases/nope', headers })

    assert.equal(unauthorized.statusCode, 401)
    assert.equal(created.statusCode, 201)
    assert.equal(updated.statusCode, 200)
    assert.equal(invalidId.statusCode, 422)
    assert.equal(missing.statusCode, 404)
    assert.equal(deleted.statusCode, 204)
    assert.equal(missingDelete.statusCode, 404)
    assert.equal(invalidDelete.statusCode, 422)
    assert.deepEqual(calls, [
      ['create', userId, { title: '新画布' }, { idempotencyKey: null, undoContextId: 'undo-context', clientId: 'mind-client' }],
      ['update', userId, 7, { title: '更新画布' }, { idempotencyKey: null, undoContextId: 'undo-context', clientId: 'mind-client' }],
      ['update', userId, 8, {}, { idempotencyKey: null, undoContextId: 'undo-context', clientId: 'mind-client' }],
      ['delete', userId, 7, { idempotencyKey: null, undoContextId: 'undo-context', clientId: 'mind-client' }],
      ['delete', userId, 8, { idempotencyKey: null, undoContextId: 'undo-context', clientId: 'mind-client' }],
    ])
  } finally {
    await app.close()
  }
})
