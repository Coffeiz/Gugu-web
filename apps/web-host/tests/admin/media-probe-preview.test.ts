import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminMediaProbePreview, registerAdminMediaProbePreviewRoute } from '../../src/modules/admin/media-probe-preview.js'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('管理员草稿媒体探测先鉴权、校验维度并调用无持久化探测用例', async () => {
  const calls: unknown[] = []
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin(request, reply) {
        if (request.headers.authorization !== 'Bearer admin') return reply.code(401).send({ detail: '未授权' })
      },
    },
    adminMediaProbePreview: {
      probe: async input => { calls.push(input); return { dim: input.dim, supported: true, status: 200, detail: '模型接受了图片输入' } },
    },
  })
  apps.push(app)

  const denied = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/probe-media-preview', payload: {} })
  const invalidBody = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/probe-media-preview', headers: { authorization: 'Bearer admin' }, payload: { api_key: 'synthetic-key' } })
  const invalidDimension = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/probe-media-preview?dim=document', headers: { authorization: 'Bearer admin' }, payload: { provider: 'local' } })
  const response = await app.inject({
    method: 'POST', url: '/api/v1/admin/agent/llm-presets/probe-media-preview?dim=image',
    headers: { authorization: 'Bearer admin' },
    payload: { provider: 'local', api_key: 'synthetic-key', base_url: 'http://127.0.0.1:8000/v1', model: 'vision-model', api_format: 'openai' },
  })

  assert.equal(denied.statusCode, 401)
  assert.equal(invalidBody.statusCode, 422)
  assert.equal(invalidDimension.statusCode, 400)
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { dim: 'image', supported: true, status: 200, detail: '模型接受了图片输入' })
  assert.deepEqual(calls, [{ provider: 'local', api_format: 'openai', base_url: 'http://127.0.0.1:8000/v1', model: 'vision-model', api_key: 'synthetic-key', dim: 'image' }])
})

test('管理员草稿探测使用受控 Provider 传输且不保存配置', async () => {
  const received: { path?: string; authorization?: string } = {}
  const upstream = createServer((request, response) => {
    received.path = request.url
    received.authorization = request.headers.authorization
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"choices":[]}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const app = Fastify()
  apps.push(app)
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  registerAdminMediaProbePreviewRoute(app, {
    requireAdmin: async () => {},
    probe: createAdminMediaProbePreview({}),
  })
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/admin/agent/llm-presets/probe-media-preview?dim=image',
      payload: { provider: 'local', api_key: 'synthetic-key', base_url: `http://127.0.0.1:${address.port}/v1`, model: 'vision-model', api_format: 'openai' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().supported, true)
    assert.equal(received.path, '/v1/chat/completions')
    assert.equal(received.authorization, 'Bearer synthetic-key')
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
