import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { DataExportPreview } from '@gugu/core/data-portability/export-preview'
import { z } from 'zod'
import type { UserFromRequest } from '../../app.js'
import type { createDataExportCreator } from '@gugu/core/data-portability/create-export'
import type { createDataExportCanceler } from '@gugu/core/data-portability/cancel-export'
import { jobUuid } from './jobs.js'
import { CoreError } from '@gugu/core'

export interface DataExportPreviewOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 read(ownerId:string):Promise<DataExportPreview>
}

export function registerDataExportPreviewRoute(app:FastifyInstance,options:DataExportPreviewOptions):void {
 app.get('/api/v1/data-portability/export/preview',{preHandler:options.requireUser},request=>options.read(options.ownerIdFromRequest(request)))
}

const createExportBody=z.object({categories:z.array(z.string()).min(1),idempotency_key:z.string().refine(value=>Array.from(value).length>=8&&Array.from(value).length<=128)})

export function registerDataExportCreateRoute(app:FastifyInstance,userFromRequest:UserFromRequest,create:ReturnType<typeof createDataExportCreator>):void{
 app.post('/api/v1/data-portability/exports',async(request,reply)=>{
  const owner=userFromRequest(request).id,parsed=createExportBody.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'导出请求无效'})
  const result=await create(owner,parsed.data.categories,parsed.data.idempotency_key)
  return reply.code(202).send(result)
 })
}

export function registerDataExportCancelRoute(app:FastifyInstance,userFromRequest:UserFromRequest,cancel:ReturnType<typeof createDataExportCanceler>):void{
 app.post('/api/v1/data-portability/exports/:job_id/cancel',(request,reply)=>{
  const owner=userFromRequest(request).id
  const canonical=jobUuid((request.params as {job_id:string}).job_id)
  if(canonical===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  return cancel(owner,canonical)
 })
}

export interface DataExportDeleteOptions {
  requireUser:preHandlerHookHandler
  ownerIdFromRequest(request:FastifyRequest):string
  remove(ownerId:string,jobId:string):Promise<void>
}

export function registerDataExportDeleteRoute(app:FastifyInstance,options:DataExportDeleteOptions):void{
  app.delete<{Params:{job_id:string}}>('/api/v1/data-portability/exports/:job_id',{preHandler:options.requireUser},async(request,reply)=>{
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
