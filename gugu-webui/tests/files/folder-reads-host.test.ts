import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000071'
const secret = 'synthetic-folder-read-host-secret'
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('folder detail and location require user auth and use the Host owner identity', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? {
          id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false,
          imChannels: [], isActive: true, securityVersion: 1,
        } : null
      },
    },
    folderReads: {
      async getFolder(owner, folderId) { calls.push(['folder', owner, folderId]); return { id: folderId } },
      async getFolderLocation(owner, folderId) { calls.push(['location', owner, folderId]); return { folder: { id: folderId }, ancestors: [] } },
      async resolvePaths(owner, filters) { calls.push(['resolve', owner, filters]); return [{ id: 5, name: '资料' }] },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({ url: '/api/v1/folders/4' })
  const detail = await app.inject({ url: '/api/v1/folders/4', headers: { authorization: `Bearer ${token}` } })
  const location = await app.inject({ url: '/api/v1/folders/4/location', headers: { authorization: `Bearer ${token}` } })
  const resolved = await app.inject({
    method: 'POST', url: '/api/v1/folders/resolve-paths',
    headers: { authorization: `Bearer ${token}` },
    payload: { projectId: 7, paths: ['资料/图片'] },
  })
  const unsafe = await app.inject({
    method: 'POST', url: '/api/v1/folders/resolve-paths',
    headers: { authorization: `Bearer ${token}` },
    payload: { paths: ['../越权'] },
  })
  const invalidId = await app.inject({ url: '/api/v1/folders/not-an-id', headers: { authorization: `Bearer ${token}` } })

  assert.equal(denied.statusCode, 401)
  assert.equal(detail.statusCode, 200)
  assert.equal(location.statusCode, 200)
  assert.equal(resolved.statusCode, 200)
  assert.deepEqual(resolved.json(), [{ id: 5, name: '资料' }])
  assert.equal(unsafe.statusCode, 422)
  assert.equal(invalidId.statusCode, 422)
  assert.deepEqual(calls, [
    ['folder', ownerId, 4], ['location', ownerId, 4],
    ['resolve', ownerId, { projectId: 7, workspaceDirectoryId: null, parentId: null, paths: ['资料/图片'] }],
  ])
})
