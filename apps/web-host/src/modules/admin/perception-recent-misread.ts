import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createAdminMisreadReader} from '@gugu/core/perception-recent-misread'
import {pythonQueryBoolean} from '../../http/python-query.js'

export interface AdminRecentMisreadOptions {
 requireAdmin:preHandlerHookHandler
 available():boolean
 read:ReturnType<typeof createAdminMisreadReader>
}
// Pydantic 接受整数小数串和数字间的下划线；保留巨整数，由各读取用例应用其范围规则。
export function parsePerceptionInteger(value:unknown,fallback:bigint):bigint{
 const last=Array.isArray(value)?value.at(-1):value
 if(last===undefined)return fallback
 if(typeof last!=='string')throw Object.assign(new Error('查询条数参数无效'),{statusCode:422})
 let start=0,end=last.length
 while(start<end&&/\p{White_Space}/u.test(last[start]!))start++
 while(end>start&&/\p{White_Space}/u.test(last[end-1]!))end--
 const token=last.slice(start,end)
 if(!/^[-+]?\d(?:_?\d)*(?:\.0+)?$/.test(token))throw Object.assign(new Error('查询条数参数无效'),{statusCode:422})
 return BigInt(token.replaceAll('_','').replace(/\.0+$/,''))
}
export function registerAdminRecentMisreadRoute(app:FastifyInstance,options:AdminRecentMisreadOptions):void{
 app.get('/api/v1/admin/perception/misread/recent',{preHandler:options.requireAdmin},(request,reply)=>{
  const query=request.query as Record<string,unknown>,requested=parsePerceptionInteger(query.n,30n),n=requested>200n?200:requested<0n?1:Number(requested),excludeDev=pythonQueryBoolean(query.exclude_dev)
  if(!options.available())return reply.code(503).send({detail:'感知记录服务不可用'})
  return options.read({n,excludeDev})
 })
}
