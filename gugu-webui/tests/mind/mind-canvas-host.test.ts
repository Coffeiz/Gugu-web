import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-mind-canvas-route-secret'
const userId = 'aeb3ad07-740f-4945-af26-9dbefdb86487'

test('Mind canvas read routes require authentication and bind every read to the verified owner', async () => {
  const calls: unknown[][] = []
  const app = createApp({
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
    mindCanvasReads: {
      async listCanvases(...args) { calls.push(['canvases', ...args]); return [] },
      async listItems(...args) { calls.push(['items', ...args]); return [] },
      async listRelations(...args) { calls.push(['relations', ...args]); return [] },
      async canvasLocation(...args) { calls.push(['location', ...args]); return 7 },
    },
  })

  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases' })
    const headers = { authorization: `Bearer ${signedUserToken(secret, userId)}` }
    const canvases = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases?project_id=3', headers })
    const items = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases/7/items', headers })
    const relations = await app.inject({ method: 'GET', url: '/api/v1/mind/canvases/7/relations', headers })
    const location = await app.inject({ method: 'GET', url: '/api/v1/mind/nodes/9/canvas-location', headers })

    assert.equal(unauthenticated.statusCode, 401)
    assert.equal(canvases.statusCode, 200)
    assert.equal(items.statusCode, 200)
    assert.equal(relations.statusCode, 200)
    assert.deepEqual(location.json(), { canvasId: 7 })
    assert.deepEqual(calls, [
      ['canvases', userId, 3],
      ['items', userId, 7],
      ['relations', userId, 7],
      ['location', userId, 9],
    ])
  } finally {
    await app.close()
  }
})
