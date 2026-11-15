import {hostname} from 'node:os'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'

export interface ServiceStatusRedis {get(key:string):Promise<string|null>;eval(script:string):Promise<string|null>;ping():Promise<boolean>}
export interface ServiceStatusOptions {redis:ServiceStatusRedis|null;dbOk():Promise<boolean>;web?:()=>{pid:number;host:string;uptime_secs:number};now?:()=>number}
// Redis传输只接收标量；固定只读Lua把Stream的数组响应编码成JSON，不接受请求参数。
const queueScript=`local length=redis.pcall('XLEN','im:inbound')
if type(length)=='table' and length.err then return cjson.encode({length=cjson.null,pending=cjson.null,lag=cjson.null,consumers=cjson.null}) end
local result={length=length,pending=0,lag=cjson.null,consumers=0}
local groups=redis.pcall('XINFO','GROUPS','im:inbound')
if type(groups)=='table' and not groups.err then
 for _,group in ipairs(groups) do
  local values={};for i=1,#group,2 do values[group[i]]=group[i+1] end
  if values.name=='agent-workers' then result.pending=values.pending or 0;result.lag=values.lag or cjson.null;result.consumers=values.consumers or 0 end
 end
end
return cjson.encode(result)`
type Heartbeat={pid?:number;host?:string;ts?:number;extra?:Record<string,unknown>}
const emptyQueue=()=>({length:null as number|null,pending:null as number|null,lag:null as number|null,consumers:null as number|null})

/** 仅观测：Node web事实来自本进程，Python worker/gateway事实只来自各自心跳。 */
export function createServiceStatusReader(options:ServiceStatusOptions){
 const now=options.now??(()=>Date.now()/1000)
 const web=options.web??(()=>({pid:process.pid,host:hostname(),uptime_secs:Math.floor(process.uptime())}))
 return async()=>{
  const beats:Record<string,Heartbeat>={}
  if(options.redis)for(const name of ['gateway','worker']){
   let raw:string|null
   try{raw=await options.redis.get(`health:${name}`)}catch{break}
   if(raw===null)continue
   let value:unknown
   try{value=JSON.parse(raw)}catch{continue}
   if(value===null)continue
   if(typeof value!=='object'||Array.isArray(value))throw new Error('服务心跳格式无效')
   if(Object.keys(value).length)beats[name]=value as Heartbeat
  }
  let queue=emptyQueue()
  if(options.redis)try{const raw=await options.redis.eval(queueScript);if(raw!==null)queue=JSON.parse(raw) as ReturnType<typeof emptyQueue>}catch{/* Python队列不可读时显式返回未知值。 */}
  let redis=false,db=false
  if(options.redis)try{redis=await options.redis.ping()}catch{/* 状态探测明确失败。 */}
  try{db=await options.dbOk()}catch{/* 状态探测明确失败。 */}
  const timestamp=Math.floor(now())
  const services:Array<Record<string,unknown>>=[{name:'web',label:'Web 后端',status:'online',...web(),restartable:false,extra:{}}]
  for(const [name,label] of [['gateway','网关管家'],['worker','消息 worker']] as const){
   const info=beats[name],seen=info?Number(info.ts??0):null
   if(seen!==null&&!Number.isFinite(seen))throw new Error('服务心跳时间格式无效')
   services.push({name,label,status:!info?'offline':timestamp-Math.trunc(seen!)>15?'stale':'online',pid:info?.pid??null,host:info?.host??null,last_seen_secs:seen===null?null:timestamp-Math.trunc(seen),restartable:true,extra:info?.extra??{}})
  }
  return {services,deps:{redis,db},queue}
 }
}

export function registerServiceStatusRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;read:ReturnType<typeof createServiceStatusReader>}):void{
 app.get('/api/v1/admin/services',{preHandler:options.requireAdmin},()=>options.read())
}
