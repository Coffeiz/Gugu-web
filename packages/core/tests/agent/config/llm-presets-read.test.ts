import { expect, it } from 'vitest'
import { readAdminLlmPresets } from '../../../src/agent/config/llm-presets-read.js'

it('管理列表遮蔽密钥并返回 Core Provider 能力快照', () => {
  const result = readAdminLlmPresets({ ai_presets: {
    active_id: 'p1', strategy: 'pool', pool_mode: 'round_robin',
    items: [
      { id: 'p1', provider: 'openai', api_key: 'synthetic-secret-value', base_url: 'https://provider.example', model: 'model-a', in_pool: 1 },
      { id: 'legacy', provider: 'openai', api_key: '' },
    ],
  } })
  expect(result.active_id).toBe('p1')
  expect(result.strategy).toBe('pool')
  expect(result.pool_mode).toBe('round_robin')
  expect(result.items[0]?.api_key).toBe(`syn${'•'.repeat(15)}alue`)
  expect(result.items[0]?.in_pool).toBe(true)
  expect(result.items[0]?.declared_capabilities.provider).toBe('unknown')
  expect(result.items[1]?.declared_capabilities.model).toBe('')
  expect(JSON.stringify(result)).not.toContain('synthetic-secret-value')
})

it('旧 ai 配置可投影为默认预设且读取不会修改原配置', () => {
  const document = { ai: { provider: 'ollama', api_key: 'local-secret', base_url: 'http://127.0.0.1:11434', model: 'qwen' } }
  const before = structuredClone(document)
  const result = readAdminLlmPresets(document)
  expect(result.active_id).toBe('default')
  expect(result.items[0]?.id).toBe('default')
  expect(result.items[0]?.api_key).toBe(`loc${'•'.repeat(5)}cret`)
  expect(document).toEqual(before)
})
