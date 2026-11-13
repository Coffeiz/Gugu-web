import { randomUUID } from 'node:crypto'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

type Preset = {
  id: string
  name: string
  provider: 'openai' | 'qwen' | 'minimax' | 'local'
  api_key: string
  base_url: string
  model: string
  api_format: 'openai' | 'dashscope' | 'minimax-asr'
  dashscope_service: 'qwen3-asr' | 'qwen-audio' | 'fun-asr'
}
type Config = { voice_presets?: { active_id?: string; items?: Preset[] } }
type Update = Partial<Omit<Preset, 'id'>>
export interface AdminVoicePresetOptions {
  requireAdmin: preHandlerHookHandler
  read: () => Config
  mutate: <T>(change: (draft: Config) => T) => T
  newId?: () => string
  audit?: (action: string, details: Record<string, unknown>) => void | Promise<void>
  fetchModels?: (baseUrl: string, provider: string, apiKey: string, apiFormat: string) => Promise<string[]>
}

const providers = ['openai', 'qwen', 'minimax', 'local'] as const
const formats = ['openai', 'dashscope', 'minimax-asr'] as const
function fail(status: number, message: string): never {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = status
  throw error
}
function collection(config: Config) {
  if (!config.voice_presets || !Array.isArray(config.voice_presets.items)) config.voice_presets = { active_id: '', items: [] }
  return config.voice_presets
}
function validateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) fail(422, '语音模型名称无效')
  return value.trim()
}
function validatePreset(value: Record<string, unknown>): Preset {
  const name = validateName(value.name), provider = value.provider, format = value.api_format ?? 'openai'
  if (!providers.includes(provider as typeof providers[number]) || !formats.includes(format as typeof formats[number])) fail(422, '语音服务商或 API 格式无效')
  const compatible = provider === 'qwen' ? ['openai', 'dashscope'] : provider === 'minimax' ? ['minimax-asr'] : ['openai']
  if (!compatible.includes(String(format))) fail(422, '语音服务商与 API 格式不匹配')
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) fail(422, '语音模型无效')
  let service = String(value.dashscope_service ?? 'qwen3-asr') as Preset['dashscope_service']
  if (format === 'dashscope') {
    const model = value.model.trim().toLowerCase()
    const match = /^(qwen3-asr|qwen-audio|fun-asr)/.exec(model)
    if (!match) fail(422, '百炼原生语音模型须属于 Qwen3 ASR、Qwen-Audio 或 Fun-ASR 产品线')
    service = match[1] as Preset['dashscope_service']
  }
  if (!['qwen3-asr', 'qwen-audio', 'fun-asr'].includes(service)) fail(422, '百炼语音产品线无效')
  return {
    id: String(value.id ?? ''), name, provider: provider as Preset['provider'],
    api_key: typeof value.api_key === 'string' ? value.api_key : '',
    base_url: typeof value.base_url === 'string' ? value.base_url : '', model: value.model.trim(),
    api_format: format as Preset['api_format'], dashscope_service: service,
  }
}
function maskKey(key: string): string {
  if (!key) return ''
  return key.length <= 8 ? '•'.repeat(key.length) : `${key.slice(0, 3)}${'•'.repeat(key.length - 7)}${key.slice(-4)}`
}
function response(item: Preset, activeId: string) {
  return { ...item, api_key: maskKey(item.api_key), has_api_key: Boolean(item.api_key), active: item.id === activeId }
}
function findPreset(config: Config, id: string) {
  const presets = collection(config), item = presets.items!.find((row) => row.id === id)
  if (!item) fail(404, '语音模型配置不存在')
  return { presets, item }
}

