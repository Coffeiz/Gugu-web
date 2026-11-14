import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/domains/auth/auth.js'

const ownerId = '00000000-0000-4000-8000-000000000061'
const secret = 'synthetic-file-content-host-secret'
const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('正文保存 Host 只接受认证 owner 并向 Local adapter 传递版本和请求元数据', async () => {
  const calls: unknown[][] = []
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
    fileContents: {
      async update(...args) {
        calls.push(args)
        return { id: 23, version: 5 }
      },
    },
  })
  apps.push(app)
  const token = createUserToken(ownerId, 1, secret)

  const denied = await app.inject({
    method: 'PUT',
    url: '/api/v1/files/23/content',
    payload: { content: '不应写入', version: 4 },
  })
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/v1/files/23/content',
    headers: {
      authorization: `Bearer ${token}`,
      'x-undo-context-id': 'editor-tab',
      'x-client-id': 'web-client',
    },
    payload: { content: '更新正文', version: 4 },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(saved.statusCode, 200)
  assert.deepEqual(saved.json(), { id: 23, version: 5 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [ownerId, 23, '更新正文', 4, {
    idempotencyKey: null,
    undoContextId: 'editor-tab',
    clientId: 'web-client',
  }])
})
