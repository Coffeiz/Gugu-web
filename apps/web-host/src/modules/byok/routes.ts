import type { FastifyInstance, preHandlerHookHandler, FastifyRequest } from 'fastify'
import { ByokEncryptionUnavailable, type createCredentialCreator, type createCredentialPatch } from './store.js'
import type { createByokListService } from '@gugu/core/agent/config'
import type { createCredentialSavedTest, createCredentialTestPreview } from './checks/connection.js'
import { testParams, createSchema, patchSchema, testSchema, modelsSchema, mediaSchema, previewSchema, type PreviewInput } from './schemas.js'
import type { ByokMediaProbeInput } from './checks/capabilities.js'
import type { createCredentialModelsPreview } from './checks/models.js'
import type { UserAuthOptions } from '../auth/contracts.js'
import type { WebUiOptions } from '../../http/options.js'
import { registerProtectedDomain } from '../../http/user.js'
import { diagLog } from '../../shared/log-files.js'

async function saveCredential<T>(run: () => Promise<T>, request: FastifyRequest, reply: import('fastify').FastifyReply) {
 try { return await run() }
 catch (error) {
  if (!(error instanceof ByokEncryptionUnavailable)) throw error
  diagLog(`http.${request.method} ${request.routeOptions.url}`, new Error(error.message))
  return reply.code(error.statusCode).send({ detail: error.message })
 }
}

export interface ProviderCapabilityPreviewOptions{
 requireUser:preHandlerHookHandler
 preview(input:PreviewInput):unknown
}

export function registerProviderCapabilityPreviewRoute(app:FastifyInstance,options:ProviderCapabilityPreviewOptions):void{
 app.post('/api/v1/byok/capabilities',{preHandler:options.requireUser},(request,reply)=>{
  const parsed=previewSchema.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'能力预览参数无效'})
  return options.preview(parsed.data)
 })
}

export interface CredentialCreateOptions{requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;create:ReturnType<typeof createCredentialCreator>}

export function registerCredentialCreateRoute(app:FastifyInstance,options:CredentialCreateOptions):void {
 for (const [path, makeDefault] of [['/api/v1/byok', true], ['/api/v1/byok/saved', false]] as const) {
  app.post(path, { preHandler: options.requireUser }, async (request, reply) => {
   const body = createSchema.safeParse(request.body)
   if (!body.success) return reply.code(422).send({ detail: '凭据参数无效' })
   return saveCredential(() => options.create(options.ownerIdFromRequest(request), body.data, makeDefault), request, reply)
  })
 }
}

export interface CredentialDeleteOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 remove(ownerId:string,credentialId:number):Promise<void>
}

export function registerCredentialDeleteRoute(app:FastifyInstance,options:CredentialDeleteOptions):void{
 app.delete<{Params:{credential_id:number}}>('/api/v1/byok/:credential_id',{
  preHandler:options.requireUser,
  schema:{params:{type:'object',required:['credential_id'],properties:{credential_id:{type:'integer'}}}},
 },async(request,reply)=>{
  await options.remove(options.ownerIdFromRequest(request),request.params.credential_id)
  return reply.code(204).send()
 })
}

export interface CredentialListOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 list:ReturnType<typeof createByokListService>
}

export function registerCredentialListRoute(app:FastifyInstance,options:CredentialListOptions):void{
 app.get('/api/v1/byok',{preHandler:options.requireUser},async request=>options.list(options.ownerIdFromRequest(request)))
}

export interface CredentialPatchRouteOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;patch:ReturnType<typeof createCredentialPatch>}

export function registerCredentialPatchRoute(app:FastifyInstance,options:CredentialPatchRouteOptions):void{
 app.patch<{Params:{credential_id:string}}>('/api/v1/byok/:credential_id',{preHandler:options.requireUser},async(request,reply)=>{
  const id=Number(request.params.credential_id),body=patchSchema.safeParse(request.body)
  if(!Number.isSafeInteger(id)||!body.success)return reply.code(422).send({detail:'凭据参数无效'})
  return saveCredential(() => options.patch(options.ownerIdFromRequest(request),id,body.data), request, reply)
 })
 app.put<{Params:{credential_id:string}}>('/api/v1/byok/:credential_id/default', { preHandler: options.requireUser }, async (request, reply) => {
  const id = Number(request.params.credential_id)
  if (!Number.isSafeInteger(id) || id < 1) return reply.code(422).send({ detail: '凭据编号无效' })
  await options.patch(options.ownerIdFromRequest(request), id, { enabled: true })
  return reply.code(204).send()
 })

}

