import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000091'
const secret = 'synthetic-file-archive-host-secret'
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('Node Host 认证归档请求并使用认证 owner 调用 Local 适配器', async () => {
  const calls: unknown[][] = []
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
    fileArchives: {
      async archive(...args) { calls.push(args); return { id: 88, displayName: '资料', ext: 'zip' } },
      async unarchive(...args) { calls.push(args); return { created_count: 0 } },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({ method: 'POST', url: '/api/v1/files/archive', payload: { folderIds: [9] } })
  const allowed = await app.inject({
    method: 'POST', url: '/api/v1/files/archive',
    headers: { authorization: `Bearer ${token}`, 'x-client-id': 'archive-ui' },
    payload: { fileIds: [], folderIds: [9], ownerId: '22222222-2222-4222-8222-222222222222' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(allowed.statusCode, 201)
  assert.deepEqual(allowed.json(), { id: 88, displayName: '资料', ext: 'zip' })
  assert.deepEqual(calls, [[ownerId, { fileIds: [], folderIds: [9], folderId: undefined, name: undefined },
    { idempotencyKey: null, undoContextId: null, clientId: 'archive-ui' }]])
})
