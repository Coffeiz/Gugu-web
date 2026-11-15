import type {FastifyInstance} from 'fastify'
import type {UserFromRequest} from '../../app.js'
import type {createDataImportResumer} from '@gugu/core/data-portability/resume-import'
import {jobUuid} from './read-jobs.js'

export function registerDataImportResumeRoute(app:FastifyInstance,userFromRequest:UserFromRequest,resume:ReturnType<typeof createDataImportResumer>):void{
 app.post('/api/v1/data-portability/imports/:job_id/resume',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id)
  if(id===null)return reply.code(422).send({detail:'任务标识必须是 UUID'})
  const result=await resume(owner,id)
  return reply.header('Cache-Control','no-store').send(result)
 })
}
