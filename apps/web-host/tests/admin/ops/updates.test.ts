import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminUpdateStatusRoute } from '../../../src/modules/admin/runtime.js'

test('更新状态需要管理员认证，并明确提示由部署管理器手动更新', async () => {
  const app = Fastify()
  registerAdminUpdateStatusRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '未登录' })
    },
    mode: 'split_compose',
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/update/status' })).statusCode, 401)
    const response = await app.inject({ url: '/api/v1/admin/update/status', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      enabled: false,
      mode: 'split_compose',
      capability: 'manual',
      reason_code: 'manual_image_update',
      reason: 'Compose 部署由 Docker/Compose 管理器更新整套镜像；Admin 不执行镜像更新。',
      current: null,
      candidate: null,
      has_update: false,
      task: null,
      history: [],
    })
  } finally {
    await app.close()
  }
})

test('未知部署模式安全降级为手动更新且不启用更新操作', async () => {
  const app = Fastify()
  registerAdminUpdateStatusRoute(app, { requireAdmin: async () => {}, mode: 'unknown' })
  try {
    const response = await app.inject({ url: '/api/v1/admin/update/status' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().enabled, false)
    assert.equal(response.json().capability, 'manual')
    assert.equal(response.json().reason_code, 'deployment_unrecognized')
  } finally {
    await app.close()
  }
})
