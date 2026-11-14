import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import {
  createPostgresAdminUserStatusStore,
  registerAdminUserStatusRoutes,
  registerAdminUsersRoute,
} from '../../src/domains/admin/admin-users.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

const userIdA = '00000000-0000-4000-8000-000000000001'
const userIdB = '00000000-0000-4000-8000-000000000002'

function setup() {
  const calls: { sql: string; values: unknown[] }[] = []
  let queryError: Error | undefined
  const app = Fastify()
  registerAdminUsersRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    now: () => new Date('2026-11-13T14:23:45.000Z'),
    query: async (sql, values) => {
      calls.push({ sql, values })
      if (queryError) throw queryError
      if (sql.includes('FROM users')) {
        return [
          {
            id: userIdA, username: '合成账号甲', email: 'alpha@example.invalid', display_name: '甲',
            is_active: true, account_status: null, suspended_until: null, is_developer: null,
            created_at: new Date('2026-02-01T10:00:00.000Z'), token_limit_6h: 100,
            token_limit_weekly: 700, storage_limit_bytes: 4096, search_limit_daily: 20,
          },
          {
            id: userIdB, username: '合成账号乙', email: 'beta@example.invalid', display_name: null,
            is_active: false, account_status: 'suspended', suspended_until: new Date('2026-02-02T10:00:00.000Z'),
            is_developer: true, created_at: new Date('2026-01-01T10:00:00.000Z'), token_limit_6h: null,
            token_limit_weekly: null, storage_limit_bytes: null, search_limit_daily: null,
          },
        ]
      }
      if (sql.includes('FROM agent_usage')) {
        const start = new Date(String(values[0])).toISOString()
        return start === '2026-11-09T00:00:00.000Z'
          ? [{ user_id: userIdA, tokens: '31' }, { user_id: userIdB, tokens: '90' }]
          : [{ user_id: userIdA, tokens: '7' }, { user_id: userIdB, tokens: '5' }]
      }
      if (sql.includes('FROM files')) return [{ user_id: userIdA, storage_used: '40' }, { user_id: userIdB, storage_used: '11' }]
      if (sql.includes('FROM storage_quota_ledgers')) return [{ user_id: userIdA, storage_used: '55' }]
      return []
    },
  })
  return {
    app, calls,
    set queryError(error: Error | undefined) { queryError = error },
    cleanup: () => app.close(),
  }
}

test('未授权的用户列表查询被拒绝且不访问数据库', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('列表按创建时间倒序，q 对用户名和邮箱不区分大小写过滤，返回 Python 字段与窗口用量', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users?q=ALPHA', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      items: [{
        id: userIdA, username: '合成账号甲', email: 'alpha@example.invalid', display_name: '甲',
        is_active: true, account_status: 'active', suspended_until: null, is_developer: false,
        created_at: '2026-02-01T10:00:00.000+00:00', tokens_week: 31, tokens_6h: 7,
        storage_used: 55, token_limit_6h: 100, token_limit_weekly: 700,
        storage_limit_bytes: 4096, search_limit_daily: 20,
      }],
      total: 1,
    })
    assert.deepEqual(ctx.calls[0]!.values, [])
    assert.match(ctx.calls[0]!.sql, /ORDER BY created_at DESC/)
    assert.deepEqual(ctx.calls[1]!.values, [new Date('2026-11-09T00:00:00.000Z')])
    assert.deepEqual(ctx.calls[2]!.values, [new Date('2026-11-13T12:00:00.000Z')])
    assert.equal(ctx.calls.some(({ sql }) => sql.includes('storage_quota_ledgers')), true)
  } finally { await ctx.cleanup() }
})

test('搜索邮箱命中，保留账户状态和空配额，并为无本地账本的用户使用文件记录统计', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users?q=BETA@EXAMPLE', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.total, 1)
    assert.equal(body.items[0].id, userIdB)
    assert.equal(body.items[0].account_status, 'suspended')
    assert.equal(body.items[0].is_developer, true)
    assert.equal(body.items[0].tokens_week, 90)
    assert.equal(body.items[0].tokens_6h, 5)
    assert.equal(body.items[0].storage_used, 11)
    assert.equal(body.items[0].token_limit_6h, null)
    assert.equal(ctx.calls.some(({ sql }) => sql.includes('storage_quota_ledgers')), true)
  } finally { await ctx.cleanup() }
})

