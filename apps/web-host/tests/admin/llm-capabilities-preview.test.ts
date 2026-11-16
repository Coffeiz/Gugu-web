import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import Fastify from 'fastify'
import { createApp } from '../../src/app.js'
import { capabilitySnapshot } from '../../../../packages/core/src/agent/providers/registry.js'

const apps: Array<ReturnType<typeof Fastify>> = []
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())) })
test('LLM能力预览保留管理员认证、Python Ollama native快照和输入DTO边界', async () => {
  const app = createApp({
    appName: '合成测试应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin(request, reply) {
      if (request.headers.authorization !== 'Bearer admin') return reply.code(401).send({ detail: '未授权' })
    } },
  })
  apps.push(app)
  const url = '/api/v1/admin/agent/llm-presets/capabilities-preview'
  const unauthorized = await app.inject({ method: 'POST', url, payload: { provider: 'ollama' } })
  assert.equal(unauthorized.statusCode, 401)
  const response = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer admin' }, payload: {
      provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native', api_key: 'synthetic-private-key',
  } })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json(), capabilitySnapshot({ provider: 'ollama', model: 'qwen3:8b', ollama_api_mode: 'native' }))
  assert.equal(response.json().api_format, 'openai')
  assert.equal(response.json().selected_api_format, 'openai')
  assert.equal(response.body.includes('synthetic-private-key'), false)
  const headers = { authorization: 'Bearer admin' }
  for (const payload of [{ provider: '' }, { provider: 'x'.repeat(65) }, { provider: 'ollama', model: 3 }]) {
    assert.equal((await app.inject({ method: 'POST', url, headers, payload })).statusCode, 422)
  }
  assert.equal((await app.inject({ method: 'POST', url, headers, payload: { provider: 'qwen', api_key: 'synthetic-secret' } })).statusCode, 200)
})
