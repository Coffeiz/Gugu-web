import {CoreError} from '@gugu/core'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {jobUuid} from './read-jobs.js'

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
