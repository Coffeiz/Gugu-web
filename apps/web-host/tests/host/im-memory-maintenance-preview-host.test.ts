import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'

test('createApp mounts the IM model preview POST behind the shared Admin guard', async () => {
  let starts = 0
  const app = createApp({
    appName: '合成应用', isReady: async () => true,
    adminAuth: {
      registerRoutes() {}, async verifyAdmin() { return true },
      async requireAdmin(request, reply) { if (request.headers.authorization !== 'synthetic-admin') return reply.code(401).send({ detail: '管理员认证失败' }) },
    },
    imMemoryMaintenancePreview: { async start() { starts++; return { ok: true as const, total: 3 } } },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview' })).statusCode, 401)
    assert.equal(starts, 0)
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview', headers: { authorization: 'synthetic-admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, total: 3 })
    assert.equal(starts, 1)
  } finally { await app.close() }
})
