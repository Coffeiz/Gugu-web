import { describe, expect, it } from 'vitest'
import { apiFormatsForProvider, defaultApiFormatForProvider, MODEL_PROVIDERS, retainApiFormatForProvider } from './modelProviders'

describe('Provider API 协议目录', () => {
  it('MiniMax 的协议选项不依赖模型名或能力快照', () => {
    expect(apiFormatsForProvider('minimax')).toEqual(['openai', 'responses', 'anthropic'])
    expect(defaultApiFormatForProvider('minimax')).toBe('anthropic')
  })

  it('Mimo 显示官方支持的三种 API，默认仍使用 Chat Completions', () => {
    expect(apiFormatsForProvider('mimo')).toEqual(['openai', 'responses', 'anthropic'])
    expect(defaultApiFormatForProvider('mimo')).toBe('openai')
    expect(MODEL_PROVIDERS.find(provider => provider.value === 'mimo')?.model).toBe('mimo-v2.6-pro')
  })

  it('协议默认值与选项顺序分离，不会把有效的非默认选择纠正回默认项', () => {
    expect(retainApiFormatForProvider('minimax', 'responses')).toBe('responses')
    expect(retainApiFormatForProvider('minimax', 'openai')).toBe('openai')
    expect(retainApiFormatForProvider('glm', 'responses', 'https://open.bigmodel.cn/api/coding/paas/v4')).toBe('openai')
  })

  it('通用 GLM 提供三种协议，Coding Plan 端点只提供 Chat', () => {
    expect(apiFormatsForProvider('glm')).toEqual(['openai', 'responses', 'anthropic'])
    expect(apiFormatsForProvider('glm', 'https://open.bigmodel.cn/api/coding/paas/v4')).toEqual(['openai'])
  })

  it('对未知或自定义 Provider 保留通用 Chat 选项', () => {
    expect(apiFormatsForProvider('custom-provider')).toEqual(['openai'])
  })
})
