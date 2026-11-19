import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { z } from 'zod'


import type { createLlmCapabilityOverrideSetter } from '@gugu/core/agent/config/llm-capability-overrides'

import { pythonQueryBoolean } from '../../http/python-query.js'


import { createLlmCapabilityProbe,LlmCapabilityProbeError } from '@gugu/core/agent/config'

import type { ProviderConfig,ProviderTransport } from '@gugu/core/providers'

import { createNodeProviderTransport } from '@gugu/core/providers/node'

import type { LlmStrategyMutator } from '@gugu/core/agent/config/llm-strategy'


import { createLlmPresetMediaProbe,LlmPresetMediaProbeError } from '@gugu/core/agent/config'

import type { LlmMediaDimension } from '@gugu/core/agent/config'



import { createLlmPresetTest,LlmPresetTestError } from '@gugu/core/agent/config'

import { ensureLlmPresets } from '@gugu/core/agent/config/llm-strategy'





import type { ByokMediaDimension } from '@gugu/core/byok/media-capability-probe'

import { createByokMediaCapabilityProbeRunner } from '../byok/media-capability-probe.js'

const previewSchema = z.object({
  provider: z.string().min(1).max(64),
  api_format: z.string().max(32).default(''),
  base_url: z.string().max(500).default(''),
  model: z.string().max(200).default(''),
  ollama_api_mode: z.string().default('openai'),
  ollama_mode: z.string().default('local'),
  local_runtime: z.string().default('other'),
})

export interface AdminLlmCapabilityPreviewOptions {
  requireAdmin: preHandlerHookHandler
  preview(input: z.infer<typeof previewSchema>): unknown
}

export function registerAdminLlmCapabilityPreviewRoute(app: FastifyInstance, options: AdminLlmCapabilityPreviewOptions): void {
  app.post('/api/v1/admin/agent/llm-presets/capabilities-preview', { preHandler: options.requireAdmin }, (request, reply) => {
    const parsed = previewSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '能力预览参数无效' })
    return options.preview(parsed.data)
  })
}

export interface LlmCapabilityOverrideOptions {requireAdmin:preHandlerHookHandler;set:ReturnType<typeof createLlmCapabilityOverrideSetter>}
function parse(value:unknown):Record<string,boolean>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const result:Record<string,boolean>={}
 try{for(const [key,raw] of Object.entries(value)){
  if(raw===null||Array.isArray(raw))return null
  Object.defineProperty(result,key,{value:raw===0||raw===1?Boolean(raw):pythonQueryBoolean(raw),enumerable:true,writable:true,configurable:true})
 }}catch{return null}
 return result
}
export function registerLlmCapabilityOverrideRoute(app:FastifyInstance,options:LlmCapabilityOverrideOptions):void{
 app.put<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/capability-overrides',{preHandler:options.requireAdmin},async(request,reply)=>{
  const input=parse(request.body)
  if(!input)return reply.code(422).send({detail:'模型能力覆盖参数无效'})
  try{return await options.set(request.params.preset_id,input)}catch(error){
   if(error instanceof Error&&error.name==='LlmCapabilityOverrideError')return reply.code((error as Error&{code?:string}).code==='not_found'?404:400).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 })
}

