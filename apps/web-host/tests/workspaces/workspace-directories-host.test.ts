import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import type { WorkspaceDirectoryOperations } from '../../src/domains/workspaces/workspace-directories.js'
import { signedUserToken } from '../helpers/auth.js'

const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const secret = 'synthetic-workspace-directory-host-secret'

test('Workspace Directory Host 接线先认证，再从认证 RequestContext 绑定 owner', async () => {
  const owners: string[] = []
  const operations: WorkspaceDirectoryOperations = {
    async list(id) { owners.push(id); return [] },
    async create(id) { owners.push(id); throw new Error('unexpected create') },
    async update(id) { owners.push(id); throw new Error('unexpected update') },
    async previewDelete(id) { owners.push(id); throw new Error('unexpected preview') },
    async delete(id) { owners.push(id); throw new Error('unexpected delete') },
  }
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return {
          id, username: 'synthetic-user', displayName: null, email: 'synthetic@example.test',
          isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null,
          createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
        }
      },
    },
    workspaceDirectories: operations,
  })

  try {
    const denied = await app.inject({ url: '/api/v1/workspace-directories' })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(owners, [])

    const allowed = await app.inject({
      url: '/api/v1/workspace-directories',
      headers: { authorization: `Bearer ${signedUserToken(secret, ownerId)}` },
    })
    assert.equal(allowed.statusCode, 200)
    assert.deepEqual(allowed.json(), [])
    assert.deepEqual(owners, [ownerId])
  } finally {
    await app.close()
  }
})
