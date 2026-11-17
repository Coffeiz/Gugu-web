import { capabilitySnapshot, type ProviderConfig } from '../providers/index.js'
import { maskSecret } from '../../shared/secret-mask.js'

type RecordValue = Record<string, unknown>
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function legacyPreset(document: RecordValue): RecordValue {
  const ai = record(document.ai) ? document.ai : {}
  const provider = ai.provider ?? 'openai'
  return {
    active_id: 'default',
    items: [{
      id: 'default', name: String(provider), provider,
      api_key: ai.api_key ?? '', base_url: ai.base_url ?? '', model: ai.model ?? '',
      thinking: ai.thinking ?? 'disabled', reasoning_persistence: ai.reasoning_persistence ?? 'off',
      ollama_mode: ai.ollama_mode ?? 'local',
    }],
  }
}

/** 投影 Admin 预设列表；保持 Python 响应字段并避免 GET 写回运行配置。 */
export function readAdminLlmPresets(raw: unknown) {
  const document = record(raw) ? raw : {}
  const source = Object.hasOwn(document, 'ai_presets')
    ? document.ai_presets
    : legacyPreset(document)
  const collection = record(source) && Array.isArray(source.items)
    ? source
    : { active_id: '', items: [] as unknown[] }
  const items = (collection.items as unknown[]).filter(record).map(item => ({
    ...item,
    api_key: maskSecret(String(item.api_key ?? '')),
    in_pool: Boolean(item.in_pool),
    declared_capabilities: capabilitySnapshot({
      ...item,
      model: typeof item.model === 'string' ? item.model : '',
    } as ProviderConfig),
  }))
  return {
    active_id: collection.active_id ?? '',
    strategy: collection.strategy ?? 'active',
    pool_mode: collection.pool_mode ?? 'random',
    items,
  }
}
