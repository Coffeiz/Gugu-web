import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { createSecurityEventFingerprint, registerAdminSecurityEventRoutes } from '../../src/domains/admin/admin-audit-log.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

type DbRow = Record<string, unknown>

test('Host security fingerprint matches the Python HMAC-SHA256 key/value byte contract', () => {
  const fingerprint = createSecurityEventFingerprint('synthetic-secret-key')
  assert.equal(
    fingerprint('00000000-0000-4000-8000-000000000001'),
    createHmac('sha256', 'synthetic-secret-key').update('00000000-0000-4000-8000-000000000001', 'utf8').digest('hex'),
  )
})

function eventRow(id: number, occurredAt: string, userId: string): DbRow {
  return {
    id, user_id: userId, event_type: 'ownership.denied', resource_type: 'Project',
    resource_fingerprint: 'a'.repeat(64), owner_fingerprint: null, client_fingerprint: 'b'.repeat(64),
    ip_fingerprint: 'c'.repeat(64), user_agent_fingerprint: null, action: 'logged',
    reason_code: 'ownership_mismatch', occurred_at: occurredAt,
    metadata_json: { source: 'synthetic', private_note: 'must-not-be-returned' },
    raw_ip: '192.0.2.99', secret: 'must-not-be-returned',
  }
}

function setup(rows: DbRow[] = []) {
  const calls: { sql: string; params: unknown[] }[] = []
  let queryError: Error | undefined
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminSecurityEventRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    query: async (sql, params) => {
      calls.push({ sql, params })
      if (queryError) throw queryError
      return rows.slice(0, Number(params.at(-1)))
    },
    fingerprintUserId: (id) => createHmac('sha256', 'synthetic-test-key').update(id).digest('hex'),
  })
  return { app, calls, set queryError(error: Error | undefined) { queryError = error }, cleanup: () => app.close() }
}

test('未授权的安全事件查询被拒绝且不访问数据库', async () => {
  const ctx = setup([eventRow(1, '2026-11-13T00:00:00.000Z', '00000000-0000-4000-8000-000000000001')])
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/audit-log/security-events' })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('筛选条件使用参数绑定，按时间窗/上限查询并只投影安全事件字段', async () => {
  const ctx = setup([
    eventRow(7, '2026-11-12T12:00:00.000Z', '00000000-0000-4000-8000-000000000007'),
    eventRow(8, '2026-11-12T11:00:00.000Z', '00000000-0000-4000-8000-000000000008'),
  ])
  try {
    const response = await ctx.app.inject({
      url: '/api/v1/admin/audit-log/security-events?event_type=ownership.denied&action=logged&resource_type=Project&user_id=00000000-0000-4000-8000-000000000007&since_minutes=60&limit=1',
      headers: { authorization: 'admin' },
    })
    assert.equal(response.statusCode, 200)
    const call = ctx.calls[0]!
    assert.match(call.sql, /occurred_at\s*>=\s*\$1/)
    assert.match(call.sql, /event_type\s*=\s*\$2/)
    assert.match(call.sql, /action\s*=\s*\$3/)
    assert.match(call.sql, /resource_type\s*=\s*\$4/)
    assert.match(call.sql, /user_id\s*=\s*\$5/)
    assert.match(call.sql, /ORDER BY occurred_at DESC LIMIT \$6/)
    assert.deepEqual(call.params.slice(1), ['ownership.denied', 'logged', 'Project', '00000000-0000-4000-8000-000000000007', 1])
    assert.ok(call.params[0] instanceof Date)
    assert.equal((Date.now() - (call.params[0] as Date).getTime()) >= 60 * 60 * 1000 - 5000, true)
    const body = response.json()
    assert.equal(body.total, 1)
    assert.equal(body.since_minutes, 60)
    assert.equal(body.items[0].user_id, createHmac('sha256', 'synthetic-test-key').update('00000000-0000-4000-8000-000000000007').digest('hex'))
    assert.equal(body.items[0].event_type, 'ownership.denied')
    assert.equal(body.items[0].occurred_at, '2026-11-12T12:00:00.000Z')
    assert.equal(JSON.stringify(body).includes('must-not-be-returned'), false)
    assert.equal(JSON.stringify(body).includes('192.0.2.99'), false)
    assert.equal(JSON.stringify(body).includes('00000000-0000-4000-8000-000000000007'), false)
  } finally { await ctx.cleanup() }
})

test('默认时间窗与条数匹配Python默认值，超界参数和非法UUID在查询前拒绝', async () => {
  const ctx = setup()
  try {
    const before = Date.now()
    const defaults = await ctx.app.inject({ url: '/api/v1/admin/audit-log/security-events', headers: { authorization: 'admin' } })
    assert.equal(defaults.statusCode, 200)
    assert.equal(defaults.json().since_minutes, 1440)
    assert.deepEqual(ctx.calls[0]!.params.slice(1), [200])
    const since = ctx.calls[0]!.params[0] as Date
    assert.ok(since.getTime() >= before - 1440 * 60 * 1000)
    assert.ok(since.getTime() <= before - 1440 * 60 * 1000 + 5000)
    for (const suffix of ['?limit=0', '?limit=501', '?since_minutes=0', '?since_minutes=129601', '?user_id=bad']) {
      const invalid = await ctx.app.inject({ url: `/api/v1/admin/audit-log/security-events${suffix}`, headers: { authorization: 'admin' } })
      assert.equal(invalid.statusCode, 422)
      assert.equal(typeof invalid.json().detail, 'string')
    }
    assert.equal(ctx.calls.length, 1)
  } finally { await ctx.cleanup() }
})

test('数据库失败只返回通用错误，不回显异常或敏感内容', async () => {
  const ctx = setup()
  try {
    ctx.queryError = new Error('secret synthetic database credential')
    const response = await ctx.app.inject({ url: '/api/v1/admin/audit-log/security-events', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 500)
    assert.equal(response.body.includes('secret synthetic database credential'), false)
  } finally { await ctx.cleanup() }
})
