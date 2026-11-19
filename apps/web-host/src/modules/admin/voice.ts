import { randomUUID } from 'node:crypto'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { maskSecret } from '@gugu/core/shared/secret-mask'


import type { FastifyReply } from 'fastify'

import { createVoicePresetMutations,VoicePresetMutationError,VoicePresetMutationUnavailable } from '@gugu/core/agent/config/voice-presets-mutate'

import { mutateConfigOverride } from '../../adapters/config/config-override-file.js'

import { createPosixConfigFileLock } from '../../adapters/config/posix-config-lock.js'


import { createVoicePresetsReader } from '@gugu/core/agent/config/voice-presets-read'

import { readConfigOverride } from '../../adapters/config/config-override-file.js'

import { createHash } from 'node:crypto'


import { z } from 'zod'

import { activeVoiceTestSettings,createAdminVoiceConnectionTest,resolveVoicePresetTest,VoicePresetTestError } from '@gugu/core/agent/config/voice-test'

import type { VoiceProbeInput,VoiceProbeResult } from '@gugu/core/agent/config/voice-test'

import { classifyProviderError,minimaxErrorDetails,ProviderError,transcribeCompatibleAsr,transcribeMiniMax } from '@gugu/core/providers'

import type { CompatibleAsrDependencies,ProviderTransport } from '@gugu/core/providers'

import { createNodeProviderTransport } from '@gugu/core/providers/node'

import { redactToolError } from '@gugu/core/agent'


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
function response(item: Preset, activeId: string) {
  return { ...item, api_key: maskSecret(item.api_key), has_api_key: Boolean(item.api_key), active: item.id === activeId }
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

export function createVoicePresetFileMutations(path:string){
 return createVoicePresetMutations(work=>mutateConfigOverride(path,work,createPosixConfigFileLock()),()=>`v_${randomUUID().replaceAll('-','').slice(0,8)}`)
}
export interface VoicePresetMutationOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createVoicePresetFileMutations>}
export function registerVoicePresetMutationRoutes(app:FastifyInstance,options:VoicePresetMutationOptions):void {
 const preHandler=options.requireAdmin
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{try{return await work()}catch(error){if(error instanceof VoicePresetMutationError||error instanceof VoicePresetMutationUnavailable)return reply.code(error.statusCode).send({detail:error.message});throw error}}
 app.post<{Body:unknown}>('/api/v1/admin/agent/voice-presets',{preHandler},(request,reply)=>execute(()=>options.operations.create(request.body),reply))
 app.put<{Params:{preset_id:string};Body:unknown}>('/api/v1/admin/agent/voice-presets/:preset_id',{preHandler},(request,reply)=>execute(()=>options.operations.update(request.params.preset_id,request.body),reply))
 app.delete<{Params:{preset_id:string}}>('/api/v1/admin/agent/voice-presets/:preset_id',{preHandler},(request,reply)=>execute(()=>options.operations.delete(request.params.preset_id),reply))
 app.post<{Params:{preset_id:string}}>('/api/v1/admin/agent/voice-presets/:preset_id/activate',{preHandler},(request,reply)=>execute(()=>options.operations.activate(request.params.preset_id),reply))
 app.post('/api/v1/admin/agent/voice-presets/deactivate',{preHandler},(_request,reply)=>execute(()=>options.operations.deactivate(),reply))
}

export function createVoicePresetsFileReader(path:string) {return createVoicePresetsReader(()=>readConfigOverride(path))}
export interface VoicePresetsReadOptions {requireAdmin:preHandlerHookHandler;read:ReturnType<typeof createVoicePresetsFileReader>}
export function registerVoicePresetsReadRoute(app:FastifyInstance,options:VoicePresetsReadOptions):void {
 app.get('/api/v1/admin/agent/voice-presets',{preHandler:options.requireAdmin},()=>options.read())
}

const pythonBoolean = z.preprocess(value => {
  if (value === 0 || value === 1) return Boolean(value)
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on', 'y', 't'].includes(value.toLowerCase())) return true
    if (['false', '0', 'no', 'off', 'n', 'f'].includes(value.toLowerCase())) return false
  }
  return value
}, z.boolean())
const request = z.object({
  api_format: z.string().max(32).optional().default('openai'),
  dashscope_service: z.string().max(32).optional().default('qwen3-asr'),
  base_url: z.string().max(500).optional().default(''),
  api_key: z.string().max(4096).optional().default(''),
  model: z.string().max(200).optional().default(''),
  use_config: pythonBoolean.optional().default(true),
})
const presetRequest = request.omit({ use_config: true }).extend({
  name: z.string().min(1).max(80),
  provider: z.enum(['openai', 'qwen', 'minimax', 'local']),
  model: z.string().min(1).max(200),
  preset_id: z.string().max(200).default(''),
})

export interface AdminVoiceTestOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly test: ReturnType<typeof createAdminVoiceConnectionTest>
}

export interface AdminVoicePresetTestOptions {
  readonly requireAdmin: preHandlerHookHandler
  readonly readDocument: () => unknown | Promise<unknown>
  readonly test: ReturnType<typeof createAdminVoiceConnectionTest>
}

