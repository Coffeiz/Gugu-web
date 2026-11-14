import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { createApp } from '../../src/app.js'
import { createAdminAuthAdapter } from '../../src/domains/admin/admin-auth.js'
import { createAdminHostGuard } from '../../src/http/admin-host-guard.js'

test('Host registers Admin auth and storage snapshots with the same authenticated Admin guard', async () => {
  let authVersion = 0
  const adapter = createAdminAuthAdapter({
    username: 'admin-example',
    password: 'synthetic-admin-password',
    secret: 'synthetic-admin-host-secret',
    tokenExpiresMinutes: 60,
    getAuthVersion: async () => authVersion,
    incrementAuthVersion: async () => ++authVersion,
    rateLimit: async () => {},
    hostGuard: createAdminHostGuard('admin.example.test'),
  })
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    adminAuth: adapter,
    adminStorageSnapshots: {
      query: async (sql, values) => {
        queries.push({ sql, values })
        return [{ category: 'user_files', taken_at: '2026-11-13T11:00:00.000000', object_count: '4', total_bytes: '2048' }]
      },
      diskUsage: () => null,
      now: () => new Date('2026-11-13T12:00:00.000Z'),
    },
  })
  const adminHost = { host: 'admin.example.test' }
  try {
    const deniedHost = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: { host: 'other.example.test' },
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(deniedHost.statusCode, 404)

    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: adminHost,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    const token = login.json().access_token as string

    const unauthorized = await app.inject({
      url: '/api/v1/admin/ops/storage-snapshots', headers: adminHost,
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(queries.length, 0)

    const response = await app.inject({
      url: '/api/v1/admin/ops/storage-snapshots?days=30',
      headers: { ...adminHost, authorization: `Bearer ${token}` },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      categories: { user_files: [{ taken_at: '2026-11-13T11:00:00Z', object_count: 4, total_bytes: 2048 }] },
      disk: null,
    })
    assert.equal(queries.length, 1)
    assert.equal(queries[0]?.values[0], '2026-10-14T12:00:00.000Z')

    const logout = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/logout', headers: { ...adminHost, authorization: `Bearer ${token}` },
    })
    assert.equal(logout.statusCode, 200)
    assert.equal(authVersion, 1)
  } finally {
    await app.close()
  }
})

test('Admin login returns the configured unavailable response when no password is configured', async () => {
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      password: '',
      secret: 'synthetic-admin-host-secret',
      tokenExpiresMinutes: 60,
      getAuthVersion: async () => 0,
      incrementAuthVersion: async () => 1,
      rateLimit: async () => {},
      hostGuard: async (_request: FastifyRequest, _reply: FastifyReply) => {},
    }),
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login',
      payload: { username: 'admin', password: 'anything' },
    })
    assert.equal(response.statusCode, 503)
  } finally {
    await app.close()
  }
})

