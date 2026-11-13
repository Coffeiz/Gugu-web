import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminUserRiskRoute } from '../../src/domains/admin/admin-user-risk.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

function setup(rowsOverride?: Record<string, unknown>[]) {
  const calls: { sql: string; values: unknown[] }[] = []
  const rows: Record<string, unknown>[] = rowsOverride ?? [
    {
      id: '00000000-0000-4000-8000-000000000001', username: '合成账号甲', email: 'synthetic@example.invalid',
      display_name: '甲', account_status: 'active', is_active: true, suspended_until: null,
      suspended_reason: null, security_version: 2, recent_event_count: 10, visible_event_count: 12,
      last_event_at: '2026-11-13T12:30:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000002', username: '合成账号乙', email: 'other@example.invalid',
      display_name: null, account_status: 'suspended', is_active: false, suspended_until: '2026-11-13T13:00:00.000Z',
      suspended_reason: 'admin_manual_suspend', security_version: 4, recent_event_count: 0, visible_event_count: 0,
      last_event_at: null, created_at: '2026-02-01T00:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-000000000003', username: '合成账号丙', email: 'third@example.invalid',
      display_name: '丙', account_status: 'active', is_active: true, suspended_until: null,
      suspended_reason: null, security_version: 1, recent_event_count: 5, visible_event_count: 8,
      last_event_at: '2026-11-13T12:31:00.000Z', created_at: '2026-03-01T00:00:00.000Z',
    },
  ]
  let queryError: Error | undefined
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminUserRiskRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    query: async (sql, values) => {
      calls.push({ sql, values })
      if (queryError) throw queryError
      return rows
    },
    now: () => new Date('2026-11-13T12:34:56.000Z'),
  })
  return { app, calls, set queryError(error: Error | undefined) { queryError = error }, cleanup: () => app.close() }
}

test('未授权的风险用户查询被拒绝且不访问数据库', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users/risk' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('风险列表按展示窗口聚合、保留已冻结用户并应用五分钟策略阈值', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users/risk?window_minutes=60&limit=1', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.total, 3)
    assert.equal(body.window_minutes, 60)
    assert.equal(body.policy_window_minutes, 5)
    assert.deepEqual(body.items.map((item: { risk_action: string }) => item.risk_action), ['suspended', 'logged', 'throttled'])
    assert.equal(body.items[0].visible_event_count, 12)
    assert.equal(body.items[0].recent_event_count, 10)
    assert.equal(body.items[0].last_event_at, '2026-11-13T12:30:00.000+00:00')
    assert.equal(body.items[1].account_status, 'suspended')
    assert.equal(body.items[1].visible_event_count, 0)
    assert.deepEqual(ctx.calls[0]!.values, [
      new Date('2026-11-13T11:34:56.000Z').toISOString(),
      new Date('2026-11-13T12:29:56.000Z').toISOString(),
    ])
    assert.match(ctx.calls[0]!.sql, /security_events/)
    assert.match(ctx.calls[0]!.sql, /WHERE u\.account_status <> 'active' OR visible_events\.user_id IS NOT NULL/)
    assert.match(ctx.calls[0]!.sql, /ORDER BY u\.updated_at DESC/)
  } finally { await ctx.cleanup() }
})

test('展示窗口接受Python的上下界；没有分页参数时即使带limit仍返回全部符合条件的项目', async () => {
  const ctx = setup()
  try {
    for (const windowMinutes of [1, 43_200]) {
      const response = await ctx.app.inject({
        url: `/api/v1/admin/users/risk?window_minutes=${windowMinutes}&limit=1`,
        headers: { authorization: 'admin' },
      })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().window_minutes, windowMinutes)
      assert.equal(response.json().total, 3)
      const call = ctx.calls.at(-1)!
      assert.deepEqual(call.values, [
        new Date(new Date('2026-11-13T12:34:56.000Z').getTime() - windowMinutes * 60_000).toISOString(),
        new Date('2026-11-13T12:29:56.000Z').toISOString(),
      ])
    }
  } finally { await ctx.cleanup() }
})

test('无冻结账户且没有可见事件时返回空列表，不伪造缺失记录', async () => {
  const ctx = setup([])
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users/risk', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { items: [], total: 0, window_minutes: 1440, policy_window_minutes: 5 })
  } finally { await ctx.cleanup() }
})

test('默认窗口为一天，非法窗口在查询前拒绝，查询错误不回显数据库细节', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/users/risk', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().window_minutes, 1440)
    assert.equal(ctx.calls[0]!.values[0], new Date('2026-11-12T12:34:56.000Z').toISOString())
    for (const value of ['0', '43201']) {
      const invalid = await ctx.app.inject({ url: `/api/v1/admin/users/risk?window_minutes=${value}`, headers: { authorization: 'admin' } })
      assert.equal(invalid.statusCode, 422)
      assert.equal(typeof invalid.json().detail, 'string')
    }
    assert.equal(ctx.calls.length, 1)
    ctx.queryError = new Error('synthetic private database failure')
    const failed = await ctx.app.inject({ url: '/api/v1/admin/users/risk', headers: { authorization: 'admin' } })
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.body.includes('synthetic private database failure'), false)
  } finally { await ctx.cleanup() }
})
