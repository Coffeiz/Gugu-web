import type {FastifyInstance} from 'fastify'
import {z} from 'zod'
import type {UserFromRequest} from '../../app.js'
import type {createDataImportRollbackCreator} from '@gugu/core/data-portability/apply-import'
import {jobUuid} from './read-jobs.js'
const body=z.object({idempotency_key:z.string().refine(v=>Array.from(v).length>=8&&Array.from(v).length<=128)})
export function registerDataImportRollbackRoute(app:FastifyInstance,userFromRequest:UserFromRequest,rollback:ReturnType<typeof createDataImportRollbackCreator>):void {
 app.post('/api/v1/data-portability/imports/:job_id/rollback',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id),parsed=body.safeParse(request.body)
  if(id===null||!parsed.success)return reply.code(422).send({detail:'回滚请求无效'})
  return reply.code(202).header('Cache-Control','no-store').send(await rollback(owner,id,parsed.data.idempotency_key))
 })
}
