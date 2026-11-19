import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminUserSecurityEventRoute } from '../../src/modules/admin/users.js'
import { installHttpErrorHandler } from '../../src/http/errors.js'

const userId = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const eventRows = [{
  id: 17, event_type: 'ownership.denied', resource_type: 'File',
  resource_fingerprint: 'a'.repeat(64), owner_fingerprint: 'b'.repeat(64),
  client_fingerprint: 'c'.repeat(64), ip_fingerprint: 'd'.repeat(64),
  action: 'logged', reason_code: 'ownership_mismatch',
  occurred_at: '2026-11-13T12:30:00.000Z',
  user_id: userId, user_agent_fingerprint: 'must-not-return', metadata_json: { private: 'must-not-return' },
  raw_ip: '192.0.2.23',
}]

function setup({ exists = true }: { exists?: boolean } = {}) {
  const calls: { userId: string; limit: number }[] = []
  let queryError: Error | undefined
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminUserSecurityEventRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    read: async (userId, limit) => {
      calls.push({ userId, limit })
      if (queryError) throw queryError
      if (!exists) return null
      return { items: eventRows.slice(0, limit).map(row => ({
        id: Number(row.id), event_type: String(row.event_type), resource_type: String(row.resource_type),
        resource_fingerprint: String(row.resource_fingerprint), owner_fingerprint: row.owner_fingerprint as string | null,
        client_fingerprint: row.client_fingerprint as string | null, ip_fingerprint: row.ip_fingerprint as string | null,
        action: String(row.action), reason_code: String(row.reason_code),
        occurred_at: new Date(String(row.occurred_at)).toISOString().replace(/Z$/, '+00:00'),
      })) }
    },
  })
  return { app, calls, set queryError(error: Error | undefined) { queryError = error }, cleanup: () => app.close() }
}

test('未授权请求在任何数据库查询前被拒绝', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: `/api/v1/admin/users/${userId}/security-events` })
    assert.equal(response.statusCode, 401)
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('按用户存在性先查404，结果按时间倒序分页且仅返回指纹投影', async () => {
  const ctx = setup()
  try {
    const response = await ctx.app.inject({ url: `/api/v1/admin/users/${userId}/security-events?limit=1`, headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(ctx.calls.length, 1)
    assert.deepEqual(ctx.calls, [{ userId, limit: 1 }])
    const body = response.json()
    assert.deepEqual(body.items, [{
      id: 17, event_type: 'ownership.denied', resource_type: 'File',
      resource_fingerprint: 'a'.repeat(64), owner_fingerprint: 'b'.repeat(64),
      client_fingerprint: 'c'.repeat(64), ip_fingerprint: 'd'.repeat(64),
      action: 'logged', reason_code: 'ownership_mismatch', occurred_at: '2026-11-13T12:30:00.000+00:00',
    }])
    assert.equal(JSON.stringify(body).includes('must-not-return'), false)
    assert.equal(JSON.stringify(body).includes(userId), false)
    assert.equal(JSON.stringify(body).includes('192.0.2.23'), false)
  } finally { await ctx.cleanup() }
})

test('用户不存在返回404且不查询事件，UUID和limit边界在查询前校验', async () => {
  const missing = setup({ exists: false })
  try {
    const response = await missing.app.inject({ url: `/api/v1/admin/users/${userId}/security-events`, headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 404)
    assert.deepEqual(missing.calls, [{ userId, limit: 100 }])
  } finally { await missing.cleanup() }

  const ctx = setup()
  try {
    for (const path of [
      '/api/v1/admin/users/not-a-uuid/security-events',
      `/api/v1/admin/users/${userId}/security-events?limit=0`,
      `/api/v1/admin/users/${userId}/security-events?limit=501`,
    ]) {
      const response = await ctx.app.inject({ url: path, headers: { authorization: 'admin' } })
      assert.equal(response.statusCode, 422)
      assert.equal(typeof response.json().detail, 'string')
    }
    assert.equal(ctx.calls.length, 0)
  } finally { await ctx.cleanup() }
})

test('数据库异常不泄露底层细节', async () => {
  const ctx = setup()
  try {
    ctx.queryError = new Error('synthetic private SQL details')
    const response = await ctx.app.inject({ url: `/api/v1/admin/users/${userId}/security-events`, headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 500)
    assert.equal(response.body.includes('synthetic private SQL details'), false)
  } finally { await ctx.cleanup() }
})
