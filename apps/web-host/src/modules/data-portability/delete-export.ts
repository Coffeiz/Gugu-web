import {CoreError} from '@gugu/core'
import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {jobUuid} from './read-jobs.js'

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
