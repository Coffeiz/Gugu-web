import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerNotificationAdminHistoryRoutes } from '../../../../src/modules/notifications/admin.js'

test('管理员历史先鉴权，解析参数且保持删除幂等响应', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  registerNotificationAdminHistoryRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '需要管理员身份' })
    },
    history: async limit => { calls.push(limit); return [] },
    deleteRecord: async id => { calls.push(id); return { ok: true } },
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/notifications/history?limit=invalid' })).statusCode, 401)
    assert.deepEqual(calls, [])
    const headers = { authorization: 'synthetic-admin' }
    assert.equal((await app.inject({ url: '/api/v1/admin/notifications/history?limit=invalid', headers })).statusCode, 422)
    assert.equal((await app.inject({ url: '/api/v1/admin/notifications/history?limit=999999999999999999999', headers })).statusCode, 200)
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/admin/notifications/history/nope', headers })).statusCode, 422)
    assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/v1/admin/notifications/history/42', headers })).json(), { ok: true })
    assert.deepEqual(calls, [100, 42])
  } finally { await app.close() }
})
