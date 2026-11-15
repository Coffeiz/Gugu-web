import type {FastifyInstance} from 'fastify'
import {z} from 'zod'
import type {UserFromRequest} from '../../app.js'
import type {createDataExportCreator} from '@gugu/core/data-portability/create-export'
const body=z.object({categories:z.array(z.string()).min(1),idempotency_key:z.string().refine(value=>Array.from(value).length>=8&&Array.from(value).length<=128)})
export function registerDataExportCreateRoute(app:FastifyInstance,userFromRequest:UserFromRequest,create:ReturnType<typeof createDataExportCreator>):void{
 app.post('/api/v1/data-portability/exports',async(request,reply)=>{
  const owner=userFromRequest(request).id,parsed=body.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'导出请求无效'})
  const result=await create(owner,parsed.data.categories,parsed.data.idempotency_key)
  return reply.code(202).send(result)
 })
}
