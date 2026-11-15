import type {FastifyInstance} from 'fastify'
import {z} from 'zod'
import type {UserFromRequest} from '../../app.js'
import {InvalidImportConfirmation,type createDataImportApplier} from '@gugu/core/data-portability/apply-import'
import {jobUuid} from './read-jobs.js'
const body=z.object({mode:z.enum(['incremental','replace']),import_token:z.string().refine(v=>Array.from(v).length>=32&&Array.from(v).length<=128),idempotency_key:z.string().refine(v=>Array.from(v).length>=8&&Array.from(v).length<=128)})
export function registerDataImportApplyRoute(app:FastifyInstance,userFromRequest:UserFromRequest,apply:ReturnType<typeof createDataImportApplier>):void {
 app.post('/api/v1/data-portability/imports/:job_id/apply',async(request,reply)=>{
  const owner=userFromRequest(request).id,id=jobUuid((request.params as {job_id:string}).job_id),parsed=body.safeParse(request.body)
  if(id===null||!parsed.success)return reply.code(422).send({detail:'导入确认请求无效'})
  try{return reply.code(202).header('Cache-Control','no-store').send(await apply(owner,id,parsed.data.mode,parsed.data.import_token,parsed.data.idempotency_key))}catch(error){if(error instanceof InvalidImportConfirmation)return reply.code(403).send({detail:error.message});throw error}
 })
}
