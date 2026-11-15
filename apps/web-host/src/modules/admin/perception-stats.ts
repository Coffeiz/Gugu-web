import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createPerceptionStatsReader} from '@gugu/core/perception-stats'
import {pythonQueryBoolean} from '../../http/python-query.js'
import {parsePerceptionInteger} from './perception-recent-misread.js'

export interface AdminPerceptionStatsOptions {requireAdmin:preHandlerHookHandler;available():boolean;read:ReturnType<typeof createPerceptionStatsReader>}
function float(value:unknown,fallback:number):number{
 const last=Array.isArray(value)?value.at(-1):value
 if(last===undefined)return fallback
 if(typeof last!=='string')throw Object.assign(new Error('查询浮点参数无效'),{statusCode:422})
 let start=0,end=last.length
 while(start<end&&/\p{White_Space}/u.test(last[start]!))start++
 while(end>start&&/\p{White_Space}/u.test(last[end-1]!))end--
 const token=last.slice(start,end)
 if(!/^[-+]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[-+]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i.test(token))throw Object.assign(new Error('查询浮点参数无效'),{statusCode:422})
 const normalized=token.replaceAll('_','')
 return /^[-+]?inf(?:inity)?$/i.test(normalized)?(normalized.startsWith('-')?-Infinity:Infinity):Number(normalized)
}
export function registerAdminPerceptionStatsRoute(app:FastifyInstance,options:AdminPerceptionStatsOptions):void{
 app.get('/api/v1/admin/perception',{preHandler:options.requireAdmin},async(request,reply)=>{
  const query=request.query as Record<string,unknown>
  const parsed={hours:parsePerceptionInteger(query.hours,168n),limit:parsePerceptionInteger(query.limit,20000n),minEvents:parsePerceptionInteger(query.min_events,1n),minN:parsePerceptionInteger(query.min_n,10n),rateHi:float(query.rate_hi,0.25),ambigHi:float(query.ambig_hi,60),excludeDev:pythonQueryBoolean(query.exclude_dev)}
  if(!options.available())return reply.code(503).send({detail:'感知记录服务不可用'})
  const value=await options.read(parsed)
  const json=JSON as typeof JSON&{rawJSON(value:string):unknown}
  return reply.type('application/json').send(JSON.stringify(value,(_key,item:unknown)=>typeof item==='bigint'?json.rawJSON(String(item)):item))
 })
}
