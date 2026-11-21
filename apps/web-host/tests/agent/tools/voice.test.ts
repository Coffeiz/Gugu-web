import assert from 'node:assert/strict'
import { test } from 'node:test'
import Fastify from 'fastify'
import { supportsConfiguredVoiceModel } from '@gugu/core/agent/config/voice-availability'
import { createPostgresVoiceAvailabilityReader } from '../../../src/modules/agent/voice.js'
import { registerVoiceAvailabilityRoute } from '../../../src/modules/agent/voice.js'

test('语音可用性只按认证 owner 的有效设置返回布尔值', async () => {
  const app = Fastify()
  const owners: string[] = []
  registerVoiceAvailabilityRoute(app, {
    requireUser: async request => {
      if (request.headers.authorization !== 'user') throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    },
    ownerIdFromRequest: request => request.headers.authorization === 'user' ? 'owner-a' : 'owner-b',
    available: async owner => { owners.push(owner); return owner === 'owner-a' },
  })
  try {
    assert.equal((await app.inject('/api/v1/agent/voice-availability')).statusCode, 401)
    const response = await app.inject({ url: '/api/v1/agent/voice-availability', headers: { authorization: 'user' } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { available: true })
    assert.deepEqual(owners, ['owner-a'])
  } finally { await app.close() }
})

test('语音模型可用性遵循 Python 支持的协议和产品线', () => {
  assert.equal(supportsConfiguredVoiceModel({ model: ' model-x ' }), true)
  assert.equal(supportsConfiguredVoiceModel({ model: 'qwen3-asr-flash', api_format: 'dashscope', dashscope_service: 'qwen3-asr' }), true)
  assert.equal(supportsConfiguredVoiceModel({ model: 'qwen-audio-turbo', api_format: 'dashscope', dashscope_service: 'qwen-audio' }), true)
  assert.equal(supportsConfiguredVoiceModel({ model: 'fun-asr-realtime', api_format: 'dashscope', dashscope_service: 'fun-asr' }), true)
  assert.equal(supportsConfiguredVoiceModel({ model: 'asr-1.0', api_format: 'minimax-asr' }), true)
  assert.equal(supportsConfiguredVoiceModel({ model: 'other', api_format: 'minimax-asr' }), false)
  assert.equal(supportsConfiguredVoiceModel({ model: 'model-x', api_format: 'unknown' }), false)
  assert.equal(supportsConfiguredVoiceModel({ model: '   ' }), false)
})

test('生产语音设置优先使用已启用 owner 的 BYOK，并且不返回或记录密钥', async () => {
  const calls: unknown[][] = []
  let decrypted = 0
  const pool = { async query(_sql: string, values: unknown[]) {
    calls.push(values)
    return { rows: [{ provider: 'openai', api_format: 'openai', base_url: 'https://speech.example/v1', model: 'custom-asr',
      encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 2 }] }
  } }
  const reader = createPostgresVoiceAvailabilityReader(pool as never, {
    enabled: () => true,
    readBaseSettings: () => ({ model: '', api_format: 'openai' }),
    decrypt: async () => { decrypted++; return 'synthetic-secret' },
  })
  assert.equal(await reader.available('owner-a'), true)
  assert.deepEqual(calls, [['owner-a']])
  assert.equal(decrypted, 1)
})

test('BYOK 开关关闭或用户无凭据时沿用平台语音设置', async () => {
  let queries = 0
  const reader = createPostgresVoiceAvailabilityReader({ async query() { queries++; return { rows: [] } } } as never, {
    enabled: () => false,
    readBaseSettings: () => ({ model: 'platform-asr', api_format: 'openai' }),
    decrypt: async () => { throw new Error('no credential should be decrypted') },
  })
  assert.equal(await reader.available('owner-a'), true)
  assert.equal(queries, 0)
})
