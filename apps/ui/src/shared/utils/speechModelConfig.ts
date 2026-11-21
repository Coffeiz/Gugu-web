import { MODEL_PROVIDERS } from './modelProviders'

export type SpeechConnection = {
  provider: string
  api_format: string
  base_url: string
  model: string
}

export const SPEECH_PROVIDERS = MODEL_PROVIDERS.filter(item => ['openai', 'qwen', 'minimax', 'local'].includes(item.value))

/** Admin 和 BYOK 的语音连接使用相同的默认值与接口能力。 */
export function speechProviderDefaults(provider: string): SpeechConnection {
  if (provider === 'minimax') return { provider, api_format: 'minimax-asr', base_url: 'https://api.minimax.cn', model: 'asr-1.0' }
  if (provider === 'qwen') return { provider, api_format: 'dashscope', base_url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen3-asr-flash' }
  return { provider, api_format: 'openai', base_url: provider === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1', model: provider === 'local' ? '' : 'gpt-4o-transcribe' }
}

export function speechFormats(provider: string): string[] {
  if (!provider) return []
  if (provider === 'minimax') return ['minimax-asr']
  return provider === 'qwen' ? ['dashscope', 'openai'] : ['openai']
}
