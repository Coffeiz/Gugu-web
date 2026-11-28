import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'
import { resolveAdminUpdateMode } from '../../../../src/modules/admin/runtime.js'

test('生产 createApp 只读挂载部署状态，Compose 模式不可启动镜像更新', async () => {
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminUpdateMode: resolveAdminUpdateMode('split_compose'),
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ detail: '管理员认证失败' })
      },
    },
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/update/status' })).statusCode, 401)
    const status = await app.inject({ url: '/api/v1/admin/update/status', headers: { authorization: 'test-admin' } })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().reason_code, 'manual_image_update')
    for (const path of [
      '/api/v1/admin/update/check',
      '/api/v1/admin/update/preflight',
      '/api/v1/admin/update/start',
      '/api/v1/admin/update/rollback/preflight',
      '/api/v1/admin/update/rollback',
    ]) {
      assert.equal((await app.inject({ method: 'POST', url: path, headers: { authorization: 'test-admin' }, payload: {} })).statusCode, 404, path)
    }
  } finally {
    await app.close()
  }
})
