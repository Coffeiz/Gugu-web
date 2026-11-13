import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createApp, type UserAuthOptions } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'

const secret = 'synthetic-write-routes-secret'
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const auth = { authorization: `Bearer ${signedUserToken(secret, ownerId)}` }

function userAuth(overrides: Partial<UserAuthOptions> = {}) {
  return {
    secret,
    lookupUser: async (id: string) => ({
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
    ...overrides,
  }
}

test('项目创建从已验证身份生成 owner-bound RequestContext 并传递写请求元数据', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    createProject: async (context, input, metadata) => {
      calls.push({ context, input, metadata })
      return { id: 23, name: 'Node 项目' }
    },
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/',
      headers: {
        ...auth,
        'idempotency-key': 'create-23',
        'x-undo-context-id': 'tab-1',
        'x-client-id': 'web-tab-1',
      },
      payload: { name: 'Node 项目' },
    })
    assert.equal(response.statusCode, 201)
    assert.deepEqual(response.json(), { id: 23, name: 'Node 项目' })
    assert.deepEqual(calls, [{
      context: {
        identity: { userId: ownerId, securityVersion: 1 },
        data: { ownerId },
      },
      input: { name: 'Node 项目' },
      metadata: { idempotencyKey: 'create-23', undoContextId: 'tab-1', clientId: 'web-tab-1' },
    }])
  } finally {
    await app.close()
  }
})

test('未认证项目创建不调用持久化 callback，Core 字段错误保留 422', async () => {
  let calls = 0
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    createProject: async () => {
      calls++
      throw new CoreError('invalid_request', '名称不能为空')
    },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/projects', payload: { name: 'x' } })).statusCode, 401)
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: auth, payload: { name: 'x' } })
    assert.equal(invalid.statusCode, 422)
    assert.deepEqual(invalid.json(), { detail: '名称不能为空' })
    assert.equal(calls, 1)
  } finally {
    await app.close()
  }
})

test('日历创建路由绑定认证 RequestContext、传元数据并映射业务错误', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    events: {
      list: async () => [],
      get: async () => null,
      create: async (context, input, metadata) => {
        calls.push({ context, input, metadata })
        const error = new Error('项目不存在') as Error & { statusCode: number }
        error.statusCode = 400
        throw error
      },
    },
  })
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/events/',
      headers: { ...auth, 'x-undo-context-id': 'calendar-tab', 'x-client-id': 'browser' },
      payload: { title: 'Synthetic event', date: '2026-11-13' },
    })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { detail: '项目不存在' })
    assert.deepEqual(calls, [{
      context: {
        identity: { userId: ownerId, securityVersion: 1 },
        data: { ownerId },
      },
      input: { title: 'Synthetic event', date: '2026-11-13' },
      metadata: { idempotencyKey: null, undoContextId: 'calendar-tab', clientId: 'browser' },
    }])
  } finally {
    await app.close()
  }
})

test('logout 在鉴权后先持久撤销，再通知并清除认证 cookie', async () => {
  const calls: string[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth({
      async revokeUserSessions(id: string) { calls.push(`revoke:${id}`) },
      async publishAuthStateChanged(id: string) { calls.push(`publish:${id}`) },
    }),
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: auth })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(calls, [`revoke:${ownerId}`, `publish:${ownerId}`])
    assert.deepEqual(response.cookies.map(({ name, value }) => [name, value]), [
      ['gugu_user_access_token', ''],
      ['gugu_user_csrf_token', ''],
    ])
  } finally {
    await app.close()
  }
})

test('profile PATCH uses the authenticated identity and does not touch storage before auth', async () => {
  const statements: string[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    profile: {
      pool: {
        async connect() {
          return {
            async query(sql: string) {
              statements.push(sql)
              if (sql.startsWith('SELECT'))
                return { rows: [{ timezone: 'UTC', hashed_password: 'unused', security_version: 1 }] }
              return { rows: [] }
            },
            release() {},
          }
        },
      } as never,
      secret,
      lookupUser: async (id) => userAuth().lookupUser(id),
      async bumpContextRevision() {},
      async publishAuthStateChanged() {},
    },
  })
  try {
    const unauthorized = await app.inject({ method: 'PATCH', url: '/api/v1/auth/profile', payload: {} })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(statements.length, 0)

    const response = await app.inject({ method: 'PATCH', url: '/api/v1/auth/profile', headers: auth, payload: {} })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().id, ownerId)
    assert.deepEqual(statements, ['BEGIN', 'SELECT timezone, hashed_password, security_version FROM users WHERE id = $1 FOR UPDATE', 'COMMIT'])
  } finally {
    await app.close()
  }
})

test('workspace creation binds the owner from RequestContext and maps core errors', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    createWorkspace: async (id, input) => {
      calls.push({ id, input })
      throw new CoreError('conflict', '文件夹不存在')
    },
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/workspaces/', headers: auth,
      payload: { name: 'Synthetic workspace', folderId: 44 },
    })
    assert.equal(response.statusCode, 409)
    assert.deepEqual(response.json(), { detail: '文件夹不存在' })
    assert.deepEqual(calls, [{ id: ownerId, input: { name: 'Synthetic workspace', folderId: 44 } }])
  } finally {
    await app.close()
  }
})

test('calendar DELETE requires a version and maps owner-bound delete outcomes', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: userAuth(),
    events: {
      list: async () => [],
      get: async () => null,
      async delete(context, id, version, metadata) {
        calls.push({ context, id, version, metadata })
        const error = new Error('数据已被其他端修改，请刷新后重试') as Error & { statusCode: number }
        error.statusCode = 409
        throw error
      },
    },
  })
  try {
    const missingVersion = await app.inject({ method: 'DELETE', url: '/api/v1/events/17', headers: auth })
    assert.equal(missingVersion.statusCode, 422)
    assert.equal(calls.length, 0)
    const response = await app.inject({
      method: 'DELETE', url: '/api/v1/events/17?version=4',
      headers: { ...auth, 'x-undo-context-id': 'calendar-tab', 'x-client-id': 'browser' },
    })
    assert.equal(response.statusCode, 409)
    assert.deepEqual(response.json(), { detail: '数据已被其他端修改，请刷新后重试' })
    assert.deepEqual(calls, [{
      context: {
        identity: { userId: ownerId, securityVersion: 1 },
        data: { ownerId },
      },
      id: 17,
      version: 4,
      metadata: { idempotencyKey: null, undoContextId: 'calendar-tab', clientId: 'browser' },
    }])
  } finally {
    await app.close()
  }
})
