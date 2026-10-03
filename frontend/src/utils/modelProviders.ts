export interface ModelProvider {
  value: string
  labelKey: string
  base_url: string
  model: string
  api_formats: readonly ('anthropic' | 'openai' | 'responses')[]
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  { value: 'openai', labelKey: 'adminAgentUi.providerOpenai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o', api_formats: ['openai', 'responses'] },
  { value: 'anthropic', labelKey: 'adminAgentUi.providerAnthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8', api_formats: ['anthropic'] },
  { value: 'qwen', labelKey: 'adminAgentUi.providerQwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max', api_formats: ['openai', 'responses'] },
  { value: 'glm', labelKey: 'adminAgentUi.providerGlm', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.2', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'deepseek', labelKey: 'adminAgentUi.providerDeepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'minimax', labelKey: 'adminAgentUi.providerMinimax', base_url: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'mimo', labelKey: 'adminAgentUi.providerMimo', base_url: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'ollama', labelKey: 'adminAgentUi.providerOllama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', api_formats: ['openai'] },
  { value: 'local', labelKey: 'adminAgentUi.providerLocal', base_url: '', model: '', api_formats: ['openai'] },
]

/** API 协议属于 Provider/接入类型，不随模型名变化。Ollama 原生协议由表单单独补入。 */
export function apiFormatsForProvider(provider: string, baseUrl = ''): readonly string[] {
  if (provider === 'glm' && baseUrl.includes('/api/coding/')) return ['openai']
  return MODEL_PROVIDERS.find(item => item.value === provider)?.api_formats ?? ['openai']
}

/** Provider 默认协议只决定初始选中项；用户选择其它已支持协议后不应被其覆盖。 */
export function defaultApiFormatForProvider(provider: string): string {
  if (provider === 'minimax' || provider === 'anthropic') return 'anthropic'
  return 'openai'
}

/** 只在 Provider/接入类型确实不支持该协议时回到默认协议。 */
export function retainApiFormatForProvider(provider: string, selected: string, baseUrl = ''): string {
  if (!selected || apiFormatsForProvider(provider, baseUrl).includes(selected)) return selected
  return defaultApiFormatForProvider(provider)
}
