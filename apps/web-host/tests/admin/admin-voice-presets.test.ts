import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminVoicePresetRoutes } from '../../src/domains/admin/admin-voice-presets.js'

const seed = () => ({ voice_presets: { active_id: 'voice-a', items: [
  { id: 'voice-a', name: '语音 A', provider: 'qwen' as const, api_key: 'synthetic-secret-key', base_url: 'https://voice.example.test', model: 'qwen3-asr-flash', api_format: 'dashscope' as const, dashscope_service: 'qwen3-asr' as const },
] } })

function setup(document = seed()) {
  const app = Fastify()
  const auditRows: Array<{ action: string; details: Record<string, unknown> }> = []
  registerAdminVoicePresetRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    read: () => structuredClone(document),
    mutate: (change) => {
      const draft = structuredClone(document)
      const result = change(draft)
      Object.assign(document, draft)
      return result
    },
    newId: () => 'voice-new',
    audit: (action, details) => { auditRows.push({ action, details }) },
  })
  return { app, document, auditRows }
}

test('语音预设列表只遮蔽密钥且暴露是否已配置', async () => {
  const { app } = setup()
  try {
    const response = await app.inject({ url: '/api/v1/admin/agent/voice-presets', headers: { authorization: 'admin' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json().items[0], {
      id: 'voice-a', name: '语音 A', provider: 'qwen', api_key: 'syn•••••••••••••-key',
      base_url: 'https://voice.example.test', model: 'qwen3-asr-flash', api_format: 'dashscope',
      dashscope_service: 'qwen3-asr', active: true, has_api_key: true,
    })
    assert.equal(response.body.includes('synthetic-secret-key'), false)
  } finally { await app.close() }
})

test('新建首个语音预设自动激活，后续激活与停用写入无敏感值的审计事件', async () => {
  const initial = seed()
  initial.voice_presets.active_id = ''
  const { app, document, auditRows } = setup(initial)
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets', headers: { authorization: 'admin' }, payload: {
      name: '新语音', provider: 'qwen', api_key: 'new-secret', base_url: 'https://voice.example.test', model: 'asr-model', api_format: 'openai',
    } })
    assert.equal(created.statusCode, 201)
    assert.equal(created.json().active_id, 'voice-new')
    assert.equal(document.voice_presets.items.find((item) => item.id === 'voice-new')?.api_key, 'new-secret')
    assert.deepEqual(auditRows[0], { action: 'voice_preset.create', details: { preset_id: 'voice-new', provider: 'qwen' } })
    assert.equal(JSON.stringify(auditRows).includes('new-secret'), false)
    const activated = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/voice-a/activate', headers: { authorization: 'admin' } })
    assert.deepEqual(activated.json(), { active_id: 'voice-a' })
    const disabled = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/deactivate', headers: { authorization: 'admin' } })
    assert.deepEqual(disabled.json(), { active_id: '' })
  } finally { await app.close() }
})

test('改服务商或地址而未提供新密钥时返回422且不改变已保存预设', async () => {
  const { app, document } = setup(), before = structuredClone(document)
  try {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/voice-presets/voice-a', headers: { authorization: 'admin' }, payload: { base_url: 'https://other.example.test' } })
    assert.equal(response.statusCode, 422)
    assert.deepEqual(document, before)
  } finally { await app.close() }
})

test('更新空密钥保留旧密钥并重新脱敏，删除活动预设会清除活动指针', async () => {
  const { app, document, auditRows } = setup()
  try {
    const updated = await app.inject({ method: 'PUT', url: '/api/v1/admin/agent/voice-presets/voice-a', headers: { authorization: 'admin' }, payload: { model: 'fun-asr-flash', api_key: '' } })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().item.model, 'fun-asr-flash')
    assert.equal(updated.json().item.dashscope_service, 'fun-asr')
    assert.equal(updated.json().item.has_api_key, true)
    assert.notEqual(updated.json().item.api_key, 'synthetic-secret-key')
    assert.equal(document.voice_presets.items[0].api_key, 'synthetic-secret-key')
    assert.equal(auditRows[0].action, 'voice_preset.update')
    const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/admin/agent/voice-presets/voice-a', headers: { authorization: 'admin' } })
    assert.deepEqual(deleted.json(), { deleted: 'voice-a', active_id: '' })
  } finally { await app.close() }
})

test('管理员预设路由拒绝无管理员身份请求', async () => {
  const { app } = setup()
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/agent/voice-presets' })).statusCode, 401)
  } finally { await app.close() }
})

test('模型预览仅为原目的地复用保存密钥，缺少密钥或目的地改变均不触发网络', async () => {
  const app = Fastify(), calls: unknown[][] = []
  registerAdminVoicePresetRoutes(app, {
    requireAdmin: async () => {}, read: seed,
    mutate: (change) => change(seed()),
    fetchModels: async (...args) => { calls.push(args); return ['qwen3-asr-flash'] },
  })
  try {
    const noKey = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/models-preview', payload: { provider: 'qwen', preset_id: 'v_test' } })
    assert.equal(noKey.statusCode, 422)
    assert.equal(calls.length, 0)
    const matched = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/models-preview', payload: {
      preset_id: 'voice-a', provider: 'qwen', base_url: 'https://voice.example.test', api_format: 'dashscope',
    } })
    assert.equal(matched.statusCode, 200)
    assert.deepEqual(matched.json(), { models: ['qwen3-asr-flash'], source: 'provider' })
    assert.deepEqual(calls[0], ['https://voice.example.test', 'qwen', 'synthetic-secret-key', 'dashscope'])
    const changed = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/models-preview', payload: {
      preset_id: 'voice-a', provider: 'qwen', base_url: 'https://other.example.test', api_format: 'dashscope',
    } })
    assert.equal(changed.statusCode, 422)
    assert.equal(calls.length, 1)
  } finally { await app.close() }
})

test('模型预览适配器失败时不把异常或密钥回显给Admin', async () => {
  const app = Fastify()
  registerAdminVoicePresetRoutes(app, {
    requireAdmin: async () => {}, read: seed, mutate: (change) => change(seed()),
    fetchModels: async () => { throw new Error('synthetic-provider-secret response body') },
  })
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/models-preview', payload: {
      provider: 'qwen', api_key: 'synthetic-api-key', base_url: 'https://voice.example.test', api_format: 'dashscope',
    } })
    assert.equal(response.statusCode, 502)
    assert.equal(response.body.includes('synthetic-provider-secret'), false)
    assert.equal(response.body.includes('synthetic-api-key'), false)
  } finally { await app.close() }
})