test('Host routes user suspension through Admin auth before post-commit effects', async () => {
  let authVersion = 0
  const effects: string[] = []
  const userId = '00000000-0000-4000-8000-000000000031'
  const adminHost = { host: 'admin.example.test' }
  const baseOptions = {
    appName: 'Gugu',
    isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example',
      password: 'synthetic-admin-password',
      secret: 'synthetic-admin-host-secret',
      tokenExpiresMinutes: 60,
      getAuthVersion: async () => authVersion,
      incrementAuthVersion: async () => ++authVersion,
      rateLimit: async () => {},
      hostGuard: createAdminHostGuard('admin.example.test'),
    }),
  }
  const app = createApp(Object.assign(baseOptions, {
    adminUserStatus: {
      store: {
        async suspend(id: string, duration: number, reason: string, now: Date) {
          effects.push(`commit:${id}:${duration}:${reason}`)
          return {
            id, username: '合成用户', account_status: 'suspended', is_active: false,
            suspended_until: new Date(now.getTime() + duration * 1000),
          }
        },
        async unsuspend(id: string) {
          effects.push(`commit:${id}`)
          return { id, username: '合成用户', account_status: 'active', is_active: true, suspended_until: null }
        },
      },
      publishAuthStateChanged: async (id: string) => { effects.push(`publish:${id}`) },
      adminUsername: (request: FastifyRequest) => request.adminIdentity?.username ?? 'admin',
      async writeAuditLog(username: string, action: string, description: string) {
        effects.push(`audit:${username}:${action}:${description}`)
      },
      now: () => new Date('2026-11-13T12:00:00.000Z'),
    },
  }))
  try {
    const denied = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userId}/suspend`, headers: adminHost,
      payload: { confirm: true },
    })
    assert.equal(denied.statusCode, 401)
    assert.deepEqual(effects, [])

    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: adminHost,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    const token = login.json().access_token as string
    const suspended = await app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userId}/suspend`,
      headers: { ...adminHost, authorization: `Bearer ${token}` },
      payload: { confirm: true, duration_seconds: 60, reason: '行为验证' },
    })
    assert.equal(suspended.statusCode, 200)
    assert.deepEqual(effects, [
      `commit:${userId}:60:行为验证`,
      `publish:${userId}`,
      'audit:admin-example:user:冻结用户 合成用户',
    ])
    assert.deepEqual(suspended.json(), {
      id: userId, account_status: 'suspended', is_active: false,
      suspended_until: '2026-11-13T12:01:00.000+00:00',
    })
  } finally {
    await app.close()
  }
})

test('Host exposes debug tail only through Admin auth and rejects a revoked token', async () => {
  let authVersion = 0
  let streamVersionReads = 0
  let revokeDuringStream = false
  const root = await mkdtemp(join(tmpdir(), 'gugu-admin-host-logs-'))
  const paths = {
    web: join(root, 'web.log'),
    worker: join(root, 'worker.log'),
    gateway: join(root, 'gateway.log'),
  }
  await writeFile(paths.web, '11-13 12:00:00 synthetic admin log\n')
  const baseOptions = {
    appName: 'Gugu',
    isReady: async () => true,
    adminAuth: createAdminAuthAdapter({
      username: 'admin-example',
      password: 'synthetic-admin-password',
      secret: 'synthetic-admin-host-secret',
      tokenExpiresMinutes: 60,
      getAuthVersion: async () => {
        if (revokeDuringStream) {
          streamVersionReads += 1
          return streamVersionReads === 1 ? 0 : 1
        }
        return authVersion
      },
      incrementAuthVersion: async () => ++authVersion,
      rateLimit: async () => {},
      hostGuard: createAdminHostGuard('admin.example.test'),
    }),
  }
  const app = createApp(Object.assign(baseOptions, {
    adminDebugLogs: { paths, webCandidates: [paths.web] },
  }))
  const adminHost = { host: 'admin.example.test' }
  try {
    const denied = await app.inject({
      url: '/api/v1/admin/debug/logs/tail', headers: adminHost,
    })
    assert.equal(denied.statusCode, 401)

    const login = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/login', headers: adminHost,
      payload: { username: 'admin-example', password: 'synthetic-admin-password' },
    })
    assert.equal(login.statusCode, 200)
    const token = login.json().access_token as string

    const tail = await app.inject({
      url: '/api/v1/admin/debug/logs/tail',
      headers: { ...adminHost, authorization: `Bearer ${token}` },
    })
    assert.equal(tail.statusCode, 200)
    assert.equal(tail.json().lines[0]?.line, '11-13 12:00:00 synthetic admin log')

    authVersion += 1
    const revoked = await app.inject({
      url: '/api/v1/admin/debug/logs/tail',
      headers: { ...adminHost, authorization: `Bearer ${token}` },
    })
    assert.equal(revoked.statusCode, 401)

    authVersion = 0
    revokeDuringStream = true
    const stream = await app.inject({
      url: '/api/v1/admin/debug/logs/stream',
      headers: { ...adminHost, authorization: `Bearer ${token}` },
    })
    assert.equal(stream.statusCode, 200)
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(streamVersionReads, 2)
    assert.equal(stream.body.includes('synthetic admin log'), false)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
