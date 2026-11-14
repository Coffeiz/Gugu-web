import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerAdminOpsSummaryRoute } from '../../src/domains/admin/admin-ops-summary.js'

function setup(hashes: Record<string, Record<string, string>> = {}) {
  const reads: string[] = []
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminOpsSummaryRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
    },
    hgetall: async (key) => { reads.push(key); return hashes[key] ?? {} },
    now: () => new Date('2026-11-13T12:00:00.000Z'),
  })
  return { app, reads, close: () => app.close() }
}

test('未授权的运维摘要请求不读取 Redis', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/ops/summary' })
    assert.equal(response.statusCode, 401)
    assert.deepEqual(ctx.reads, [])
  } finally { await ctx.close() }
})

test('运维摘要按日合并工具、安全、邮件和文件系统授权计数，敏感邮件内容不进入响应', async () => {
  const ctx = setup({
    'ops:tool:20261113': {
      'write:calls': '10', 'write:fails': '2', 'write:ms_sum': '1000',
      'read:calls': '5', 'read:fails': '0', 'read:ms_sum': '500',
    },
    'ops:tool:20261112': { 'write:calls': '2', 'write:fails': '1', 'write:ms_sum': '400' },
    'ops:lat:20261113': { '50': '8', '100': '3' },
    'ops:lat:20261112': { '250': '1' },
    'ops:sec:20261113': { 'ownership.denied': '3' },
    'ops:email:20261113': { calls: '4', sent: '3', failed: '1', ms_sum: '1200', 'error:timeout': '2' },
    'ops:filesystem-auth:20261113': { 'session:requested': '2', 'session:revoked': '1', 'scheduled_task:granted': '3', 'unknown:denied': '9' },
  })
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/ops/summary?days=2', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(ctx.reads, [
      'ops:tool:20261113', 'ops:lat:20261113',
      'ops:tool:20261112', 'ops:lat:20261112',
      'ops:sec:20261113', 'ops:sec:20261112',
      'ops:email:20261113', 'ops:email:20261112',
      'ops:filesystem-auth:20261113', 'ops:filesystem-auth:20261112',
    ])
    const body = response.json()
    assert.deepEqual(body, {
      days: 2, total_calls: 17, total_fails: 3, fail_rate: 0.1765, p99_ms: 250,
      latency_buckets: { '50': 8, '100': 3, '250': 1, '500': 0, '1000': 0, '2500': 0, '5000': 0, '10000': 0, '30000': 0, inf: 0 },
      tools: [
        { tool: 'write', calls: 12, fails: 3, fail_rate: 0.25, avg_ms: 116 },
        { tool: 'read', calls: 5, fails: 0, fail_rate: 0, avg_ms: 100 },
      ],
      security: {
        'ownership.denied': 3, 'confirm-gate.bypassed': 0,
        'security_event.write_failed': 0, 'filesystem.authorization.denied': 0,
      },
      filesystem_authorization: {
        session: { requested: 2, granted: 0, revoked: 1, denied: 0 },
        scheduled_task: { requested: 0, granted: 3, revoked: 0, denied: 0 },
      },
      email_delivery: { calls: 4, sent: 3, failed: 1, ms_sum: 1200, errors: { timeout: 2 }, avg_ms: 300, fail_rate: 0.25 },
    })
    assert.equal(response.body.includes('recipient'), false)
    assert.equal(response.body.includes('subject'), false)
  } finally { await ctx.close() }
})

test('days 与 FastAPI 一致限制 1 到 14 并在越界前不读取 Redis', async () => {
  const ctx = setup()
  try {
    for (const days of ['0', '15', '1.5', 'bad']) {
      const response = await ctx.app.inject({ url: `/api/v1/admin/ops/summary?days=${days}`, headers: { authorization: 'admin' } })
      assert.equal(response.statusCode, 422)
      assert.ok(response.json().detail)
    }
    assert.deepEqual(ctx.reads, [])
  } finally { await ctx.close() }
})

test('无计数时保留完整零值摘要且 P99 为空', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: '/api/v1/admin/ops/summary', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.days, 1)
    assert.equal(body.total_calls, 0)
    assert.equal(body.fail_rate, 0)
    assert.equal(body.p99_ms, null)
    assert.deepEqual(body.tools, [])
    assert.deepEqual(body.email_delivery, { calls: 0, sent: 0, failed: 0, ms_sum: 0, errors: {}, avg_ms: 0, fail_rate: 0 })
  } finally { await ctx.close() }
})
