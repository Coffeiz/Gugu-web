import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminAnalyticsSummaryRoute } from '../src/domains/admin/admin-analytics-summary.js'

const summary = {
  users: { total: 4, wau: 2, active_30d: 3, new_7d: 1, new_30d: 2 },
  projects: { total: 5, pending: 1, active: 2, done: 2 },
  sessions: { total: 8, web: 5, im: 3 },
  im_bots: { users_with_bot: 2, adoption_rate: 0.5, users_by_platform: { qq: 1, feishu: 1 } },
  agent: { total_calls: 20, tokens_in: 1000, tokens_out: 700, today_calls: 3, today_tokens_in: 120, today_tokens_out: 80 },
  funnel: { registered: 4, created_project: 3, completed_project: 2, retention_7d: 0.5, retention_30d: 0.25, retained_7d: 1, retained_30d: 1, cohort_7d: 2, cohort_30d: 4 },
  retention_metrics: { created_project_users: 3, second_project_users: 1, week_active_project_users: 2 },
}

function setup() {
  const calls: { sql: string; values: unknown[] }[] = []
  let queryError: Error | undefined
  const app = Fastify()
  registerAdminAnalyticsSummaryRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    query: async (sql, values) => {
      calls.push({ sql, values })
      if (queryError) throw queryError
      return [{ summary }]
    },
    now: () => new Date('2026-11-13T12:34:56.000Z'),
    serverTimezone: 'Asia/Shanghai',
  })
  return { app, calls, set queryError(error: Error | undefined) { queryError = error }, cleanup: () => app.close() }
}

test('未授权分析请求被拒绝且不查询数据库', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/analytics/summary' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('summary返回完整稳定契约并传递开发者、BYOK与用户时区筛选', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({
      url: '/api/v1/admin/analytics/summary?exclude_dev=true&include_byok=true&timezone=America%2FLos_Angeles',
      headers: { authorization: 'admin' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), summary)
    assert.equal(ctx.calls.length, 1)
    assert.deepEqual(ctx.calls[0]!.values.slice(2), [true, true])
    assert.equal(ctx.calls[0]!.values[0], new Date('2026-11-13T12:34:56.000Z').toISOString())
    assert.equal(ctx.calls[0]!.values[1], new Date('2026-11-13T08:00:00.000Z').toISOString())
  } finally { await ctx.cleanup() }
})

test('省略筛选项采用Python默认值，未知时区回退serverTimezone', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/analytics/summary', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(ctx.calls[0]!.values.slice(2), [false, false])
    assert.equal(ctx.calls[0]!.values[1], new Date('2026-11-12T16:00:00.000Z').toISOString())
  } finally { await ctx.cleanup() }
})

test('非法布尔值在数据库调用前拒绝，数据库错误不泄露底层内容', async () => {
  const ctx = setup()
  try {
    const invalid = await ctx.app.inject({ url: '/api/v1/admin/analytics/summary?exclude_dev=sometimes', headers: { authorization: 'admin' } })
    assert.equal(invalid.statusCode, 400)
    assert.equal(ctx.calls.length, 0)
    ctx.queryError = new Error('synthetic private database detail')
    const failed = await ctx.app.inject({ url: '/api/v1/admin/analytics/summary', headers: { authorization: 'admin' } })
    assert.equal(failed.statusCode, 500)
    assert.equal(failed.body.includes('synthetic private database detail'), false)
  } finally { await ctx.cleanup() }
})
