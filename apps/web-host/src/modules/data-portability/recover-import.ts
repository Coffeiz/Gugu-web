import type {FastifyInstance} from 'fastify'
import type {UserFromRequest} from '../../app.js'
import type {createDataImportRecoverer} from '@gugu/core/data-portability/apply-import'
import {jobUuid} from './read-jobs.js'
export function registerDataImportRecoverRoute(app:FastifyInstance,userFromRequest:UserFromRequest,recover:ReturnType<typeof createDataImportRecoverer>):void {
 app.post('/api/v1/data-portability/imports/:job_id/recover',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id)
  if(id===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  return reply.code(202).header('Cache-Control','no-store').send(await recover(owner,id))
 })
}
