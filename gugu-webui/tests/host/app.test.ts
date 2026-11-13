import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'

const apps: Array<{ close(): Promise<void> }> = []

function testApp(options: Parameters<typeof createApp>[0]) {
  const app = createApp(options)
  apps.push(app)
  return app
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

test('GET /health preserves the existing Web health response', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok', app: '合成测试应用' })
})

test('POST /api/v1/auth/register reports unavailable instead of an unregistered 404', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username: 'sample', email: 'sample@example.invalid', password: 'secret' },
  })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { detail: '注册服务暂不可用，请稍后重试' })
})

test('POST /api/v1/auth/registration-code reports unavailable instead of an unregistered 404', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/registration-code',
    payload: { email: 'sample@example.invalid' },
  })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { detail: '邮箱验证码注册当前不可用' })
})

test('GET /health/ready reports an unavailable data runtime without claiming readiness', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => false })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
})

test('GET /health/ready reports readiness only after the data runtime is available', async () => {
  const app = testApp({ appName: '合成测试应用', isReady: async () => true })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok' })
})

test('GET /health/ready hides readiness dependency errors from HTTP clients', async () => {
  let reportedFailure = false
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => {
      throw new Error('synthetic database credential detail')
    },
    onReadinessError: () => {
      reportedFailure = true
    },
  })

  const response = await app.inject({ method: 'GET', url: '/health/ready' })

  assert.equal(response.statusCode, 503)
  assert.deepEqual(response.json(), { status: 'not_ready' })
  assert.equal(response.body.includes('synthetic database credential detail'), false)
  assert.equal(reportedFailure, true)
})

test('Admin user list is registered with the Host Admin guard and query dependency', async () => {
  const calls: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin')
          return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminUsers: {
      storageBackend: 'oss',
      async query(sql) {
        calls.push(sql)
        return []
      },
    },
  })

  const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/users' })
  assert.equal(denied.statusCode, 401)
  assert.equal(calls.length, 0)

  const allowed = await app.inject({
    method: 'GET', url: '/api/v1/admin/users', headers: { authorization: 'test-admin' },
  })
  assert.equal(allowed.statusCode, 200)
  assert.deepEqual(allowed.json(), { items: [], total: 0 })
  assert.equal(calls.length, 4)
})

test('project PATCH is mounted behind user authentication', async () => {
  const calls: unknown[][] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    userAuth: { secret: 'test-secret', async lookupUser() { return null } },
    updateProject: async (...args) => {
      calls.push(args)
      return { id: 17 }
    },
  })

  const response = await app.inject({
    method: 'PATCH', url: '/api/v1/projects/17', payload: { version: 1, name: '项目' },
  })

  assert.equal(response.statusCode, 401)
  assert.equal(calls.length, 0)
})

test('global and per-user Admin security events use the Host guard and injected query adapters', async () => {
  const queries: string[] = []
  const app = testApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin')
          return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
    adminSecurityEvents: {
      fingerprintUserId: (id) => `fingerprint:${id}`,
      async query(sql) { queries.push(sql); return [] },
    },
    adminUserSecurityEvents: {
      async query(sql) {
        queries.push(sql)
        return sql.includes('FROM users') ? [{ id: '00000000-0000-4000-8000-000000000001' }] : []
      },
    },
  })

  const deniedGlobal = await app.inject({ url: '/api/v1/admin/audit-log/security-events' })
  const deniedUser = await app.inject({ url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events' })
  assert.equal(deniedGlobal.statusCode, 401)
  assert.equal(deniedUser.statusCode, 401)
  assert.equal(queries.length, 0)

  const headers = { authorization: 'test-admin' }
  const global = await app.inject({ url: '/api/v1/admin/audit-log/security-events', headers })
  const user = await app.inject({ url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events', headers })
  assert.equal(global.statusCode, 200)
  assert.equal(user.statusCode, 200)
  assert.equal(queries.length, 3)
  const invalidGlobal = await app.inject({
    url: '/api/v1/admin/audit-log/security-events?limit=0', headers,
  })
  const invalidUser = await app.inject({
    url: '/api/v1/admin/users/00000000-0000-4000-8000-000000000001/security-events?limit=0', headers,
  })
  assert.equal(invalidGlobal.statusCode, 422)
  assert.equal(invalidUser.statusCode, 422)
  assert.equal(queries.length, 3)
  await app.close()
})
