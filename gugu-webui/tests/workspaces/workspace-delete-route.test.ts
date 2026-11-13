import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-workspace-delete-route-secret'
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

function makeApp() {
  const calls: Array<[string, number]> = []
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
    deleteWorkspace: async (id, workspaceId) => {
      calls.push([id, workspaceId])
      if (id === otherOwnerId) throw new CoreError('not_found', '工作区不存在')
      return { ok: true, workspaceId }
    },
  })
  return { app, calls }
}

test('DELETE workspace uses the authenticated RequestContext owner and preserves 200 response', async () => {
  const { app, calls } = makeApp()
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/41',
      headers: { authorization: `Bearer ${signedUserToken(secret, ownerId)}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, workspaceId: 41 })
    assert.deepEqual(calls, [[ownerId, 41]])
  } finally {
    await app.close()
  }
})

test('DELETE workspace rejects missing authentication and maps owner-scoped not-found', async () => {
  const { app, calls } = makeApp()
  try {
    const unauthorized = await app.inject({ method: 'DELETE', url: '/api/v1/workspaces/41' })
    const foreign = await app.inject({
      method: 'DELETE',
      url: '/api/v1/workspaces/41',
      headers: { authorization: `Bearer ${signedUserToken(secret, otherOwnerId)}` },
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(foreign.statusCode, 404)
    assert.deepEqual(foreign.json(), { detail: '工作区不存在' })
    assert.deepEqual(calls, [[otherOwnerId, 41]])
  } finally {
    await app.close()
  }
})
