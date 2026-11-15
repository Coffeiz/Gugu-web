import type {FastifyInstance} from 'fastify'
import type {UserFromRequest} from '../../app.js'
import type {createDataExportCanceler} from '@gugu/core/data-portability/cancel-export'
import {jobUuid} from './read-jobs.js'

export function registerDataExportCancelRoute(app:FastifyInstance,userFromRequest:UserFromRequest,cancel:ReturnType<typeof createDataExportCanceler>):void{
 app.post('/api/v1/data-portability/exports/:job_id/cancel',(request,reply)=>{
  const owner=userFromRequest(request).id
  const canonical=jobUuid((request.params as {job_id:string}).job_id)
  if(canonical===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  return cancel(owner,canonical)
 })
}