export interface AdminVoiceProbeOptions {
  readonly createTransport?: () => ProviderTransport & { close?(): Promise<void> }
}

function silentWav(): Uint8Array {
  const sampleRate = 16_000, frames = sampleRate
  const wav = Buffer.alloc(44 + frames * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40)
  return wav
}

function upstreamText(body: string, apiKey: string): string {
  try {
    const value = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    let message = typeof value.error?.message === 'string' ? value.error.message : typeof value.message === 'string' ? value.message : ''
    if (apiKey) message = message.replaceAll(apiKey, '‹密钥已隐藏›')
    return message ? redactToolError(message).replace(/https?:\/\/[^\s'"<>]+/gi, '‹地址已隐藏›').slice(0, 300) : ''
  } catch { return '' }
}

/** 管理员配置的语音诊断使用共享 ASR 协议和生产安全传输，不读取用户凭据。 */
export function createAdminVoiceProbe(environment: NodeJS.ProcessEnv, options: AdminVoiceProbeOptions = {}) {
  return async (input: VoiceProbeInput): Promise<VoiceProbeResult> => {
    const transport = options.createTransport?.() ?? createNodeProviderTransport({
      allowLocal: true,
      connectTimeoutMs: 10_000,
      environment: () => environment,
    })
    let responseBody = ''
    let responseStatus: number | undefined
    let requestUrl: string | undefined
    const dependencies = {
      transport,
      digest: (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
      diagnose(code: string, value: unknown) {
        if (code !== 'provider_http' || !value || typeof value !== 'object') return
        const event = value as { body?: unknown; status?: unknown; url?: unknown }
        responseBody = typeof event.body === 'string' ? event.body : event.body === undefined ? '' : JSON.stringify(event.body)
        if (typeof event.status === 'number') responseStatus = event.status
        if (typeof event.url === 'string') requestUrl = event.url
      },
    }
    const config = { ...input, timeout_ms: 15_000 }
    try {
      const media = [{ type: 'audio', mime: 'audio/wav', ext: 'wav', duration: 1, raw: silentWav() }]
      const transcript = input.api_format === 'minimax-asr'
        ? await transcribeMiniMax(media, config, {
          ...dependencies,
          probeAudioDuration: async () => 1,
          toWav: async () => null,
        }, AbortSignal.timeout(15_000), { raiseErrors: true })
        : await transcribeCompatibleAsr(media, config, { ...dependencies, toWav: async () => null } satisfies CompatibleAsrDependencies,
          AbortSignal.timeout(15_000), { raiseErrors: true })
      return { ok: true, transcript }
    } catch (error) {
      const classified = classifyProviderError(error, { providerUrl: requestUrl })
      const status = responseStatus ?? (error instanceof ProviderError ? error.options.status : classified.options.status) ?? 0
      if (input.api_format === 'minimax-asr') {
        const vendor = minimaxErrorDetails({ body: responseBody ? safeJson(responseBody) : undefined, url: requestUrl, status })
        if (vendor) return { ok: false, status, message: vendor.summary, message_key: vendor.description_key,
          message_params: { code: vendor.code, request_id: vendor.request_id } }
      }
      if (status) return { ok: false, status, detail: upstreamText(responseBody, input.api_key) }
      return { ok: false, status: 0, message: classified.code === 'unsupported'
        ? '语音 API 格式暂不支持' : '无法连接语音识别服务，请检查 Base URL、模型和 API Key' }
    } finally {
      await transport.close?.()
    }
  }
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

export function createAdminVoiceTestOperations(path: string | null, environment: NodeJS.ProcessEnv) {
  return createAdminVoiceConnectionTest({
    readSettings: () => activeVoiceTestSettings(path ? readConfigOverride(path) : {}),
    probe: createAdminVoiceProbe(environment),
  })
}

export function createAdminVoicePresetTestOperations(path: string | null, environment: NodeJS.ProcessEnv) {
  return {
    readDocument: () => path ? readConfigOverride(path) : {},
    test: createAdminVoiceTestOperations(path, environment),
  }
}

export function registerAdminVoiceTestRoute(app: FastifyInstance, options: AdminVoiceTestOptions): void {
  app.post('/api/v1/admin/config/test-voice', { preHandler: options.requireAdmin }, async (request_, reply) => {
    const parsed = request.safeParse(request_.body)
    if (!parsed.success) return reply.code(422).send({ detail: '语音测试参数无效' })
    return options.test(parsed.data)
  })
}

export function registerAdminVoicePresetTestRoute(app: FastifyInstance, options: AdminVoicePresetTestOptions): void {
  app.post('/api/v1/admin/agent/voice-presets/test', { preHandler: options.requireAdmin }, async (request_, reply) => {
    const parsed = presetRequest.safeParse(request_.body)
    if (!parsed.success) return reply.code(422).send({ detail: '语音测试参数无效' })
    try {
      const probe = resolveVoicePresetTest(await options.readDocument(), parsed.data)
      return await options.test({ ...probe, use_config: false })
    } catch (error) {
      if (error instanceof VoicePresetTestError) return reply.code(error.statusCode).send({ detail: error.message })
      throw error
    }
  })
}
