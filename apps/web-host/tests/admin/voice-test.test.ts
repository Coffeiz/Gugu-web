import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { activeVoiceTestSettings, createAdminVoiceConnectionTest } from '../../../../packages/core/src/agent/config/voice-test.js'
import { createAdminVoiceProbe, registerAdminVoiceTestRoute } from '../../src/modules/admin/voice.js'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'

const configured = {
  provider: 'qwen',
  api_key: 'stored-secret',
  base_url: 'https://voice.example.test/api/v1/services/aigc/multimodal-generation/generation',
  model: 'qwen3-asr-flash',
  api_format: 'dashscope',
  dashscope_service: 'fun-asr',
}

test('语音测试按 Python 配置回退、遮罩 Key 回退和产品线并调用探针', async () => {
  const probes: unknown[] = []
  const testVoice = createAdminVoiceConnectionTest({
    readSettings: () => configured,
    probe: async value => { probes.push(value); return { ok: true, transcript: ' ' } },
  })

  assert.deepEqual(await testVoice({ use_config: true, api_key: '****', model: '' }), {
    ok: true,
    message: '连接正常（静音测试已收到响应）',
  })
  assert.deepEqual(probes, [{ ...configured, api_key: 'stored-secret', model: 'qwen3-asr-flash', dashscope_service: 'qwen3-asr' }])
  await testVoice({ use_config: true, api_key: '****', model: '', dashscope_service: '' })
  assert.deepEqual(probes[1], { ...configured, api_key: 'stored-secret', model: 'qwen3-asr-flash', dashscope_service: 'fun-asr' })
})

test('不支持的格式、模型和产品线在发起网络请求前按 Python 语义拒绝', async () => {
  const calls: unknown[] = []
  const testVoice = createAdminVoiceConnectionTest({
    readSettings: () => configured,
    probe: async value => { calls.push(value); return { ok: true, transcript: '' } },
  })

  assert.deepEqual(await testVoice({ use_config: false, model: '' }), { ok: false, message: '请先填写模型名和 Base URL' })
  assert.deepEqual(await testVoice({ use_config: false, model: 'm', api_format: 'other', base_url: 'https://voice.example.test' }), { ok: false, message: '语音 API 格式暂不支持' })
  assert.deepEqual(await testVoice({ use_config: false, model: 'other', api_format: 'minimax-asr' }), { ok: false, message: 'MiniMax ASR 当前只支持 asr-1.0' })
  assert.deepEqual(await testVoice({ use_config: false, model: 'qwen3-asr-flash', api_format: 'dashscope', base_url: configured.base_url, dashscope_service: 'other' }), { ok: false, message: '百炼产品线只支持 Qwen3 ASR、Qwen-Audio 3.0 或 Fun-ASR' })
  assert.deepEqual(await testVoice({ use_config: true, model: ' ', api_format: 'dashscope', base_url: configured.base_url }), { ok: false, message: '请先填写模型名和 Base URL' })
  assert.deepEqual(await testVoice({ use_config: true, model: 'qwen3-asr-flash', api_format: 'dashscope', base_url: configured.base_url, dashscope_service: ' ' }), { ok: false, message: '百炼产品线只支持 Qwen3 ASR、Qwen-Audio 3.0 或 Fun-ASR' })
  assert.deepEqual(calls, [])
})

test('use_config=false 不读取保存 Key，空识别响应仍成功', async () => {
  let reads = 0
  const probes: unknown[] = []
  const testVoice = createAdminVoiceConnectionTest({
    readSettings: () => { reads++; return configured },
    probe: async value => { probes.push(value); return { ok: true, transcript: '' } },
  })

  assert.deepEqual(await testVoice({ use_config: false, provider: 'openai', api_format: 'openai', base_url: 'https://voice.example.test/v1', model: 'whisper-1', api_key: '****' }), {
    ok: true,
    message: '连接正常（静音测试已收到响应）',
  })
  assert.equal(reads, 0)
  assert.deepEqual(probes, [{ provider: 'openai', api_format: 'openai', base_url: 'https://voice.example.test/v1', model: 'whisper-1', api_key: '', dashscope_service: 'qwen3-asr' }])
})

test('从当前活动语音预设读取运行配置，不暴露到响应 DTO', () => {
  assert.deepEqual(activeVoiceTestSettings({ voice_presets: {
    active_id: 'v_active',
    items: [
      { id: 'v_old', provider: 'openai', api_key: 'old-secret', model: 'old' },
      { id: 'v_active', provider: 'qwen', api_key: 'active-secret', base_url: 'https://voice.example.test', model: 'qwen-audio', api_format: 'dashscope' },
    ],
  } }), {
    provider: 'qwen', api_key: 'active-secret', base_url: 'https://voice.example.test', model: 'qwen-audio',
    api_format: 'dashscope', dashscope_service: 'qwen3-asr',
  })
  assert.deepEqual(activeVoiceTestSettings({ voice_presets: { active_id: 'missing', items: [{ id: 'v_active', api_key: 'secret' }] } }), {})
})

test('生产 ASR 适配使用 Core OpenAI 音频协议，失败 DTO 脱敏并由管理员路由接出', async () => {
  const requests: ProviderHttpRequest[] = []
  const fakeTransport: ProviderTransport = {
    async request(input) {
      requests.push(input)
      const body = input.url.includes('failure.example.test')
        ? { error: { message: 'bad synthetic-voice-key at https://upstream.example.test/path' } }
        : { choices: [{ message: { content: '' } }] }
      const status = input.url.includes('failure.example.test') ? 401 : 200
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: (async function* () { yield new TextEncoder().encode(JSON.stringify(body)) })(),
        cancel() {},
      }
    },
  }
  const testVoice = createAdminVoiceConnectionTest({
    readSettings: () => ({}),
    probe: createAdminVoiceProbe({}, { createTransport: () => fakeTransport }),
  })
  const app = Fastify()
  let probes = 0
  registerAdminVoiceTestRoute(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '认证失败' })
    },
    test: async input => { probes++; return testVoice(input) },
  })
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/config/test-voice', payload: { model: 'whisper-1' } })).statusCode, 401)
    assert.equal(probes, 0)
    const success = await app.inject({ method: 'POST', url: '/api/v1/admin/config/test-voice', headers: { authorization: 'admin' }, payload: {
      use_config: 'false', api_format: 'openai', base_url: 'https://voice.example.test/v1', model: 'whisper-1', api_key: 'synthetic-voice-key',
    } })
    assert.equal(success.statusCode, 200)
    assert.deepEqual(success.json(), { ok: true, message: '连接正常（静音测试已收到响应）' })
    assert.equal(requests[0]?.url, 'https://voice.example.test/v1/chat/completions')
    assert.match(JSON.stringify(requests[0]?.body), /input_audio/)
    const failed = await testVoice({ use_config: false, api_format: 'openai', base_url: 'https://failure.example.test/v1', model: 'whisper-1', api_key: 'synthetic-voice-key' })
    assert.equal(failed.ok, false)
    assert.equal(failed.message.includes('synthetic-voice-key'), false)
    assert.equal(failed.message.includes('upstream.example.test'), false)
    assert.equal(failed.message.includes('HTTP 401'), true)
  } finally { await app.close() }
})
