import { dashscopeAsrServiceForModel } from '../providers/qwen/asr.js'

export interface VoiceTestSettings {
  readonly provider?: string
  readonly api_key?: string
  readonly base_url?: string
  readonly model?: string
  readonly api_format?: string
  readonly dashscope_service?: string
}

export interface AdminVoiceTestInput extends VoiceTestSettings {
  readonly use_config?: boolean
}

export interface VoiceProbeInput extends VoiceTestSettings {
  readonly api_key: string
  readonly base_url: string
  readonly model: string
  readonly api_format: string
  readonly dashscope_service: string
}

export type VoiceProbeResult =
  | { readonly ok: true; readonly transcript: string | null }
  | { readonly ok: false; readonly status: number; readonly detail?: string; readonly message?: string; readonly message_key?: string; readonly message_params?: Record<string, unknown> }

export interface AdminVoiceTestResult {
  readonly ok: boolean
  readonly message: string
  readonly message_key?: string
  readonly message_params?: Record<string, unknown>
}

export class VoicePresetTestError extends Error {
  constructor(readonly statusCode: 404 | 422, message: string) { super(message) }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 从 Host 已读取的运行配置中选择 Python 语音服务实际消费的活动预设。 */
export function activeVoiceTestSettings(document: unknown): VoiceTestSettings {
  if (!isRecord(document) || !isRecord(document.voice_presets)) return {}
  const presets = document.voice_presets
  if (typeof presets.active_id !== 'string' || !Array.isArray(presets.items)) return {}
  const active = presets.items.find(item => isRecord(item) && item.id === presets.active_id)
  if (!isRecord(active)) return {}
  return {
    provider: text(active.provider).toLowerCase() || undefined,
    api_key: text(active.api_key),
    base_url: text(active.base_url),
    model: text(active.model),
    api_format: text(active.api_format).toLowerCase() || 'openai',
    dashscope_service: text(active.dashscope_service).toLowerCase() || 'qwen3-asr',
  }
}

/** Python `test_voice_preset` 的预设 Key 归属和模型产品线选择。 */
export function resolveVoicePresetTest(document: unknown, input: AdminVoiceTestInput & {
  readonly provider: string
  readonly base_url?: string
  readonly api_key?: string
  readonly model: string
  readonly api_format: string
  readonly preset_id: string
}): VoiceProbeInput {
  const expected = input.provider === 'qwen' ? ['dashscope', 'openai']
    : input.provider === 'minimax' ? ['minimax-asr'] : ['openai']
  if (!expected.includes(input.api_format))
    throw new VoicePresetTestError(422, '语音服务商与 API 格式不匹配')

  let api_key = input.api_key || ''
  if (!api_key && input.preset_id) {
    const root = isRecord(document) && isRecord(document.voice_presets) ? document.voice_presets : undefined
    const items = root && Array.isArray(root.items) ? root.items : []
    const preset = items.find(item => isRecord(item) && item.id === input.preset_id)
    if (!isRecord(preset)) throw new VoicePresetTestError(404, '语音模型配置不存在')
    const savedProvider = text(preset.provider)
    const savedBaseUrl = text(preset.base_url)
    if (text(preset.api_key) && (savedProvider !== input.provider || savedBaseUrl.replace(/\/+$/, '') !== text(input.base_url).replace(/\/+$/, '')))
      throw new VoicePresetTestError(422, '服务商或地址已变更，请重新填写 API Key')
    api_key = text(preset.api_key)
  }
  let dashscope_service = input.dashscope_service || 'qwen3-asr'
  if (input.api_format === 'dashscope') {
    try {
      // 与 Admin BYOK 和运行时共用按模型前缀选择原生产品线的规则。
      dashscope_service = requireDashscopeService(input.model)
    } catch (error) {
      throw new VoicePresetTestError(422, error instanceof Error ? error.message : '百炼原生语音模型无效')
    }
  }
  return {
    provider: input.provider,
    api_key,
    base_url: input.base_url || '',
    model: input.model,
    api_format: input.api_format,
    dashscope_service,
  }
}

function requireDashscopeService(model: string): string {
  // Lazy-free module dependency keeps all DashScope family selection in Core providers.
  return dashscopeAsrServiceForModel(model)
}

/** Python `config.test_voice` 的配置优先级、格式规则和可观察响应。 */
export function createAdminVoiceConnectionTest(dependencies: {
  readSettings(): VoiceTestSettings
  probe(input: VoiceProbeInput): Promise<VoiceProbeResult>
}) {
  return async (input: AdminVoiceTestInput): Promise<AdminVoiceTestResult> => {
    const settings = input.use_config === false ? {} : dependencies.readSettings()
    const choose = (field: keyof VoiceTestSettings): string => {
      const value = input[field]
      return typeof value === 'string' && value.length > 0 ? value : text(settings[field])
    }
    const api_format = (choose('api_format') || 'openai').trim().toLowerCase()
    const model = choose('model').trim()
    const base_url = choose('base_url').trim()
    const api_key = typeof input.api_key === 'string' && input.api_key && input.api_key !== '****'
      ? input.api_key : text(settings.api_key)
    const dashscopeValue = input.dashscope_service === undefined
      ? 'qwen3-asr' : input.dashscope_service || settings.dashscope_service || 'qwen3-asr'
    const dashscope_service = text(dashscopeValue).toLowerCase()
    const provider = text(settings.provider).toLowerCase() || (api_format === 'dashscope' ? 'qwen' : api_format === 'minimax-asr' ? 'minimax' : 'openai')

    if (!model || (!base_url && api_format !== 'minimax-asr'))
      return { ok: false, message: '请先填写模型名和 Base URL' }
    if (!['openai', 'dashscope', 'minimax-asr'].includes(api_format))
      return { ok: false, message: '语音 API 格式暂不支持' }
    if (api_format === 'minimax-asr' && model !== 'asr-1.0')
      return { ok: false, message: 'MiniMax ASR 当前只支持 asr-1.0' }
    if (api_format === 'dashscope' && !['qwen3-asr', 'qwen-audio', 'fun-asr'].includes(dashscope_service))
      return { ok: false, message: '百炼产品线只支持 Qwen3 ASR、Qwen-Audio 3.0 或 Fun-ASR' }

    const result = await dependencies.probe({ provider, api_key, base_url, model, api_format, dashscope_service })
    if (!result.ok) {
      if (result.message_key) return {
        ok: false, message: result.message || '语音测试失败', message_key: result.message_key,
        ...(result.message_params ? { message_params: result.message_params } : {}),
      }
      if (result.message) return { ok: false, message: result.message }
      const detail = result.detail?.trim()
      return { ok: false, message: `测试失败：HTTP ${result.status}${detail ? `：${detail}` : ''}` }
    }
    if (result.transcript === null) return { ok: false, message: '语音模型未配置' }
    return { ok: true, message: '连接正常（静音测试已收到响应）' }
  }
}
