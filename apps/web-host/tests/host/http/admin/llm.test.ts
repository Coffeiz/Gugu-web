import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApp } from '../../../../src/app.js'
import { createAdminLlmPresetReader } from '../../../../src/modules/admin/llm.js'

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

test('生产列表路由认证后读取 Core 投影且不需要启用重复注册的 CRUD 原型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-admin-llm-list-'))
  const path = join(directory, 'config.override.json')
  const source = JSON.stringify({ ai_presets: { active_id: 'p', items: [{ id: 'p', provider: 'openai', api_key: 'synthetic-secret', base_url: 'https://provider.example', model: 'model-a' }] }, unrelated: { retained: true } })
  await writeFile(path, source, { mode: 0o600 })
  let reads = 0
  const read = createAdminLlmPresetReader(path)
  const app = createApp({ appName: '合成应用', isReady: async () => true,
    adminAuth: { registerRoutes() {}, async verifyAdmin() { return true }, async requireAdmin(request, reply) { if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ detail: '管理员认证失败' }) } },
    adminLlmPresetList: { async read() { reads++; return read() } },
  } as unknown as Parameters<typeof createApp>[0])
  try {
    const denied = await app.inject({ url: '/api/v1/admin/agent/llm-presets' })
    assert.equal(denied.statusCode, 401)
    assert.equal(reads, 0)
    const allowed = await app.inject({ url: '/api/v1/admin/agent/llm-presets', headers: { authorization: 'test-admin' } })
    assert.equal(allowed.statusCode, 200)
    const result = allowed.json()
    assert.equal(result.active_id, 'p')
    assert.equal(result.items[0].api_key, `syn${'•'.repeat(9)}cret`)
    assert.equal(result.items[0].declared_capabilities.provider, 'unknown')
    assert.equal(allowed.body.includes('synthetic-secret'), false)
    assert.equal(reads, 1)
    assert.equal(await readFile(path, 'utf8'), source)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
