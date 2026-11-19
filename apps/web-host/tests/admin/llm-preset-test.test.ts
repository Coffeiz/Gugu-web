import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import Fastify from 'fastify'
import { afterEach, test } from 'node:test'
import { createApp } from '../../src/app.js'
import { createAdminLlmPresetTest } from '../../src/modules/admin/llm-probe.js'
import { LlmPresetTestError } from '@gugu/core/agent/config'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })

test('管理员预设连通性测试验证认证、预设不存在和 Python 兼容结果', async () => {
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
    adminLlmPresetTest: {
      test: async id => {
        if (id !== 'active') throw new LlmPresetTestError(404, '预设不存在')
        return { ok: true, status: 200, detail: '', declared_capabilities: { tools: true } }
      },
    },
  })
  apps.push(app)

  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/active/test' })).statusCode, 401)
  const missing = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/missing/test', headers: { authorization: 'Bearer admin' } })
  const success = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/active/test', headers: { authorization: 'Bearer admin' } })
  assert.equal(missing.statusCode, 404)
  assert.deepEqual(success.json(), { ok: true, status: 200, detail: '', declared_capabilities: { tools: true }, probe: { status: 200 } })
})

test('预设连通性测试走 Provider 安全传输且不回显上游正文或密钥', async () => {
  let requestPath = ''
  let authorization = ''
  let upstreamStatus = 200
  const upstream = createServer((request, response) => {
    requestPath = request.url ?? ''
    authorization = String(request.headers.authorization ?? '')
    response.writeHead(upstreamStatus, { 'content-type': 'application/json' }).end(upstreamStatus === 200
      ? '{"choices":[{"message":{"content":"synthetic response"}}]}'
      : '{"error":{"message":"synthetic-llm-key must not be returned"}}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const app = createApp({
    appName: '合成测试应用',
    isReady: async () => true,
    adminAuth: {
      registerRoutes() {},
      async verifyAdmin() { return true },
      async requireAdmin() {},
    },
    adminLlmPresetTest: {
      test: createAdminLlmPresetTest({
        environment: {},
        readDocument: async () => ({ ai_presets: { active_id: 'local', items: [
          { id: 'local', provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`, api_key: 'synthetic-llm-key', model: 'synthetic-model' },
        ] } }),
      }),
    },
  })
  apps.push(app)

  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/local/test' })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(requestPath, '/v1/chat/completions')
    assert.equal(authorization, 'Bearer synthetic-llm-key')
    assert.deepEqual(response.json(), {
      ok: true,
      status: 200,
      detail: '',
      declared_capabilities: response.json().declared_capabilities,
      probe: { status: 200 },
    })
    assert.equal(JSON.stringify(response.json()).includes('synthetic-llm-key'), false)
    assert.equal(JSON.stringify(response.json()).includes('synthetic response'), false)

    upstreamStatus = 401
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/local/test' })
    assert.equal(rejected.statusCode, 200)
    assert.equal(rejected.json().ok, false)
    assert.equal(rejected.json().status, 401)
    assert.equal(rejected.json().detail, '上游返回 HTTP 401')
    assert.equal(JSON.stringify(rejected.json()).includes('synthetic-llm-key'), false)
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})