test('空搜索不筛选；查询错误返回脱敏 500', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users?q=', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().total, 2)
    ctx.queryError = new Error('synthetic private database failure')
    const failed = await ctx.app.inject({ url: '/api/v1/admin/users', headers: { authorization: 'admin' } })
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.body.includes('synthetic private database failure'), false)
  } finally { await ctx.cleanup() }
})

const managedUser = {
  id: userIdA,
  username: '合成用户甲',
  account_status: 'active',
  is_active: true,
  suspended_until: null,
}

function setupStatus({ exists = true, publishError = false }: { exists?: boolean; publishError?: boolean } = {}) {
  const timeline: string[] = []
  const audit: { admin: string; action: string; description: string }[] = []
  const transitions: { kind: string; userId: string; durationSeconds?: number; reason?: string; now: Date }[] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminUserStatusRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    store: {
      suspend: async (userId, durationSeconds, reason, now) => {
        transitions.push({ kind: 'suspend', userId, durationSeconds, reason, now })
        if (!exists) { timeline.push('lookup'); return null }
        timeline.push('commit')
        return { ...managedUser, id: userId, account_status: 'suspended', is_active: false, suspended_until: new Date(now.getTime() + durationSeconds * 1000) }
      },
      unsuspend: async (userId, now) => {
        transitions.push({ kind: 'unsuspend', userId, now })
        if (!exists) { timeline.push('lookup'); return null }
        timeline.push('commit')
        return { ...managedUser, id: userId, account_status: 'active', is_active: true, suspended_until: null }
      },
    },
    publishAuthStateChanged: async () => {
      timeline.push('publish')
      if (publishError) throw new Error('synthetic private Redis failure')
    },
    writeAuditLog: async (admin, action, description) => {
      timeline.push('audit')
      audit.push({ admin, action, description })
    },
    adminUsername: (request) => String(request.headers['x-admin-username'] ?? 'admin'),
    now: () => new Date('2026-11-13T12:00:00.000Z'),
  })
  return { app, timeline, audit, transitions, cleanup: () => app.close() }
}

test('冻结需显式确认；时长和原因按 SuspendRequest 边界在执行前验证', async () => {
  const ctx = setupStatus()
  try {
    const unauthorized = await ctx.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`, payload: { confirm: true },
    })
    assert.equal(unauthorized.statusCode, 401)
    assert.equal(ctx.transitions.length, 0)
    const noConfirm = await ctx.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`,
      headers: { authorization: 'admin' }, payload: { confirm: false },
    })
    assert.equal(noConfirm.statusCode, 400)
    assert.deepEqual(noConfirm.json(), { detail: '冻结操作需要确认' })
    const missingBody = await ctx.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`, headers: { authorization: 'admin' },
    })
    assert.equal(missingBody.statusCode, 422)
    for (const payload of [
      { confirm: true, duration_seconds: 59 },
      { confirm: true, duration_seconds: 2_592_001 },
      { confirm: true, reason: '' },
      { confirm: true, reason: 'x'.repeat(201) },
    ]) {
      const invalid = await ctx.app.inject({
        method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`,
        headers: { authorization: 'admin' }, payload,
      })
      assert.equal(invalid.statusCode, 422)
      assert.equal(typeof invalid.json().detail, 'string')
    }
    assert.equal(ctx.transitions.length, 0)
  } finally { await ctx.cleanup() }
})

