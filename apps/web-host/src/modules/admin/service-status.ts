import {hostname} from 'node:os'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'

export interface ServiceStatusRedis {eval(script:string):Promise<string|null>;ping():Promise<boolean>}
export interface ServiceStatusOptions {redis:ServiceStatusRedis|null;dbOk():Promise<boolean>;web?:()=>{pid:number;host:string;uptime_secs:number};worker?:()=>{online:boolean;restartable:boolean}}
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
const emptyQueue=()=>({length:null as number|null,pending:null as number|null,lag:null as number|null,consumers:null as number|null})

/** 服务状态来自本机 Node 生命周期，队列与依赖单独读取。 */
export function createServiceStatusReader(options:ServiceStatusOptions){
 const web=options.web??(()=>({pid:process.pid,host:hostname(),uptime_secs:Math.floor(process.uptime())}))
 return async()=>{
  let queue=emptyQueue()
  if(options.redis)try{const raw=await options.redis.eval(queueScript);if(raw!==null)queue=JSON.parse(raw) as ReturnType<typeof emptyQueue>}catch{/* IM 队列不可读时显式返回未知值。 */}
  let redis=false,db=false
  if(options.redis)try{redis=await options.redis.ping()}catch{/* 状态探测明确失败。 */}
  try{db=await options.dbOk()}catch{/* 状态探测明确失败。 */}
  const instance=web(), worker=options.worker?.()
  const services=[
   {name:'web',label:'Web 后端',status:'online',...instance,restartable:false,extra:{}},
   {name:'gateway',label:'网关管家',status:'offline',pid:null,host:null,last_seen_secs:null,restartable:false,extra:{}},
   {name:'worker',label:'Node 后台任务',status:worker?.online?'online':'offline',
    pid:worker?.online?instance.pid:null,host:worker?.online?instance.host:null,last_seen_secs:null,
    restartable:worker?.restartable??false,extra:{}},
  ]
  return {services,deps:{redis,db},queue}
 }
}

export function registerServiceStatusRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;read:ReturnType<typeof createServiceStatusReader>}):void{
 app.get('/api/v1/admin/services',{preHandler:options.requireAdmin},()=>options.read())
}
