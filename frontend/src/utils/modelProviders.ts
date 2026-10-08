export interface ModelProvider {
  value: string
  labelKey: string
  base_url: string
  model: string
  api_formats: readonly ('anthropic' | 'openai' | 'responses')[]
}

export interface ProviderApiFormatSnapshot {
  supported_api_formats?: unknown
  selectable_api_formats?: unknown
  default_api_format?: unknown
  default_base_url?: unknown
  default_base_urls?: unknown
  selected_api_format?: unknown
  api_format_source?: unknown
}

const PUBLIC_API_FORMATS = new Set(['openai', 'responses', 'anthropic'])

/** 配置界面的协议选项只从后端能力快照读取；Ollama 原生 API 是独立选项。 */
export function apiFormatsFromSnapshot(
  snapshot: ProviderApiFormatSnapshot | null,
  provider: string,
): string[] {
  const declared = snapshot?.selectable_api_formats ?? snapshot?.supported_api_formats
  if (!Array.isArray(declared)) return []
  return declared.filter((format): format is string =>
    typeof format === 'string' && (PUBLIC_API_FORMATS.has(format) || (provider === 'ollama' && format === 'native')),
  )
}

export function defaultApiFormatFromSnapshot(
  snapshot: ProviderApiFormatSnapshot | null,
  provider: string,
): string {
  const options = apiFormatsFromSnapshot(snapshot, provider)
  const preferred = typeof snapshot?.default_api_format === 'string' ? snapshot.default_api_format : ''
  return options.includes(preferred) ? preferred : options[0] || ''
}

export function retainApiFormatFromSnapshot(
  snapshot: ProviderApiFormatSnapshot | null,
  provider: string,
  selected: string,
): string {
  const options = apiFormatsFromSnapshot(snapshot, provider)
  return selected && options.includes(selected)
    ? selected
    : defaultApiFormatFromSnapshot(snapshot, provider)
}

export function defaultBaseUrlFromSnapshot(
  snapshot: ProviderApiFormatSnapshot | null,
  apiFormat: string,
): string {
  const urls = snapshot?.default_base_urls
  if (urls && typeof urls === 'object' && !Array.isArray(urls)) {
    const url = (urls as Record<string, unknown>)[apiFormat]
    if (typeof url === 'string') return url
  }
  return apiFormat === snapshot?.selected_api_format && typeof snapshot.default_base_url === 'string'
    ? snapshot.default_base_url
    : ''
}

export const MODEL_PROVIDERS: readonly ModelProvider[] = [
  { value: 'openai', labelKey: 'adminAgentUi.providerOpenai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o', api_formats: ['openai', 'responses'] },
  { value: 'anthropic', labelKey: 'adminAgentUi.providerAnthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-opus-4-8', api_formats: ['anthropic'] },
  { value: 'qwen', labelKey: 'adminAgentUi.providerQwen', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'glm', labelKey: 'adminAgentUi.providerGlm', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'deepseek', labelKey: 'adminAgentUi.providerDeepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'minimax', labelKey: 'adminAgentUi.providerMinimax', base_url: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'mimo', labelKey: 'adminAgentUi.providerMimo', base_url: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-pro', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'ollama', labelKey: 'adminAgentUi.providerOllama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', api_formats: ['openai', 'responses', 'anthropic'] },
  { value: 'local', labelKey: 'adminAgentUi.providerLocal', base_url: '', model: '', api_formats: ['openai', 'responses', 'anthropic'] },
]

/** API 协议属于 Provider/接入类型，不随模型名变化。Ollama 原生协议由表单单独补入。 */
export function apiFormatsForProvider(provider: string, baseUrl = '', model = ''): readonly string[] {
  if (provider === 'glm-coding' || (provider === 'glm' && baseUrl.includes('/api/coding/'))) {
    return ['openai', 'responses', 'anthropic']
  }
  const formats = MODEL_PROVIDERS.find(item => item.value === provider)?.api_formats ?? ['openai']
  if (provider !== 'qwen' || !model.trim()) return formats
  return supportsBailianAnthropicModel(model) ? formats : formats.filter(format => format !== 'anthropic')
}

function supportsBailianAnthropicModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  const prefixes = [
    'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.7-flash',
    'qwen3.6-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3.5-plus', 'qwen3.5-flash',
    'qwen3-max', 'qwen3-coder-next', 'qwen3-coder-plus', 'qwen3-coder-flash',
    'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus', 'qwen-plus',
    'qwen-flash', 'qwen-turbo', 'qwen3.6-27b', 'qwen3.5-397b-a17b', 'qwen3.5-122b-a10b',
    'qwen3.5-27b', 'qwen3.5-35b-a3b', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b',
  ]
  return prefixes.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}-`))
}

function bailianBaseUrlForFormat(format: string, currentBaseUrl: string): string {
  const current = currentBaseUrl.trim().replace(/\/$/, '')
  const anthropicPath = '/apps/anthropic'
  const openaiPath = '/compatible-mode/v1'
  if (format === 'anthropic') {
    if (!current) return `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com${anthropicPath}`
    if (current.endsWith(anthropicPath)) return currentBaseUrl
    if (current.endsWith(openaiPath) && current.includes('.maas.aliyuncs.com')) {
      return `${current.slice(0, -openaiPath.length)}${anthropicPath}`
    }
    if (current === 'https://dashscope.aliyuncs.com/compatible-mode/v1') {
      return `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com${anthropicPath}`
    }
    return currentBaseUrl
  }
  if (format === 'openai' || format === 'responses') {
    if (current.endsWith(anthropicPath) && current.includes('.maas.aliyuncs.com')) {
      return `${current.slice(0, -anthropicPath.length)}${openaiPath}`
    }
  }
  return currentBaseUrl
}

function glmCodingBaseUrlForFormat(format: string, currentBaseUrl: string): string {
  const current = currentBaseUrl.trim().replace(/\/$/, '')
  const routes = ['/api/coding/paas/v4', '/api/v1', '/api/anthropic']
  const isKnownGlmEndpoint = current.startsWith('https://open.bigmodel.cn')
    && routes.some(route => current.endsWith(route))
  if (!isKnownGlmEndpoint) return currentBaseUrl
  const route = format === 'anthropic'
    ? '/api/anthropic'
    : format === 'responses'
      ? '/api/v1'
      : format === 'openai'
        ? '/api/coding/paas/v4'
        : ''
  if (!route) return currentBaseUrl
  return `${current.slice(0, current.lastIndexOf('/api/'))}${route}`
}

/** 为百炼和 GLM Coding Plan 在协议专属端点间切换；自定义端点保持不变。 */
export function baseUrlForProviderFormat(provider: string, format: string, currentBaseUrl: string): string {
  if (provider === 'qwen') return bailianBaseUrlForFormat(format, currentBaseUrl)
  if (provider === 'glm-coding' || (provider === 'glm' && currentBaseUrl.includes('/api/coding/'))) {
    return glmCodingBaseUrlForFormat(format, currentBaseUrl)
  }
  return currentBaseUrl
}

/** Provider 默认协议只决定初始选中项；用户选择其它已支持协议后不应被其覆盖。 */
export function defaultApiFormatForProvider(provider: string): string {
  if (provider === 'minimax' || provider === 'anthropic') return 'anthropic'
  return 'openai'
}

/** 只在 Provider/接入类型确实不支持该协议时回到默认协议。 */
export function retainApiFormatForProvider(provider: string, selected: string, baseUrl = '', model = ''): string {
  if (!selected || apiFormatsForProvider(provider, baseUrl, model).includes(selected)) return selected
  return defaultApiFormatForProvider(provider)
}
