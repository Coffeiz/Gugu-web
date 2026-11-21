import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { registerAdminVoicePresetTestRoute } from '../../../../src/modules/admin/voice.js'

test('语音预设测试需管理员权限并复用已保存凭据且拒绝目的地变化', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  registerAdminVoicePresetTestRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '认证失败' })
    },
    readDocument: () => ({ voice_presets: { active_id: 'saved', items: [{
      id: 'saved', provider: 'qwen', api_key: 'stored-secret', base_url: 'https://voice.example.test/',
      model: 'qwen3-asr-flash', api_format: 'dashscope', dashscope_service: 'qwen3-asr',
    }] } }),
    test: async input => { calls.push(input); return { ok: true, message: '连接正常（静音测试已收到响应）' } },
  })
  try {
    const payload = { name: '语音', provider: 'qwen', model: 'fun-asr-flash', base_url: 'https://voice.example.test', api_format: 'dashscope', preset_id: 'saved' }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', payload })).statusCode, 401)
    assert.equal(calls.length, 0)
    const success = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', headers: { authorization: 'admin' }, payload })
    assert.equal(success.statusCode, 200)
    assert.deepEqual(calls[0], {
      provider: 'qwen', api_key: 'stored-secret', base_url: 'https://voice.example.test', model: 'fun-asr-flash',
      api_format: 'dashscope', dashscope_service: 'fun-asr', use_config: false,
    })
    assert.equal(JSON.stringify(success.json()).includes('stored-secret'), false)

    const before = calls.length
    const changed = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', headers: { authorization: 'admin' }, payload: { ...payload, base_url: 'https://other.example.test' } })
    assert.equal(changed.statusCode, 422)
    assert.equal(calls.length, before)
  } finally { await app.close() }
})

test('显式新 Key 可测试草稿，DashScope provider-format 错配和未知预设按 Python 状态拒绝', async () => {
  const calls: unknown[] = []
  const app = Fastify()
  registerAdminVoicePresetTestRoute(app, {
    requireAdmin: async () => {},
    readDocument: () => ({ voice_presets: { items: [] } }),
    test: async input => { calls.push(input); return { ok: true, message: '连接正常（静音测试已收到响应）' } },
  })
  try {
    const base = { name: '草稿', provider: 'qwen', model: 'qwen-audio-3.0-asr-flash', base_url: 'https://voice.example.test', api_key: 'new-synthetic-key', api_format: 'dashscope' }
    const success = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', payload: base })
    assert.equal(success.statusCode, 200)
    assert.deepEqual(calls[0], {
      provider: 'qwen', api_key: 'new-synthetic-key', base_url: 'https://voice.example.test', model: 'qwen-audio-3.0-asr-flash',
      api_format: 'dashscope', dashscope_service: 'qwen-audio', use_config: false,
    })
    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', payload: { ...base, api_format: 'minimax-asr' } })
    assert.equal(mismatch.statusCode, 422)
    const missing = await app.inject({ method: 'POST', url: '/api/v1/admin/agent/voice-presets/test', payload: { ...base, api_key: '', preset_id: 'unknown' } })
    assert.equal(missing.statusCode, 404)
    assert.equal(calls.length, 1)
  } finally { await app.close() }
})