test('冻结先提交状态与安全版本，再发布 auth-state 并写管理员审计', async () => {
  const ctx = setupStatus()
  try {
    const response = await ctx.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`,
      headers: { authorization: 'admin', 'x-admin-username': 'synthetic-admin' },
      payload: { confirm: true, duration_seconds: 600, reason: '重复越权' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: userIdA, account_status: 'suspended', is_active: false,
      suspended_until: '2026-11-13T12:10:00.000+00:00',
    })
    assert.deepEqual(ctx.timeline, ['commit', 'publish', 'audit'])
    assert.deepEqual(ctx.transitions, [{
      kind: 'suspend', userId: userIdA, durationSeconds: 600, reason: '重复越权',
      now: new Date('2026-11-13T12:00:00.000Z'),
    }])
    assert.deepEqual(ctx.audit, [{ admin: 'synthetic-admin', action: 'user', description: '冻结用户 合成用户甲' }])
  } finally { await ctx.cleanup() }
})

test('不存在用户返回404；auth-state 发布失败不撤销已提交状态且仍写审计', async () => {
  const missing = setupStatus({ exists: false })
  try {
    const response = await missing.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`,
      headers: { authorization: 'admin' }, payload: { confirm: true },
    })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { detail: '用户不存在' })
    assert.deepEqual(missing.timeline, ['lookup'])
    assert.equal(missing.audit.length, 0)
  } finally { await missing.cleanup() }

  const failedPublish = setupStatus({ publishError: true })
  try {
    const response = await failedPublish.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/suspend`,
      headers: { authorization: 'admin' }, payload: { confirm: true },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(failedPublish.timeline, ['commit', 'publish', 'audit'])
    assert.equal(failedPublish.transitions[0]!.durationSeconds, 1_800)
    assert.equal(failedPublish.transitions[0]!.reason, 'repeated_ownership_denied')
    assert.equal(failedPublish.audit.length, 1)
  } finally { await failedPublish.cleanup() }
})

test('解封清除冻结字段、递增安全版本后发布事件并审计；不存在用户返回404', async () => {
  const ctx = setupStatus()
  try {
    const response = await ctx.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/unsuspend`,
      headers: { authorization: 'admin', 'x-admin-username': 'synthetic-admin' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { id: userIdA, account_status: 'active', is_active: true })
    assert.deepEqual(ctx.timeline, ['commit', 'publish', 'audit'])
    assert.deepEqual(ctx.transitions, [{ kind: 'unsuspend', userId: userIdA, now: new Date('2026-11-13T12:00:00.000Z') }])
    assert.deepEqual(ctx.audit, [{ admin: 'synthetic-admin', action: 'user', description: '解封用户 合成用户甲' }])
  } finally { await ctx.cleanup() }

  const missing = setupStatus({ exists: false })
  try {
    const response = await missing.app.inject({
      method: 'POST', url: `/api/v1/admin/users/${userIdA}/unsuspend`, headers: { authorization: 'admin' },
    })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(missing.timeline, ['lookup'])
    assert.equal(missing.audit.length, 0)
  } finally { await missing.cleanup() }
})

test('PostgreSQL 状态存储在事务中锁定用户、递增 security_version 并提交后返回', async () => {
  const calls: { sql: string; values?: unknown[] }[] = []
  const suspended = { id: userIdA, username: '合成用户甲', account_status: 'suspended', is_active: false, suspended_until: new Date('2026-11-13T12:10:00.000Z') }
  const active = { id: userIdA, username: '合成用户甲', account_status: 'active', is_active: true, suspended_until: null }
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.startsWith('SELECT')) return { rows: [{ id: userIdA, username: '合成用户甲' }] }
      if (sql.startsWith('UPDATE')) return { rows: [sql.includes("account_status = 'active'") ? active : suspended] }
      return { rows: [] }
    },
    release: () => calls.push({ sql: 'RELEASE' }),
  }
  const store = createPostgresAdminUserStatusStore({ connect: async () => client } as never)
  const at = new Date('2026-11-13T12:00:00.000Z')
  const result = await store.suspend(userIdA, 600, '重复越权', at)
  assert.deepEqual(result, suspended)
  assert.equal(calls[0]!.sql, 'BEGIN')
  assert.match(calls[1]!.sql, /FROM users WHERE id = \$1::uuid FOR UPDATE/)
  assert.match(calls[2]!.sql, /security_version\s*=\s*COALESCE\(security_version, 0\) \+ 1/)
  assert.match(calls[2]!.sql, /is_active\s*=\s*FALSE/)
  assert.match(calls[2]!.sql, /suspended_reason\s*=\s*\$4/)
  assert.deepEqual(calls[2]!.values, [userIdA, at, 600, '重复越权'])
  assert.equal(calls[3]!.sql, 'COMMIT')
  assert.equal(calls[4]!.sql, 'RELEASE')

  calls.length = 0
  const cleared = await store.unsuspend(userIdA, at)
  assert.deepEqual(cleared, active)
  const update = calls.find(({ sql }) => sql.startsWith('UPDATE'))!
  assert.match(update.sql, /account_status = 'active', is_active = TRUE, suspended_until = NULL/)
  assert.match(update.sql, /suspended_reason = NULL, security_version = COALESCE\(security_version, 0\) \+ 1/)
  assert.deepEqual(update.values, [userIdA, at])
  assert.equal(calls.at(-2)!.sql, 'COMMIT')
  assert.equal(calls.at(-1)!.sql, 'RELEASE')
})
