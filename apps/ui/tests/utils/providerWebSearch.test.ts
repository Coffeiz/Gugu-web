import { describe, expect, it } from 'vitest'
import { providerWebSearchAvailable } from '@/utils/providerWebSearch'

describe('Provider 原生搜索开关', () => {
  it('支持独立搜索服务与百炼指定协议', () => {
    for (const provider of ['minimax', 'glm', 'deepseek']) expect(providerWebSearchAvailable({ provider })).toBe(true)
    expect(providerWebSearchAvailable({ provider: 'qwen', api_format: 'responses' })).toBe(true)
    expect(providerWebSearchAvailable({ provider: 'qwen', api_format: 'anthropic' })).toBe(false)
  })
  it('MiMo 只开放官方支持搜索插件的模型', () => {
    expect(providerWebSearchAvailable({ provider: 'mimo', model: 'mimo-v2.6-pro', api_format: 'anthropic' })).toBe(true)
    expect(providerWebSearchAvailable({ provider: 'mimo', model: 'unsupported-model' })).toBe(false)
  })
  it('Ollama 官方 Cloud 凭据才能复用到官方搜索', () => {
    expect(providerWebSearchAvailable({ provider: 'ollama', ollama_mode: 'cloud' })).toBe(true)
    expect(providerWebSearchAvailable({ provider: 'ollama', base_url: 'https://ollama.com/v1' })).toBe(true)
    expect(providerWebSearchAvailable({ provider: 'ollama', base_url: 'http://localhost:11434/api' })).toBe(false)
    expect(providerWebSearchAvailable({ provider: 'ollama', base_url: 'https://example.com/v1' })).toBe(false)
  })
})
