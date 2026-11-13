import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserAuthOptions } from '../../src/domains/auth/contracts.js'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-workspace-list-host-secret'
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const authHeaders = { authorization: `Bearer ${signedUserToken(secret, ownerId)}` }

function userAuth(): UserAuthOptions {
  return {
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
  }
}

test('Host protects workspace listing and derives owner from RequestContext', async () => {
  const owners: string[] = []
  const snapshot = { workspaceSupported: true, items: [{ id: 12, name: 'Workspace' }] }
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    createWorkspace: async () => null,
    listWorkspaces: async (authenticatedOwnerId) => {
      owners.push(authenticatedOwnerId)
      return snapshot
    },
  })
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/workspaces' })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(owners.length, 0)

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/workspaces?ownerId=3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2',
      headers: authHeaders,
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), snapshot)
    assert.deepEqual(owners, [ownerId])
  } finally {
    await app.close()
  }
})
