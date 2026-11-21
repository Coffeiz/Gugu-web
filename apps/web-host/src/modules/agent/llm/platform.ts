import { DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '@gugu/core/contracts'
import { ensureLlmPresets } from '@gugu/core/agent/config/llm-strategy'
import type { ProviderConfig } from '@gugu/core/providers'

export interface PlatformModelSettings {
  readonly ai: ProviderConfig
  readonly ai_presets: {
    readonly active_id?: string
    readonly strategy?: string
    readonly pool_mode?: string
    readonly items?: readonly (ProviderConfig & { id: string; in_pool?: boolean })[]
  }
  readonly byokEnabled: boolean
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function parseEnvironmentObject(raw: string | undefined, message: string): RecordValue {
  if (raw === undefined) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as RecordValue
  } catch { throw new Error(message) }
}

function parseAiEnvironment(env: NodeJS.ProcessEnv): RecordValue {
  const values = parseEnvironmentObject(env.AI, 'AI 环境配置无效')
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('AI__') || value === undefined) continue
    const field = key.slice(4).toLowerCase()
    let parsed: unknown = value
    if (value === 'true' || value === 'false') parsed = value === 'true'
    else if (/^-?\d+$/u.test(value)) parsed = Number(value)
    values[field] = parsed
  }
  return values
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

function parseBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (['1', 'true', 't', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'f', 'no', 'n', 'off'].includes(normalized)) return false
  }
  throw new Error('BYOK运行策略布尔值无效')
}

/** Resolve trusted platform model settings. Precedence matches Python: defaults < environment < config override. */
export function resolvePlatformModelSettings(document: RecordValue, env: NodeJS.ProcessEnv): PlatformModelSettings {
  const defaults: RecordValue = {
    provider: 'qwen', api_key: '', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max',
    max_tokens: DEFAULT_LLM_OUTPUT_TOKENS, context_tokens: DEFAULT_LLM_CONTEXT_TOKENS, thinking: '', reasoning_effort: '', reasoning_persistence: 'off',
    image: false, image_detail: 'auto', video: false, audio: false, api_format: '', ollama_mode: 'local',
    ollama_api_mode: 'native', ollama_keep_alive: '5m', deployment_mode: 'cloud', local_runtime: 'other',
    capability_overrides: {}, capability_checked_at: '', capability_fingerprint: '', web_search_enabled: false,
  }
  if (document.ai != null && (typeof document.ai !== 'object' || Array.isArray(document.ai)))
    throw new Error('AI 配置无效')
  if (document.byok != null && (typeof document.byok !== 'object' || Array.isArray(document.byok)))
    throw new Error('BYOK运行策略格式无效')
  const aiOverride = record(document.ai)
  const ai = { ...defaults, ...parseAiEnvironment(env), ...aiOverride }
  const effective = { ...document, ai }
  const presets = ensureLlmPresets(effective) as RecordValue
  if (!presets || !Array.isArray(presets.items)) throw new Error('LLM 预设配置无效')

  const byokEnvironment = parseEnvironmentObject(env.BYOK, 'BYOK 环境配置无效')
  const aiEnvironment = parseEnvironmentObject(env.AI, 'AI 环境配置无效')
  let byokEnabled = parseBoolean(env.BYOK__ENABLED !== undefined
    ? env.BYOK__ENABLED
    : Object.hasOwn(byokEnvironment, 'enabled') ? byokEnvironment.enabled : true)
  let deploymentMode: unknown = env.AI__DEPLOYMENT_MODE !== undefined
    ? env.AI__DEPLOYMENT_MODE
    : Object.hasOwn(aiEnvironment, 'deployment_mode') ? aiEnvironment.deployment_mode : 'cloud'
  if (document.byok !== undefined && document.byok !== null) {
    const configured = record(document.byok)
    if (Object.hasOwn(configured, 'enabled')) byokEnabled = truthy(configured.enabled)
  }
  if (Object.hasOwn(aiOverride, 'deployment_mode')) deploymentMode = aiOverride.deployment_mode
  if (typeof deploymentMode !== 'string') throw new Error('BYOK部署模式无效')
  byokEnabled ||= deploymentMode === 'local'

  return {
    ai: structuredClone(ai) as unknown as ProviderConfig,
    ai_presets: structuredClone(presets) as PlatformModelSettings['ai_presets'],
    byokEnabled,
  }
}
