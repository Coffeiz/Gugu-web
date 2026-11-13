import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminLlmPresetRoutes } from '../../src/domains/admin/admin-llm-presets.js'

type Preset = Record<string, unknown> & { id: string; provider: string; api_key: string; base_url: string; model: string }
const initial = (): { ai_presets: { active_id: string; items: Preset[] }; ai: Record<string, unknown> } => ({ ai_presets: { active_id: 'active', items: [
  { id: 'active', name: '当前', provider: 'deepseek', api_key: 'synthetic-secret', base_url: 'https://api.example.test', model: 'chat', max_tokens: 1000, context_tokens: 4000 },
  { id: 'other', name: '备用', provider: 'openai', api_key: '', base_url: 'https://api.example.test', model: 'gpt', max_tokens: 1000, context_tokens: 4000 },
] }, ai: {} as Record<string, unknown> })
function setup(document = initial()) {
  const app = Fastify(), audits: Array<{ action: string; detail: Record<string, unknown> }> = [], modelCalls: unknown[][] = [], invalidations: string[] = []
  registerAdminLlmPresetRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    read: () => structuredClone(document),
    mutate: (change) => { const copy = structuredClone(document); const value = change(copy); Object.assign(document, copy); return value },
    newId: () => 'new-preset',
    capabilitySnapshot: () => ({ chat: true }),
    audit: (action, detail) => { audits.push({ action, detail }) },
    invalidateActiveRuntime: () => { invalidations.push('invalidated') },
    fetchModels: async (baseUrl, provider, apiKey, apiFormat) => {
      modelCalls.push([baseUrl, provider, apiKey, apiFormat])
      if (provider === 'broken') throw new Error('synthetic-secret upstream response')
      return ['deepseek-chat']
    },
  })
  return { app, document, audits, modelCalls, invalidations }
}

test('读取预设只返回遮蔽后的密钥并容忍无效旧记录', async () => {
  const config = initial()
  config.ai_presets.items.push({ id: 'legacy', name: '旧记录', provider: 'invalid', api_key: 'another-secret', base_url: '', model: '' })
  const { app } = setup(config)
  try {
    const response = await app.inject({ url: '/api/v1/admin/agent/llm-presets', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.includes('synthetic-secret'), false)
    assert.equal(response.body.includes('another-secret'), false)
    assert.equal(response.json().items.length, 3)
  } finally { await app.close() }
})

test('创建首个预设会激活并同步运行段，审计不包含密钥', async () => {
  const config = initial(); config.ai_presets.active_id = ''; config.ai_presets.items = []
  const { app, document, audits } = setup(config)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets', headers: { authorization: 'admin' }, payload: {
      name: '新模型', provider: 'deepseek', api_key: 'new-secret', base_url: 'https://api.example.test', model: 'deepseek-chat', max_tokens: 1000, context_tokens: 4000,
    } })
    assert.equal(response.statusCode, 201)
    assert.equal(response.json().id, 'new-preset')
    assert.equal(response.json().api_key.includes('new-secret'), false)
    assert.equal(document.ai_presets.active_id, 'new-preset')
    assert.equal(document.ai.api_key, 'new-secret')
    assert.equal(JSON.stringify(audits).includes('new-secret'), false)
  } finally { await app.close() }
})

test('更新活跃预设不回显密钥，目的地变化要求重新提交密钥且失败不写入', async () => {
  const { app, document } = setup(), before = structuredClone(document)
  try {
    const rejected = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/llm-presets/active', headers: { authorization: 'admin' }, payload: { base_url: 'https://other.example.test' } })
    assert.equal(rejected.statusCode, 422)
    assert.deepEqual(document, before)
    const updated = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/llm-presets/active', headers: { authorization: 'admin' }, payload: { model: 'reasoner', api_key: '' } })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.json().model, 'reasoner')
    assert.equal(updated.json().api_key.includes('synthetic-secret'), false)
    assert.equal(document.ai_presets.items[0].api_key, 'synthetic-secret')
    assert.equal(document.ai.model, 'reasoner')
  } finally { await app.close() }
})

