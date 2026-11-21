import { DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '@gugu/core/contracts'
import { randomUUID } from 'node:crypto'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { maskSecret } from '@gugu/core/shared/secret-mask'

import type { FastifyReply } from 'fastify'

import type { createAdminModelDirectory } from '@gugu/core/agent/config/admin-model-directory'


import { readAdminLlmPresets } from '@gugu/core/agent/config'

import { readConfigOverride } from '../../adapters/config/config-override-file.js'


import type { createLlmPresetSelection } from '@gugu/core/agent/config/llm-preset-selection'


type Preset = Record<string, unknown> & { id: string; provider: string; api_key: string; base_url: string; model: string }
type Config = { ai_presets?: { active_id?: string; items?: Preset[]; strategy?: string; pool_mode?: string }; ai?: Record<string, unknown> }
export interface AdminLlmPresetOptions {
  requireAdmin: preHandlerHookHandler
  read: () => Config
  mutate: <T>(change: (draft: Config) => T) => T
  newId?: () => string
  audit?: (action: string, details: Record<string, unknown>) => void | Promise<void>
  capabilitySnapshot?: (preset: Record<string, unknown>) => Record<string, unknown>
  fetchModels: (baseUrl: string, provider: string, apiKey: string, apiFormat: string) => Promise<string[]>
  destinationMatches?: (provider: string, apiFormat: string, baseUrl: string) => boolean
  invalidateActiveRuntime?: () => void | Promise<void>
  invalidateReasoningStates?: () => void | Promise<void>
}

const aiKeys = [
  'provider', 'api_key', 'base_url', 'model', 'max_tokens', 'context_tokens', 'thinking', 'reasoning_effort',
  'reasoning_persistence', 'image', 'image_detail', 'video', 'audio', 'web_search_enabled', 'api_format',
  'ollama_mode', 'ollama_api_mode', 'ollama_keep_alive', 'deployment_mode', 'local_runtime',
  'capability_overrides', 'capability_checked_at', 'capability_fingerprint',
]
const createFields = new Set(['name', ...aiKeys])
const updateFields = new Set(['name', 'in_pool', ...aiKeys.filter(key => !['capability_checked_at', 'capability_fingerprint'].includes(key))])
const defaults: Record<string, unknown> = {
  max_tokens: DEFAULT_LLM_OUTPUT_TOKENS, context_tokens: DEFAULT_LLM_CONTEXT_TOKENS, thinking: '', reasoning_effort: '', reasoning_persistence: 'off',
  image: false, image_detail: 'auto', video: false, audio: false, web_search_enabled: false, api_format: '',
  ollama_mode: 'local', ollama_api_mode: 'native', ollama_keep_alive: '5m', deployment_mode: 'cloud',
  local_runtime: 'other', capability_overrides: {}, capability_checked_at: '', capability_fingerprint: '',
}
function fail(status: number, message: string): never {
  const error = new Error(message) as Error & { statusCode: number }
  error.statusCode = status
  throw error
}
function presets(config: Config) {
  if (!config.ai_presets || !Array.isArray(config.ai_presets.items)) config.ai_presets = { active_id: '', items: [] }
  return config.ai_presets
}
function show(item: Preset, snapshot: (value: Record<string, unknown>) => Record<string, unknown>) {
  return { ...item, api_key: maskSecret(item.api_key), in_pool: Boolean(item.in_pool), declared_capabilities: snapshot(item) }
}
function activeSegment(item: Preset) {
  return Object.fromEntries(aiKeys.map((key) => [key, item[key] ?? defaults[key]]))
}
function find(config: Config, id: string) {
  const all = presets(config), item = all.items!.find((row) => row.id === id)
  if (!item) fail(404, '预设不存在')
  return { all, item }
}
function validateDimensions(maxTokens: unknown, contextTokens: unknown) {
  const max = Number(maxTokens ?? defaults.max_tokens), context = Number(contextTokens ?? defaults.context_tokens)
  if (!Number.isInteger(max) || max <= 0 || !Number.isInteger(context) || context <= 1 || max >= context) fail(422, '最大输出 token 数必须小于模型总上下文窗口')
}
function providerSupportsSearch(provider: string, apiFormat: string) {
  return !['local', 'ollama'].includes(provider) && !['anthropic-native'].includes(apiFormat)
}
function itemFrom(body: Record<string, unknown>, id: string): Preset {
  validateDimensions(body.max_tokens, body.context_tokens)
  const provider = String(body.provider ?? '')
  const apiFormat = String(body.api_format ?? '')
  const search = body.web_search_enabled === undefined ? providerSupportsSearch(provider, apiFormat) : Boolean(body.web_search_enabled)
  if (search && !providerSupportsSearch(provider, apiFormat)) fail(422, '当前 Provider 或 API 格式不支持联网搜索')
  return {
    ...defaults, ...Object.fromEntries(Object.entries(body).filter(([key]) => createFields.has(key))), id, provider, api_format: apiFormat, api_key: String(body.api_key ?? ''),
    base_url: String(body.base_url ?? ''), model: String(body.model ?? ''),
    max_tokens: Number(body.max_tokens ?? defaults.max_tokens), context_tokens: Number(body.context_tokens ?? defaults.context_tokens),
    image_detail: ['auto', 'low', 'high', 'original'].includes(String(body.image_detail)) ? body.image_detail : 'auto',
    web_search_enabled: search,
  }
}

export function registerAdminLlmPresetRoutes(app: FastifyInstance, options: AdminLlmPresetOptions): void {
  const preHandler = options.requireAdmin, capabilitySnapshot = options.capabilitySnapshot ?? (() => ({})), audit = options.audit ?? (() => undefined)
  const invalidate = async () => { await options.invalidateActiveRuntime?.(); await options.invalidateReasoningStates?.() }
  const matches = options.destinationMatches ?? ((_provider, _apiFormat, baseUrl) => {
    try { const url = new URL(baseUrl); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password }
    catch { return false }
  })
  app.get('/api/v1/admin/agent/llm-presets', { preHandler }, async () => {
    const config = options.read(), collection = presets(config)
    return { active_id: collection.active_id ?? '', strategy: collection.strategy ?? 'active', pool_mode: collection.pool_mode ?? 'random', items: collection.items!.map((item) => show(item, capabilitySnapshot)) }
  })
  app.post('/api/v1/admin/agent/llm-presets/strategy', { preHandler }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    if (body.strategy != null && !['active', 'pool', 'router'].includes(String(body.strategy))) fail(400, 'strategy 只能是 active / pool / router')
    if (body.pool_mode != null && !['random', 'round_robin', 'least_loaded'].includes(String(body.pool_mode))) fail(400, 'pool_mode 只能是 random / round_robin / least_loaded')
    const result = options.mutate((config) => {
      const collection = presets(config)
      if (body.strategy != null) collection.strategy = String(body.strategy)
      if (body.pool_mode != null) collection.pool_mode = String(body.pool_mode)
      return { strategy: collection.strategy ?? 'active', pool_mode: collection.pool_mode ?? 'random' }
    })
    await invalidate()
    return result
  })
  app.post('/api/v1/admin/agent/llm-presets', { preHandler }, async (request, reply) => {
    const id = options.newId?.() ?? `p_${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const item = itemFrom(request.body as Record<string, unknown>, id)
    const result = options.mutate((config) => {
      const collection = presets(config); collection.items!.push(item)
      if (!collection.active_id) { collection.active_id = id; config.ai = activeSegment(item) }
      return { ...item, api_key: maskSecret(item.api_key) }
    })
    await invalidate()
    await audit('llm_preset.create', { preset_id: id, provider: item.provider })
    return reply.code(201).send(result)
  })
  app.put<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id', { preHandler }, async (request) => {
    const changes = request.body as Record<string, unknown>
    const result = options.mutate((config) => {
      const { all, item } = find(config, request.params.preset_id)
      const nextProvider = String(changes.provider ?? item.provider), nextFormat = String(changes.api_format ?? item.api_format ?? ''), nextUrl = String(changes.base_url ?? item.base_url)
      if (item.api_key && !changes.api_key && (nextProvider !== item.provider || nextFormat !== String(item.api_format ?? '') || nextUrl.replace(/\/$/, '') !== item.base_url.replace(/\/$/, ''))) fail(422, '服务商、接口格式或地址已变更，请重新填写 API Key')
      const next: Record<string, unknown> = { ...item, ...Object.fromEntries(Object.entries(changes).filter(([key, value]) => updateFields.has(key) && value !== null)), api_key: changes.api_key || item.api_key }
      validateDimensions(next.max_tokens, next.context_tokens)
      if (next.web_search_enabled && !providerSupportsSearch(String(next.provider), String(next.api_format ?? ''))) fail(422, '当前 Provider 或 API 格式不支持联网搜索')
      if (!providerSupportsSearch(String(next.provider), String(next.api_format ?? ''))) next.web_search_enabled = false
      if (changes.capability_overrides !== undefined) { next.capability_checked_at = ''; next.capability_fingerprint = '' }
      Object.assign(item, next)
      if (all.active_id === item.id) config.ai = activeSegment(item)
      return { ...item, api_key: maskSecret(item.api_key) }
    })
    await invalidate()
    await audit('llm_preset.update', { preset_id: request.params.preset_id })
    return result
  })
  app.delete<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id', { preHandler }, async (request) => {
    const id = request.params.preset_id
    const result = options.mutate((config) => {
      const all = presets(config)
      if (all.items!.length <= 1) fail(400, '至少保留一个预设')
      if (all.active_id === id) fail(400, '无法删除当前激活的预设，请先切换到其他预设')
      if (!all.items!.some((item) => item.id === id)) fail(404, '预设不存在')
      all.items = all.items!.filter((item) => item.id !== id)
      return { deleted: id }
    })
    await invalidate()
    await audit('llm_preset.delete', { preset_id: id })
    return result
  })
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/activate', { preHandler }, async (request) => {
    const result = options.mutate((config) => { const { all, item } = find(config, request.params.preset_id); all.active_id = item.id; config.ai = activeSegment(item); return { active_id: item.id } })
    await invalidate()
    await audit('llm_preset.activate', { preset_id: request.params.preset_id })
    return result
  })
  app.put<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/capability-overrides', { preHandler }, async (request) => {
    const body = request.body
    const allowed = new Set(['thinking', 'structured_json', 'structured_schema', 'tools', 'parallel_tools', 'image', 'audio', 'video'])
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.entries(body).some(([key, value]) => !allowed.has(key) || typeof value !== 'boolean')) fail(400, '能力覆盖字段或值无效')
    const overrides = { ...(body as Record<string, boolean>) }
    const result = options.mutate((config) => {
      const { all, item } = find(config, request.params.preset_id)
      item.capability_overrides = overrides
      item.capability_checked_at = ''
      item.capability_fingerprint = ''
      if (all.active_id === item.id) config.ai = activeSegment(item)
      return { capability_overrides: overrides }
    })
    await invalidate()
    await audit('llm_preset.capability_overrides', { preset_id: request.params.preset_id, capabilities: Object.keys(overrides) })
    return result
  })
  app.get<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/models', { preHandler }, async (request, reply) => {
    const { item } = find(options.read(), request.params.preset_id)
    if (!matches(item.provider, String(item.api_format ?? ''), item.base_url)) return reply.code(422).send({ error: '模型服务地址无效' })
    try { return { models: await options.fetchModels(item.base_url, item.provider, item.api_key, String(item.api_format ?? '')), source: 'provider' } }
    catch { return reply.code(502).send({ error: '模型列表获取失败' }) }
  })
  app.post('/api/v1/admin/agent/llm-presets/models-preview', { preHandler }, async (request, reply) => {
    const body = request.body as Record<string, unknown>
    if (typeof body.provider !== 'string' || typeof body.api_key !== 'string' || typeof body.base_url !== 'string') fail(422, 'Provider、地址和 API Key 为必填项')
    if (!matches(body.provider, String(body.api_format ?? ''), body.base_url)) return reply.code(422).send({ error: '模型服务地址无效' })
    try { return { models: await options.fetchModels(body.base_url, body.provider, body.api_key, String(body.api_format ?? '')), source: 'provider' } }
    catch { return reply.code(502).send({ error: '模型列表获取失败' }) }
  })
}

export interface ModelDirectoryRouteOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createAdminModelDirectory>}
function parse(value:unknown,voice:boolean):Record<string,string>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const input=value as Record<string,unknown>,result:Record<string,string>={provider:'openai',base_url:'',api_key:'',api_format:''}
 for(const key of ['provider','base_url','api_key','api_format','local_runtime',...(voice?['preset_id']:[])]){
  if(input[key]===undefined)continue
  if(typeof input[key]!=='string')return null
  if(key!=='local_runtime')result[key]=input[key]
 }
 return result
}
export function registerModelDirectoryRoutes(app:FastifyInstance,options:ModelDirectoryRouteOptions):void{
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&['AdminModelDirectoryError','LlmModelDirectoryError'].includes(error.name))return reply.code((error as Error&{status:number}).status).send({detail:error.message})
   throw error
  }
 }
 app.get<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/models',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.saved(request.params.preset_id),reply))
 for(const kind of ['llm','voice'] as const)app.post(`/api/v1/admin/agent/${kind}-presets/models-preview`,{preHandler:options.requireAdmin},(request,reply)=>{
  const input=parse(request.body,kind==='voice')
  if(!input)return reply.code(422).send({detail:'模型列表参数无效'})
  return execute(()=>kind==='voice'?options.operations.voice(input):options.operations.preview(input),reply)
 })
}

export function createAdminLlmPresetReader(path: string) {
  return () => readAdminLlmPresets(readConfigOverride(path))
}

export interface AdminLlmPresetReadOptions {
  requireAdmin: preHandlerHookHandler
  read: ReturnType<typeof createAdminLlmPresetReader>
}

export function registerAdminLlmPresetReadRoute(app: FastifyInstance, options: AdminLlmPresetReadOptions): void {
  app.get('/api/v1/admin/agent/llm-presets', { preHandler: options.requireAdmin }, () => options.read())
}

export interface LlmPresetSelectionOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createLlmPresetSelection>}
export function registerLlmPresetSelectionRoutes(app:FastifyInstance,options:LlmPresetSelectionOptions):void{
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&error.name==='LlmPresetSelectionError')return reply.code((error as Error&{code?:string}).code==='not_found'?404:400).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 }
 app.post<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/activate',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.activate(request.params.preset_id),reply))
 app.delete<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.delete(request.params.preset_id),reply))
}

export interface AgentCapabilityCatalog {
  readonly generation: number
  readonly diagnostics: readonly string[]
  readonly tools: readonly Record<string, unknown>[]
  readonly skills: readonly Record<string, unknown>[]
}

export function registerAgentCapabilityCatalogRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<AgentCapabilityCatalog>
}): void {
  app.get('/api/v1/admin/agent/capabilities', { preHandler: options.requireAdmin }, async () => options.read())
}
