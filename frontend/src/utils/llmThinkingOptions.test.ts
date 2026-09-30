import { describe, expect, it } from 'vitest'
import { buildThinkingOptionsForIdentity } from './llmThinkingOptions'

describe('模型思考选项快照', () => {
  const translate = (key: string) => key

  it('切换 API 协议期间保留同一 Provider 与模型的已有思考选项', () => {
    const options = buildThinkingOptionsForIdentity(
      {
        reasoning_modes: ['adaptive'],
        reasoning_efforts: ['low', 'high'],
        supports_adaptive_thinking: true,
      },
      'minimax|MiniMax-M3',
      'minimax|MiniMax-M3',
      translate,
    )
    expect(options.map(option => option.value)).toEqual(['default', 'adaptive', 'low', 'high'])
  })

  it('模型身份改变时不把上一个模型的思考能力带到新模型', () => {
    const options = buildThinkingOptionsForIdentity(
      { reasoning_modes: ['adaptive'], reasoning_efforts: ['low'] },
      'minimax|MiniMax-M3',
      'minimax|MiniMax-Text-01',
      translate,
    )
    expect(options.map(option => option.value)).toEqual(['default'])
  })

  it('Provider 仅把 adaptive 用作启用思考的内部值时显示默认项而不误标自适应', () => {
    const options = buildThinkingOptionsForIdentity(
      { reasoning_modes: ['disabled', 'adaptive'], reasoning_efforts: ['low', 'high'] },
      'deepseek|deepseek-v4-flash',
      'deepseek|deepseek-v4-flash',
      translate,
    )
    expect(options.map(option => option.value)).toEqual(['default', 'disabled', 'low', 'high'])
  })
})