export function createAdminLlmCapabilityProbe(options: {
  environment?: NodeJS.ProcessEnv
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  invalidate(): Promise<unknown>
  createTransport?(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
}) {
  return createLlmCapabilityProbe({
    readDocument: options.readDocument,
    mutate: options.mutate,
    invalidate: options.invalidate,
    createTransport(config) {
      if (options.createTransport) return options.createTransport(config)
      const provider = (config.provider ?? '').trim().toLowerCase()
      return createNodeProviderTransport({ allowLocal: provider === 'local' || provider === 'ollama', environment: () => options.environment ?? process.env })
    },
  })
}

export function registerAdminLlmCapabilityProbeRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe(id: string): Promise<unknown>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/capabilities', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    try { return await options.probe(request.params.preset_id) }
    catch (error) {
      if (error instanceof LlmCapabilityProbeError) return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}

export function createAdminLlmPresetMediaProbe(options: {
  environment?: NodeJS.ProcessEnv
  readDocument(): unknown | Promise<unknown>
  mutate: LlmStrategyMutator
  invalidate(): Promise<unknown>
  probe?(input: AdminMediaProbePreviewInput): ReturnType<ReturnType<typeof createAdminMediaProbePreview>>
}) {
  const runProbe = options.probe ?? createAdminMediaProbePreview(options.environment ?? {})
  return createLlmPresetMediaProbe({
    readDocument: options.readDocument,
    mutate: options.mutate,
    invalidate: options.invalidate,
    probe: (config, dim) => runProbe({
      provider: typeof config.provider === 'string' ? config.provider : 'openai',
      api_key: typeof config.api_key === 'string' ? config.api_key : '',
      base_url: typeof config.base_url === 'string' ? config.base_url : '',
      model: typeof config.model === 'string' ? config.model : '',
      api_format: typeof config.api_format === 'string' ? config.api_format : '',
      dim,
    } satisfies AdminMediaProbePreviewInput),
  })
}

export function registerAdminLlmPresetMediaProbeRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe(id: string, dim?: LlmMediaDimension): Promise<unknown>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/probe-media', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    const rawDim = (request.query as Record<string, unknown>).dim
    const dim = rawDim === undefined || rawDim === '' ? undefined
      : typeof rawDim === 'string' && ['image', 'video', 'audio'].includes(rawDim) ? rawDim as LlmMediaDimension : null
    if (dim === null) return reply.code(400).send({ detail: 'dim 仅支持 image/video/audio' })
    try { return await options.probe(request.params.preset_id, dim) }
    catch (error) {
      if (error instanceof LlmPresetMediaProbeError) return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => typeof value === 'string' ? value : ''

export interface AdminLlmPresetTestOptions {
  requireAdmin: preHandlerHookHandler
  readDocument(): unknown | Promise<unknown>
  environment: NodeJS.ProcessEnv
  createTransport?(config: ProviderConfig): ProviderTransport & { close?(): Promise<void> }
}

export function createAdminLlmPresetTest(options: Omit<AdminLlmPresetTestOptions, 'requireAdmin'>) {
  return createLlmPresetTest({
    async readPreset(id) {
      const raw = await options.readDocument()
      if (!record(raw)) throw new Error('invalid config document')
      const presets = ensureLlmPresets(structuredClone(raw))
      if (!Array.isArray(presets.items)) throw new Error('invalid preset list')
      const item = presets.items.find(value => record(value) && value.id === id)
      if (!record(item)) return null
      return { ...item, provider: text(item.provider) || 'openai', model: text(item.model), api_key: text(item.api_key),
        base_url: text(item.base_url), api_format: text(item.api_format) } as ProviderConfig
    },
    createTransport(config) {
      if (options.createTransport) return options.createTransport(config)
      const provider = config.provider?.trim().toLowerCase()
      return createNodeProviderTransport({
        allowLocal: provider === 'local' || provider === 'ollama',
        connectTimeoutMs: 10_000,
        environment: () => options.environment,
      })
    },
  })
}

export function registerAdminLlmPresetTestRoute(app: FastifyInstance, options: Pick<AdminLlmPresetTestOptions, 'requireAdmin'> & {
  test(id: string): ReturnType<ReturnType<typeof createLlmPresetTest>>
}): void {
  app.post<{ Params: { preset_id: string } }>('/api/v1/admin/agent/llm-presets/:preset_id/test', {
    preHandler: options.requireAdmin,
  }, async (request, reply) => {
    try {
      const result = await options.test(request.params.preset_id)
      return { ...result, probe: { status: result.status } }
    } catch (error) {
      if (error instanceof LlmPresetTestError)
        return reply.code(error.status).send({ detail: error.message })
      throw error
    }
  })
}

const bodySchema = z.object({
  provider: z.string(),
  api_key: z.string().default(''),
  base_url: z.string().default(''),
  model: z.string().default(''),
  api_format: z.string().default(''),
})
const dimensionSchema = z.object({ dim: z.enum(['image', 'video', 'audio']).default('image') })

export type AdminMediaProbePreview = ReturnType<typeof createAdminMediaProbePreview>
export interface AdminMediaProbePreviewInput {
  provider: string; api_key: string; base_url: string; model: string; api_format: string; dim: ByokMediaDimension
}

/** 复用正式受控 Provider transport；草稿只探测，不读写后台配置。 */
export function createAdminMediaProbePreview(environment: NodeJS.ProcessEnv) {
  const probe = createByokMediaCapabilityProbeRunner(environment)
  return async (input: AdminMediaProbePreviewInput) => ({ dim: input.dim, ...await probe({
    provider: input.provider, apiFormat: input.api_format, baseUrl: input.base_url,
    model: input.model, apiKey: input.api_key,
  }, input.dim) })
}

export function registerAdminMediaProbePreviewRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  probe: (input: AdminMediaProbePreviewInput) => ReturnType<AdminMediaProbePreview>
}): void {
  app.post('/api/v1/admin/agent/llm-presets/probe-media-preview', { preHandler: options.requireAdmin }, async (request, reply) => {
    const body = bodySchema.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '媒体探测参数无效' })
    const query = dimensionSchema.safeParse(request.query)
    if (!query.success) return reply.code(400).send({ detail: 'dim 仅支持 image/video/audio' })
    return options.probe({ ...body.data, dim: query.data.dim as ByokMediaDimension })
  })
}
