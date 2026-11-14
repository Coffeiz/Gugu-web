import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000031'
const secret = 'synthetic-folder-host-secret'
const apps: Array<{ close(): Promise<void> }> = []

function host() {
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id,
          username: 'sample',
          displayName: '示例用户',
          email: 'sample@example.invalid',
          avatarUrl: null,
          createdAt: null,
          timezone: null,
          emailSubscribed: false,
          imChannels: [],
          isActive: true,
          securityVersion: 1,
        } : null
      },
    },
    folderWrites: {
      async create(owner, input) {
        return {
          id: 8,
          projectId: input.projectId,
          workspaceDirectoryId: input.workspaceDirectoryId,
          parentId: input.parentId,
          name: input.name,
          fileCount: 0,
          folderCount: 0,
          version: 1,
          owner,
        }
      },
      async rename(owner, id, input) {
        return {
          id,
          projectId: null,
          workspaceDirectoryId: null,
          parentId: null,
          name: input.name,
          fileCount: 0,
          folderCount: 0,
          version: input.version + 1,
          owner,
        }
      },
      async move(owner, id, input) {
        return {
          id,
          projectId: input.projectId,
          workspaceDirectoryId: input.workspaceDirectoryId,
          parentId: input.parentId,
          name: '受认证目录',
          fileCount: 0,
          folderCount: 0,
          version: input.version + 1,
          owner,
        }
      },
    },
  })
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('folder write routes require user auth and derive owner from the authenticated Host context', async () => {
  const app = host()
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({
    method: 'POST',
    url: '/api/v1/folders',
    payload: { name: '未认证' },
  })
  const allowed = await app.inject({
    method: 'POST',
    url: '/api/v1/folders',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: '受认证目录', ownerId: 'another-user' },
  })
  const renamed = await app.inject({
    method: 'PATCH',
    url: '/api/v1/folders/8',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: '已改名', version: 1 },
  })
  const moved = await app.inject({
    method: 'PATCH',
    url: '/api/v1/folders/8/parent',
    headers: { authorization: `Bearer ${token}` },
    payload: { parentId: null, projectId: null, workspaceDirectoryId: null, version: 2, ownerId: 'another-user' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 201)
  assert.equal(allowed.json().owner, ownerId)
  assert.equal(renamed.statusCode, 200)
  assert.equal(renamed.json().owner, ownerId)
  assert.equal(moved.statusCode, 200)
  assert.equal(moved.json().owner, ownerId)
})
