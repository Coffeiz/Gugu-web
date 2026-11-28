import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminAuditLogRoute } from '../../../src/modules/admin/audit.js'
import { createAdminAuditLogReader } from '../../../src/modules/admin/audit.js'
import { installHttpErrorHandler } from '../../../src/http/errors.js'

test('审计列表拒绝未授权读取，返回限定字段并保留UTC微秒；非法条数不查询', async () => {
  let calls = 0
  let limit: unknown
  const app = Fastify()
  installHttpErrorHandler(app)
  const reader = createAdminAuditLogReader(async (_sql, values) => {
    calls++; limit = values[0]
    return { rows: [{ id: 1, username: '小北', action: 'login', description: '登录', ip: null,
      created_at: '2026-11-14 01:02:03.123456+00', private_value: '不可返回' }] }
  })
  registerAdminAuditLogRoute(app, { read: reader, requireAdmin: async (request, reply) => {
    if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未授权' })
  } })
  try {
    assert.equal((await app.inject('/api/v1/admin/audit-log')).statusCode, 401)
    assert.equal(calls, 0)
    const response = await app.inject({ url: '/api/v1/admin/audit-log?limit=1', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(limit, 1)
    assert.deepEqual(response.json(), { items: [{ id: 1, username: '小北', action: 'login', description: '登录', ip: null, created_at: '2026-11-14T01:02:03.123456+00:00' }] })
    const invalid = await app.inject({ url: '/api/v1/admin/audit-log?limit=bad', headers: { authorization: 'admin' } })
    assert.equal(invalid.statusCode, 422)
    assert.equal(calls, 1)
    await app.inject({ url: '/api/v1/admin/audit-log', headers: { authorization: 'admin' } })
    assert.equal(limit, 200)
  } finally { await app.close() }
})

test('审计存储异常不向管理员暴露原始异常', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  registerAdminAuditLogRoute(app, { requireAdmin: async () => {}, read: createAdminAuditLogReader(async () => { throw new Error('synthetic-private-value') }) })
  try {
    const response = await app.inject('/api/v1/admin/audit-log')
    assert.equal(response.statusCode, 500)
    assert.equal(response.body.includes('synthetic-private-value'), false)
  } finally { await app.close() }
})
