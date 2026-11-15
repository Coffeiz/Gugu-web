import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerSystemLogRoutes } from '../../src/modules/admin/system-logs.js'

test('系统日志先鉴权再查询，参数错误拒绝，默认和级别保持Python协议', async () => {
  const app = Fastify(), calls: unknown[] = []
  registerSystemLogRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '需要管理员身份' })
    },
    list: async (...args) => { calls.push(args); return { items: [] } },
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/system-logs' })).statusCode, 401)
    assert.deepEqual(calls, [])
    const headers = { authorization: 'synthetic-admin' }
    assert.equal((await app.inject({ url: '/api/v1/admin/system-logs?limit=invalid', headers })).statusCode, 422)
    assert.deepEqual((await app.inject({ url: '/api/v1/admin/system-logs', headers })).json(), { items: [] })
    assert.deepEqual((await app.inject({ url: '/api/v1/admin/system-logs?limit=1&level=error', headers })).json(), { items: [] })
    assert.deepEqual(calls, [[200, null], [1, 'error']])
  } finally { await app.close() }
})
