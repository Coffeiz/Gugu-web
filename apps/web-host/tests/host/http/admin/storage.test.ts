import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerStorageLiveTotalsRoute } from '../../../../src/modules/admin/storage.js'

test('管理员实时存储统计先鉴权，直接返回当前读端结果', async () => {
  const app = Fastify()
  let calls = 0
  registerStorageLiveTotalsRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '需要管理员身份' })
    },
    read: async () => { calls++; return { categories: { user_files: {object_count:2,total_bytes:300} } } },
  })
  try {
    assert.equal((await app.inject({ url:'/api/v1/admin/ops/storage-live-totals' })).statusCode, 401)
    assert.equal(calls, 0)
    assert.deepEqual((await app.inject({ url:'/api/v1/admin/ops/storage-live-totals',headers:{authorization:'synthetic-admin'} })).json(), { categories:{user_files:{object_count:2,total_bytes:300}} })
    assert.equal(calls, 1)
  } finally { await app.close() }
})
