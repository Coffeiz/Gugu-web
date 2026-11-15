import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000041'
const secret = 'synthetic-folder-delete-secret'
const apps: Array<{ close(): Promise<void> }> = []

test('folder delete requires authentication and passes only the authenticated owner with undo and event metadata', async () => {
  const calls: unknown[][] = []
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) {
        return id === ownerId ? { id, username: 'sample', displayName: '示例用户', email: 'sample@example.invalid',
          avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [],
          isActive: true, securityVersion: 1 } : null
      },
    },
    folderDelete: { async remove(...args: unknown[]) { calls.push(args) } },
  } as never)
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)
  const denied = await app.inject({ method: 'DELETE', url: '/api/v1/folders/19' })
  const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/folders/19',
    headers: { authorization: `Bearer ${token}`, 'x-undo-context-id': 'undo-folder-19', 'x-client-id': 'client-a' } })
  assert.equal(denied.statusCode, 401)
  assert.equal(deleted.statusCode, 204)
  assert.deepEqual(calls, [[ownerId, 19, { undoContextId: 'undo-folder-19', origin: 'client-a' }]])
})

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