export interface CredentialTestPreviewRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  preview: ReturnType<typeof createCredentialTestPreview>
  savedTest: ReturnType<typeof createCredentialSavedTest>
}

export function registerCredentialTestPreviewRoute(app: FastifyInstance, options: CredentialTestPreviewRouteOptions): void {
  app.post('/api/v1/byok/test-preview', { preHandler: options.requireUser }, async (request, reply) => {
    const body = testSchema.safeParse(request.body)
    if (!body.success) return reply.code(422).send({ detail: '凭据参数无效' })
    try { return await options.preview(options.ownerIdFromRequest(request), body.data) }
    catch (error) {
      const current = error as { statusCode?: unknown; code?: unknown }
      const status = Number(current.statusCode) || (current.code === 'not_found' ? 404 : 0)
      if (status === 403 || status === 404 || status === 422)
        return reply.code(status).send({ detail: error instanceof Error ? error.message : '请求无效' })
      return reply.code(502).send({ detail: '凭据测试失败，请检查配置' })
    }
  })
  app.post('/api/v1/byok/:credential_id/test', { preHandler: options.requireUser }, async (request, reply) => {
    const params = testParams.safeParse(request.params)
    if (!params.success) return reply.code(422).send({ detail: '凭据参数无效' })
    try { return await options.savedTest(options.ownerIdFromRequest(request), params.data.credential_id) }
    catch (error) {
      const current = error as { statusCode?: unknown; code?: unknown }
      const status = Number(current.statusCode) || (current.code === 'not_found' ? 404 : 0)
      if (status === 403 || status === 404 || status === 422)
        return reply.code(status).send({ detail: error instanceof Error ? error.message : '请求无效' })
      return reply.code(502).send({ detail: '凭据测试失败，请检查配置' })
    }
  })
}

export interface ByokMediaProbeOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  probe(owner: string, input: ByokMediaProbeInput): Promise<{ dim: string; supported: boolean | null; status: number; detail: string }>
}

export function registerByokMediaCapabilityProbeRoute(app: FastifyInstance, options: ByokMediaProbeOptions): void {
  app.post('/api/v1/byok/media-capability-probe', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = mediaSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '凭据参数无效' })
    try { return await options.probe(options.ownerIdFromRequest(request), parsed.data) }
    catch (error) {
      const current = error as { statusCode?: unknown; code?: unknown }
      const status = Number(current.statusCode) || (current.code === 'not_found' ? 404 : 0)
      if (status === 403 || status === 404 || status === 422)
        return reply.code(status).send({ detail: error instanceof Error ? error.message : '请求无效' })
      return reply.code(502).send({ detail: '多模态能力检测失败，请检查配置' })
    }
  })
}

export interface CredentialModelsPreviewRouteOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;preview:ReturnType<typeof createCredentialModelsPreview>}

export function registerCredentialModelsPreviewRoute(app:FastifyInstance,options:CredentialModelsPreviewRouteOptions):void{
 app.post('/api/v1/byok/models-preview',{preHandler:options.requireUser},async(request,reply)=>{
  const body=modelsSchema.safeParse(request.body)
  if(!body.success)return reply.code(422).send({detail:'凭据参数无效'})
  return options.preview(options.ownerIdFromRequest(request),body.data)
 })
}

export function registerByokRoutes(app: FastifyInstance, auth: UserAuthOptions, options: WebUiOptions) {
  registerProtectedDomain(app, auth, (routes, userFromRequest) => {
    const access = {
      requireUser: async (request: FastifyRequest) => { void userFromRequest(request) },
      ownerIdFromRequest: (request: FastifyRequest) => userFromRequest(request).requestContext.data.ownerId,
    }

    if (options.credentialCreate) registerCredentialCreateRoute(routes, { ...options.credentialCreate, ...access })
    if (options.credentialList) registerCredentialListRoute(routes, { ...options.credentialList, ...access })
    if (options.credentialPatch) registerCredentialPatchRoute(routes, { ...options.credentialPatch, ...access })
    if (options.credentialDelete) registerCredentialDeleteRoute(routes, { ...options.credentialDelete, ...access })
    if (options.credentialModelsPreview) registerCredentialModelsPreviewRoute(routes, { ...options.credentialModelsPreview, ...access })
    if (options.credentialTestPreview) registerCredentialTestPreviewRoute(routes, { ...options.credentialTestPreview, ...access })
    if (options.credentialMediaProbe) registerByokMediaCapabilityProbeRoute(routes, { ...options.credentialMediaProbe, ...access })
    if (options.providerCapabilityPreview) registerProviderCapabilityPreviewRoute(routes, { ...options.providerCapabilityPreview, requireUser: access.requireUser })
  })
}
