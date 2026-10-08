import { describe, expect, it } from 'vitest'
import {
  apiFormatsFromSnapshot,
  defaultApiFormatFromSnapshot,
  defaultBaseUrlFromSnapshot,
  retainApiFormatFromSnapshot,
} from '@/utils/modelProviders'

describe('Provider API 能力快照', () => {
  it('按后端当前模型能力渲染协议，并在模型切换后纠正失效协议', () => {
    const qwenMax = {
      supported_api_formats: ['openai', 'responses'],
      selectable_api_formats: ['openai', 'responses'],
      default_api_format: 'openai',
    }
    const qwen38 = {
      supported_api_formats: ['openai', 'responses', 'anthropic'],
      selectable_api_formats: ['openai', 'responses', 'anthropic'],
      default_api_format: 'openai',
    }

    expect(apiFormatsFromSnapshot(qwenMax, 'qwen')).toEqual(['openai', 'responses'])
    expect(retainApiFormatFromSnapshot(qwenMax, 'qwen', 'anthropic')).toBe('openai')
    expect(retainApiFormatFromSnapshot(qwen38, 'qwen', 'anthropic')).toBe('anthropic')
  })

  it('本地端点将三种协议作为用户选择项，不依赖静态 Provider 清单', () => {
    const local = {
      supported_api_formats: ['openai', 'responses', 'anthropic'],
      selectable_api_formats: ['openai', 'responses', 'anthropic'],
      default_api_format: 'openai',
      api_format_source: 'user_selectable',
    }
    expect(apiFormatsFromSnapshot(local, 'local')).toEqual(['openai', 'responses', 'anthropic'])
    expect(defaultApiFormatFromSnapshot(local, 'local')).toBe('openai')
  })

  it('Ollama 将原生 API 与公共协议分开提供，且保留后端默认值', () => {
    const ollama = {
      supported_api_formats: ['openai', 'responses', 'anthropic'],
      selectable_api_formats: ['native', 'openai', 'responses', 'anthropic'],
      default_api_format: 'native',
      default_base_urls: {
        native: 'http://127.0.0.1:11434/api',
        openai: 'http://127.0.0.1:11434/v1',
        responses: 'http://127.0.0.1:11434/v1',
        anthropic: 'http://127.0.0.1:11434/v1',
      },
      api_format_source: 'user_selectable',
    }
    expect(apiFormatsFromSnapshot(ollama, 'ollama')).toEqual(['native', 'openai', 'responses', 'anthropic'])
    expect(defaultApiFormatFromSnapshot(ollama, 'ollama')).toBe('native')
    expect(defaultBaseUrlFromSnapshot(ollama, 'anthropic')).toBe('http://127.0.0.1:11434/v1')
  })

  it('能力快照缺失时不猜测支持项或默认 URL', () => {
    expect(apiFormatsFromSnapshot(null, 'qwen')).toEqual([])
    expect(defaultApiFormatFromSnapshot(null, 'qwen')).toBe('')
    expect(defaultBaseUrlFromSnapshot(null, 'openai')).toBe('')
  })
})
