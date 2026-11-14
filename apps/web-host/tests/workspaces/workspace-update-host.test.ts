import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserAuthOptions } from '../../src/domains/auth/contracts.js'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-workspace-host-secret'
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

test('Host authenticates workspace PATCH and supplies owner from RequestContext, never request body', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    createWorkspace: async () => null,
    updateWorkspace: async (authenticatedOwnerId, workspaceId, input) => {
      calls.push([authenticatedOwnerId, workspaceId, input])
      return {
        id: workspaceId,
        name: '更名后的工作区',
        kind: 'directory',
        folderId: null,
        projectId: null,
        directoryId: 31,
        enabled: false,
        isDefault: false,
        boundSessionCount: 2,
      }
    },
  })
  try {
    const unauthorized = await app.inject({
      method: 'PATCH', url: '/api/v1/workspaces/41', payload: { name: '新名称' },
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(calls.length, 0)

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/workspaces/41',
      headers: authHeaders,
      payload: { name: '新名称', enabled: false, userId: '3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: 41,
      name: '更名后的工作区',
      kind: 'directory',
      folderId: null,
      projectId: null,
      directoryId: 31,
      enabled: false,
      isDefault: false,
      boundSessionCount: 2,
    })
    assert.deepEqual(calls, [[ownerId, 41, {
      name: '新名称',
      enabled: false,
      userId: '3f5cfa3d-9cb7-46af-923e-8ef0eb3e7da2',
    }]])
  } finally {
    await app.close()
  }
})
