import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../../src/app.js'

test('Host 注入模型预设时管理员认证先于配置读取且密钥被遮蔽', async () => {
  let reads = 0
  const config = { ai_presets: { active_id: 'p', items: [{ id: 'p', provider: 'openai', api_key: 'synthetic-secret', base_url: 'https://example.test', model: 'model' }] } }
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin(request, reply) { if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ detail: '管理员认证失败' }) } },
    adminLlmPresets: { read() { reads++; return config }, mutate(change) { return change(config) }, async fetchModels() { return [] } },
  })
  try {
    const denied = await app.inject({ url: '/api/v1/admin/agent/llm-presets' })
    assert.equal(denied.statusCode, 401)
    assert.equal(reads, 0)
    const allowed = await app.inject({ url: '/api/v1/admin/agent/llm-presets', headers: { authorization: 'test-admin' } })
    assert.equal(allowed.statusCode, 200)
    assert.equal(reads, 1)
    assert.equal(allowed.body.includes('synthetic-secret'), false)
  } finally { await app.close() }
})
