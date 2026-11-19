import { CoreError } from '@gugu/core'
import { dataImportMaxUploadBytes, DataImportPreflightError, DataImportUploadError, type createDataImportPreflighter } from '@gugu/core/data-portability/preflight-import'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import type { UserFromRequest } from '../../app.js'
import { InvalidImportConfirmation, type createDataImportApplier, type createDataImportRecoverer, type createDataImportRollbackCreator } from '@gugu/core/data-portability/apply-import'
import { jobUuid } from './jobs.js'
import type { createDataImportResumer } from '@gugu/core/data-portability/resume-import'

export interface DataImportPreflightRouteOptions {
  ownerIdFromRequest(request: FastifyRequest): string
  preflight: ReturnType<typeof createDataImportPreflighter>
}

export function registerDataImportPreflightRoute(app: FastifyInstance, options: DataImportPreflightRouteOptions): void {
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload))
  app.post('/api/v1/data-portability/imports/preflight', {
    bodyLimit: dataImportMaxUploadBytes,
    preHandler: async (request, reply) => {
      const contentType = (request.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/zip' && contentType !== 'application/octet-stream')
        return reply.code(415).send({ detail: '请选择 ZIP 格式的 Gugu 数据归档' })
      const rawLength = request.headers['content-length']
      if (rawLength !== undefined) {
        const length = Number(rawLength)
        if (!Number.isSafeInteger(length) || length < 0)
          return reply.code(400).send({ detail: '上传长度无效' })
        if (length > dataImportMaxUploadBytes)
          return reply.code(413).send({ detail: '上传归档超过大小限制' })
      }
    },
  }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const source = request.body as AsyncIterable<Uint8Array>
    try {
      if (!source || typeof source[Symbol.asyncIterator] !== 'function')
        return reply.code(400).send({ detail: '上传归档为空' })
      const { id, importToken, createdAt, expiresAt } = await options.preflight(ownerId, source)
      return reply.code(202).header('Cache-Control', 'no-store').send({
        id, status: 'queued', stage: 'queued', mode: 'preflight',
        progress_current: 0, progress_total: null, error_code: null, preview: null,
        created_at: createdAt.toISOString(), expires_at: expiresAt.toISOString(), rollback_expires_at: null,
        import_token: importToken,
      })
    } catch (error) {
      if (error instanceof DataImportUploadError || error instanceof DataImportPreflightError)
        return reply.code(error.statusCode).send({ detail: error.message })
      if (error instanceof CoreError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400
        return reply.code(status).send({ detail: error.message })
      }
      return reply.code(503).send({ detail: '上传归档暂时失败，请重试' })
    }
  })
}

const applyImportBody=z.object({mode:z.enum(['incremental','replace']),import_token:z.string().refine(v=>Array.from(v).length>=32&&Array.from(v).length<=128),idempotency_key:z.string().refine(v=>Array.from(v).length>=8&&Array.from(v).length<=128)})

export function registerDataImportApplyRoute(app:FastifyInstance,userFromRequest:UserFromRequest,apply:ReturnType<typeof createDataImportApplier>):void {
 app.post('/api/v1/data-portability/imports/:job_id/apply',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id),parsed=applyImportBody.safeParse(request.body)
  if(id===null||!parsed.success)return reply.code(422).send({detail:'导入确认请求无效'})
  try{return reply.code(202).header('Cache-Control','no-store').send(await apply(owner,id,parsed.data.mode,parsed.data.import_token,parsed.data.idempotency_key))}catch(error){if(error instanceof InvalidImportConfirmation)return reply.code(403).send({detail:error.message});throw error}
 })
}

export function registerDataImportResumeRoute(app:FastifyInstance,userFromRequest:UserFromRequest,resume:ReturnType<typeof createDataImportResumer>):void{
 app.post('/api/v1/data-portability/imports/:job_id/resume',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id)
  if(id===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  const result=await resume(owner,id)
  return reply.header('Cache-Control','no-store').send(result)
 })
}

export interface DataImportCancelOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 cancel(ownerId:string,jobId:string):Promise<string|null>
 cleanup(ownerId:string,jobId:string,stagingKey:string):Promise<void>
 read(ownerId:string,jobId:string):Promise<unknown>
}

export function registerDataImportCancelRoute(app:FastifyInstance,options:DataImportCancelOptions):void{
 app.post<{Params:{job_id:string}}>('/api/v1/data-portability/imports/:job_id/cancel',{preHandler:options.requireUser},async(request,reply)=>{
  const jobId=jobUuid(request.params.job_id)
  if(jobId===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  const ownerId=options.ownerIdFromRequest(request)
  try{
   const stagingKey=await options.cancel(ownerId,jobId)
   if(stagingKey){try{await options.cleanup(ownerId,jobId,stagingKey)}catch{/* 状态已提交；过期清理器可再次回收暂存。 */}}
   return await options.read(ownerId,jobId)
  }catch(error){
   if(error instanceof CoreError){
    const status=error.code==='not_found'?404:error.code==='conflict'?409:400
    return reply.code(status).send({detail:error.message})
   }
   throw error
  }
 })
}

export function registerDataImportRecoverRoute(app:FastifyInstance,userFromRequest:UserFromRequest,recover:ReturnType<typeof createDataImportRecoverer>):void {
 app.post('/api/v1/data-portability/imports/:job_id/recover',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id)
  if(id===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  return reply.code(202).header('Cache-Control','no-store').send(await recover(owner,id))
 })
}

const rollbackImportBody=z.object({idempotency_key:z.string().refine(v=>Array.from(v).length>=8&&Array.from(v).length<=128)})

export function registerDataImportRollbackRoute(app:FastifyInstance,userFromRequest:UserFromRequest,rollback:ReturnType<typeof createDataImportRollbackCreator>):void {
 app.post('/api/v1/data-portability/imports/:job_id/rollback',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id),parsed=rollbackImportBody.safeParse(request.body)
  if(id===null||!parsed.success)return reply.code(422).send({detail:'回滚请求无效'})
  return reply.code(202).header('Cache-Control','no-store').send(await rollback(owner,id,parsed.data.idempotency_key))
 })
}

export interface DataImportDeleteOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 remove(ownerId:string,jobId:string):Promise<void>
}

export function registerDataImportDeleteRoute(app:FastifyInstance,options:DataImportDeleteOptions):void{
 app.delete<{Params:{job_id:string}}>('/api/v1/data-portability/imports/:job_id',{preHandler:options.requireUser},async(request,reply)=>{
  const jobId=jobUuid(request.params.job_id)
  if(jobId===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  try{
   await options.remove(options.ownerIdFromRequest(request),jobId)
   return reply.code(204).send()
  }catch(error){
   if(error instanceof CoreError){
    const status=error.code==='not_found'?404:error.code==='conflict'?409:error.code==='storage_error'?503:400
    return reply.code(status).send({detail:error.message})
   }
   throw error
  }
 })
}
