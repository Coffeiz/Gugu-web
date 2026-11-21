import { DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '@gugu/core/contracts'

export interface LlmPresetRecord {
  id: string | number
  name: string
  provider: string
  model: string
  max_tokens?: number | null
  context_tokens?: number | null
  in_pool?: boolean
  capability_probe?: Record<string, { status?: string; detail?: string }>
  capability_checked_at?: string
  capability_fingerprint?: string
  capability_overrides?: Record<string, boolean>
  [key: string]: unknown
}
export interface LlmPresetDraft extends Partial<LlmPresetRecord> {
  name: string
  provider: string
  api_key: string
  base_url: string
  model: string
  max_tokens: number
  context_tokens: number
  thinking: string
  reasoning_persistence: 'off' | 'continuation'
  web_search_enabled: boolean
  image: boolean
  video: boolean
  audio: boolean
  capability_overrides: Record<string, boolean>
}

export function newLlmPresetDraft(defaults: { base_url: string; model: string }): LlmPresetDraft {
  return {
    name: '',
    provider: 'openai',
    api_key: '',
    base_url: defaults.base_url,
    model: defaults.model,
    max_tokens: DEFAULT_LLM_OUTPUT_TOKENS,
    context_tokens: DEFAULT_LLM_CONTEXT_TOKENS,
    thinking: '',
    reasoning_effort: '',
    reasoning_persistence: 'off',
    web_search_enabled: false,
    image: false,
    image_detail: 'auto',
    video: false,
    audio: false,
    api_format: '',
    ollama_mode: 'local',
    ollama_api_mode: 'native',
    ollama_keep_alive: '5m',
    deployment_mode: 'cloud',
    local_runtime: 'other',
    capability_overrides: {},
  }
}

export function editLlmPresetDraft(preset: LlmPresetRecord): LlmPresetDraft {
  return {
    ...preset,
    api_key: '',
    max_tokens: preset.max_tokens ?? DEFAULT_LLM_OUTPUT_TOKENS,
    context_tokens: preset.context_tokens ?? DEFAULT_LLM_CONTEXT_TOKENS,
    reasoning_persistence: preset.reasoning_persistence === 'continuation' ? 'continuation' : 'off',
    web_search_enabled: Boolean(preset.web_search_enabled),
    image_detail: preset.image_detail || 'auto',
    ollama_mode: preset.ollama_mode || 'local',
    ollama_api_mode: preset.ollama_api_mode || 'native',
    ollama_keep_alive: preset.ollama_keep_alive || '5m',
    deployment_mode: preset.deployment_mode || (preset.provider === 'local' ? 'local' : 'cloud'),
    local_runtime: preset.local_runtime || 'other',
    capability_overrides: preset.capability_overrides || {},
  } as unknown as LlmPresetDraft
}