export function registerAdminVoicePresetRoutes(app: FastifyInstance, options: AdminVoicePresetOptions): void {
  const preHandler = options.requireAdmin
  const audit = options.audit ?? (() => undefined)
  app.get('/api/v1/admin/agent/voice-presets', { preHandler }, async () => {
    const config = options.read(), presets = collection(config), activeId = presets.active_id ?? ''
    return { active_id: activeId, items: presets.items!.map((item) => response(item, activeId)) }
  })
  app.post('/api/v1/admin/agent/voice-presets', { preHandler }, async (request, reply) => {
    const id = options.newId?.() ?? `v_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const item = validatePreset({ ...(request.body as Record<string, unknown>), id })
    const result = options.mutate((config) => {
      const presets = collection(config)
      presets.items!.push(item)
      if (!presets.active_id) presets.active_id = id
      return { active_id: presets.active_id, item: response(item, presets.active_id) }
    })
    await audit('voice_preset.create', { preset_id: id, provider: item.provider })
    return reply.code(201).send(result)
  })
  app.put<{ Params: { preset_id: string } }>('/api/v1/admin/agent/voice-presets/:preset_id', { preHandler }, async (request) => {
    const updates = request.body as Update
    const result = options.mutate((config) => {
      const { presets, item } = findPreset(config, request.params.preset_id)
      const provider = updates.provider ?? item.provider, baseUrl = updates.base_url ?? item.base_url
      if (item.api_key && (provider !== item.provider || baseUrl.replace(/\/$/, '') !== item.base_url.replace(/\/$/, ''))) fail(422, '服务商或地址已变更，请重新填写 API Key')
      const next = { ...item, ...updates, api_key: updates.api_key || item.api_key, id: item.id }
      const validated = validatePreset(next as unknown as Record<string, unknown>)
      Object.assign(item, validated)
      return { active_id: presets.active_id ?? '', item: response(item, presets.active_id ?? '') }
    })
    await audit('voice_preset.update', { preset_id: request.params.preset_id })
    return result
  })
  app.delete<{ Params: { preset_id: string } }>('/api/v1/admin/agent/voice-presets/:preset_id', { preHandler }, async (request) => {
    const result = options.mutate((config) => {
      const presets = collection(config)
      if (!presets.items!.some((item) => item.id === request.params.preset_id)) fail(404, '语音模型配置不存在')
      presets.items = presets.items!.filter((item) => item.id !== request.params.preset_id)
      if (presets.active_id === request.params.preset_id) presets.active_id = ''
      return { deleted: request.params.preset_id, active_id: presets.active_id ?? '' }
    })
    await audit('voice_preset.delete', { preset_id: request.params.preset_id })
    return result
  })
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/voice-presets/:preset_id/activate', { preHandler }, async (request) => {
    const result = options.mutate((config) => {
      const { presets } = findPreset(config, request.params.preset_id)
      presets.active_id = request.params.preset_id
      return { active_id: presets.active_id }
    })
    await audit('voice_preset.activate', { preset_id: request.params.preset_id })
    return result
  })
  app.post('/api/v1/admin/agent/voice-presets/deactivate', { preHandler }, async () => {
    const result = options.mutate((config) => {
      const presets = collection(config)
      presets.active_id = ''
      return { active_id: '' }
    })
    await audit('voice_preset.deactivate', {})
    return result
  })
  app.post('/api/v1/admin/agent/voice-presets/models-preview', { preHandler }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    const provider = body.provider, baseUrl = body.base_url, apiFormat = body.api_format ?? 'openai', presetId = body.preset_id
    if (typeof provider !== 'string' || typeof baseUrl !== 'string' || typeof body.api_key !== 'undefined' && typeof body.api_key !== 'string') fail(422, '语音服务商、地址或 API Key 无效')
    const compatible = provider === 'qwen' ? ['openai', 'dashscope'] : provider === 'minimax' ? ['minimax-asr'] : ['openai']
    if (!compatible.includes(String(apiFormat))) fail(422, '语音服务商与 API 格式不匹配')
    let apiKey = String(body.api_key ?? '')
    if (!apiKey && presetId) {
      const config = options.read(), currentPresets = collection(config)
      const saved = currentPresets.items!.find((item) => item.id === String(presetId))
      if (!saved) fail(404, '语音模型配置不存在')
      if (saved.provider !== provider || saved.base_url.replace(/\/$/, '') !== baseUrl.replace(/\/$/, '')) fail(422, '服务商或地址已变更，请重新填写 API Key')
      apiKey = saved.api_key
    }
    if (!apiKey && provider !== 'local') fail(422, '请先填写 API Key 或选择已保存的语音配置')
    if (!options.fetchModels) fail(503, '模型列表服务暂不可用')
    try {
      const models = await options.fetchModels(baseUrl, provider, apiKey, String(apiFormat))
      return { models, source: 'provider' }
    } catch {
      return reply.code(502).send({ error: '语音模型列表获取失败' })
    }
  })
}
