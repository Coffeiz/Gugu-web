import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {createOpsSummaryReader,type OpsHashReader} from '@gugu/core/admin/ops-summary'
export function registerAdminOpsSummaryRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;hgetall:OpsHashReader;now?:()=>Date}):void {
 const read=createOpsSummaryReader(options.hgetall,options.now)
 app.get('/api/v1/admin/ops/summary',{preHandler:options.requireAdmin},async(request,reply)=>{
  // Pydantic整数语法；重复查询参数取最后一项，不能被Ajv转换为科学计数法。
  const values=new URL(request.url,'http://host.invalid').searchParams.getAll('days')
  const text=values.length?values.at(-1)!.trim():'1'
  const days=/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(text)?Number(text.replaceAll('_','')):NaN
  if(!Number.isSafeInteger(days)||days<1||days>14)return reply.code(422).send({detail:'days 必须是 1 到 14 的整数'})
  try{return await read(days)}catch{return reply.code(503).send({detail:'暂时无法读取运维指标'})}
 })
}