test('激活后同步运行配置，拒绝删除最后一个或当前预设', async () => {
  const { app, document } = setup()
  try {
    const switched = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/other/activate', headers: { authorization: 'admin' } })
    assert.deepEqual(switched.json(), { active_id: 'other' })
    assert.equal(document.ai.model, 'gpt')
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/admin/agent/llm-presets/other', headers: { authorization: 'admin' } })).statusCode, 400)
    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/admin/agent/llm-presets/active', headers: { authorization: 'admin' } })
    assert.deepEqual(removed.json(), { deleted: 'active' })
  } finally { await app.close() }
})

test('已保存模型列表和临时预览只调用Provider模型适配器允许的参数', async () => {
  const { app, modelCalls } = setup()
  try {
    const saved = await app.inject({ url: '/api/v1/admin/agent/llm-presets/active/models', headers: { authorization: 'admin' } })
    assert.deepEqual(saved.json(), { models: ['deepseek-chat'], source: 'provider' })
    assert.deepEqual(modelCalls[0], ['https://api.example.test', 'deepseek', 'synthetic-secret', ''])
    const preview = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/models-preview', headers: { authorization: 'admin' }, payload: {
      provider: 'deepseek', base_url: 'https://api.example.test', api_key: 'synthetic-secret', api_format: 'openai', local_runtime: 'must-not-be-forwarded',
    } })
    assert.deepEqual(preview.json(), { models: ['deepseek-chat'], source: 'provider' })
    assert.deepEqual(modelCalls[1], ['https://api.example.test', 'deepseek', 'synthetic-secret', 'openai'])
  } finally { await app.close() }
})

test('LLM preset管理要求管理员身份', async () => {
  const { app } = setup()
  try { assert.equal((await app.inject({ url: '/api/v1/admin/agent/llm-presets' })).statusCode, 401) }
  finally { await app.close() }
})

test('模型服务上游错误被脱敏，不向Admin返回异常正文', async () => {
  const { app } = setup()
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/llm-presets/models-preview', headers: { authorization: 'admin' }, payload: {
      provider: 'broken', base_url: 'https://api.example.test', api_key: 'secret-value',
    } })
    assert.equal(response.statusCode, 502)
    assert.equal(response.body.includes('synthetic-secret upstream response'), false)
    assert.equal(response.body.includes('secret-value'), false)
  } finally { await app.close() }
})

test('能力覆盖只接受布尔白名单，重置探测元数据并同步活动运行段且不回显密钥', async () => {
  const config = initial()
  config.ai_presets.items[0].capability_overrides = { tools: false }
  config.ai_presets.items[0].capability_checked_at = 'stale-check'
  config.ai_presets.items[0].capability_fingerprint = 'stale-fingerprint'
  config.ai = { model: 'old-runtime-model', api_key: 'synthetic-secret' }
  const { app, document, invalidations } = setup(config), before = structuredClone(config)
  try {
    const rejected = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/llm-presets/active/capability-overrides', headers: { authorization: 'admin' }, payload: { unknown: true } })
    assert.equal(rejected.statusCode, 400)
    assert.deepEqual(document, before)
    const response = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/llm-presets/active/capability-overrides', headers: { authorization: 'admin' }, payload: { tools: true, structured_json: true } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { capability_overrides: { tools: true, structured_json: true } })
    assert.equal(response.body.includes('synthetic-secret'), false)
    assert.deepEqual(document.ai_presets.items[0].capability_overrides, { tools: true, structured_json: true })
    assert.equal(document.ai_presets.items[0].capability_checked_at, '')
    assert.equal(document.ai_presets.items[0].capability_fingerprint, '')
    assert.deepEqual(document.ai.capability_overrides, { tools: true, structured_json: true })
    assert.equal(document.ai.api_key, 'synthetic-secret')
    assert.deepEqual(invalidations, ['invalidated'])
  } finally { await app.close() }
})
