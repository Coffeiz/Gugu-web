import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { hostname } from 'node:os'

import type { createAdminMaintenanceStatus } from '@gugu/core/maintenance/admin-status'

import { asciiDecimalDigits } from '@gugu/core/shared/unicode-decimal'

export class UnsupportedServiceError extends Error {
  readonly code = 'unsupported_service'

  constructor(name: string) {
    super(`不支持重启 ${name}`)
    this.name = 'UnsupportedServiceError'
  }
}

export interface ServiceRestartOperations {
  restart(name: string): Promise<{ ok: boolean; msg: string }>
}

export function createServiceRestarter(restartWorkers: () => Promise<boolean>): ServiceRestartOperations['restart'] {
  return async name => {
    if (name === 'gateway') return { ok: false, msg: '当前 Host 没有可重启的网关服务。' }
    if (name !== 'worker') throw new UnsupportedServiceError(name)
    try {
      return await restartWorkers()
        ? { ok: true, msg: 'Node 后台任务已重启。' }
        : { ok: false, msg: 'Node 后台任务当前不可重启。' }
    } catch {
      return { ok: false, msg: 'Node 后台任务重启失败。' }
    }
  }
}

export function registerServiceRestartRoute(
  app: FastifyInstance,
  options: ServiceRestartOperations & { requireAdmin: preHandlerHookHandler },
): void {
  app.post<{ Params: { name: string } }>(
    '/api/v1/admin/services/:name/restart',
    { preHandler: options.requireAdmin },
    async (request, reply) => {
      try { return await options.restart(request.params.name) }
      catch (error) {
        if (error instanceof UnsupportedServiceError)
          return reply.code(400).send({ detail: error.message })
        throw error
      }
    },
  )
}

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

export function registerAdminMaintenanceStatusRoutes(app:FastifyInstance,options:{
 requireAdmin:preHandlerHookHandler
 available():boolean
 read:ReturnType<typeof createAdminMaintenanceStatus>
 readAccountMemoryCleanup?(): Promise<unknown>
}):void{
 app.get('/api/v1/admin/agent/memory/im-scopes/maintenance/model-preview/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.read.imMemoryModelPreview()}catch(error){if(error instanceof SyntaxError)throw error;return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
 app.get('/api/v1/admin/config/index-rebuild/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.read.indexRebuild()}catch{return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
 app.get('/api/v1/admin/config/memory-cleanup/status',{preHandler:options.requireAdmin},async(_request,reply)=>{
  if(!options.available())return reply.code(503).send({detail:'维护状态服务不可用'})
  try{return await options.readAccountMemoryCleanup?.() ?? await options.read.memoryCleanup()}catch{return reply.code(503).send({detail:'维护状态服务不可用'})}
 })
}

export type AdminUpdateMode = 'integrated_compose' | 'split_compose' | 'standalone_app_bundle' | 'unknown'

export function resolveAdminUpdateMode(value: string | undefined): AdminUpdateMode {
  switch (value?.trim().toLowerCase()) {
    case 'integrated_compose': return 'integrated_compose'
    case 'split_compose': return 'split_compose'
    case 'standalone_app_bundle':
    case 'standalone_docker': return 'standalone_app_bundle'
    default: return 'unknown'
  }
}

export function registerAdminUpdateStatusRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;mode:AdminUpdateMode}):void{
 app.get('/api/v1/admin/update/status',{preHandler:options.requireAdmin},async()=>{
  if(options.mode==='integrated_compose'||options.mode==='split_compose')return{
   enabled:false,mode:options.mode,capability:'manual',reason_code:'manual_image_update',
   reason:'Compose 部署由 Docker/Compose 管理器更新整套镜像；Admin 不执行镜像更新。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
  if(options.mode==='standalone_app_bundle')return{
   enabled:false,mode:options.mode,capability:'manual',reason_code:'node_updater_unavailable',
   reason:'当前 Node Web Host 未接入签名应用包更新器，请按部署说明手动更新。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
  return{
   enabled:false,mode:'unknown',capability:'manual',reason_code:'deployment_unrecognized',
   reason:'无法可靠识别 Node Web Host 部署模式，自动更新已关闭。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
 })
}

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

export type OpsHash = Record<string, string | number | bigint | null | undefined>
export type OpsHashReader=(key:string)=>Promise<OpsHash|null|undefined>
const buckets = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000].map(String)
const securityEvents = [
  'ownership.denied',
  'confirm-gate.bypassed',
  'security_event.write_failed',
  'filesystem.authorization.denied',
]
const filesystemOutcomes = ['requested', 'granted', 'revoked', 'denied'] as const
type FilesystemOutcome = typeof filesystemOutcomes[number]

function integer(value: OpsHash[string]): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    const converted = Number(value)
    if (Number.isSafeInteger(converted)) return converted
  }
  const text = asciiDecimalDigits(String(value ?? '').trim())
  if (!/^[+-]?\d(?:_?\d)*$/.test(text)) throw new Error('运维计数格式无效')
  const parsed = Number(text.replaceAll('_',''))
  if (!Number.isSafeInteger(parsed)) throw new Error('运维计数超出安全范围')
  return parsed
}

function dayKey(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('运维统计日期无效')
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

async function readHash(hgetall: OpsHashReader, key: string): Promise<OpsHash> {
  return await hgetall(key) ?? {}
}

function roundFour(value:number):number {
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,Math.abs(value))
 const bits=view.getBigUint64(0), exponent=Number((bits>>52n)&2047n)-1023-52
 let numerator=((bits&((1n<<52n)-1n))|(1n<<52n))*10000n, denominator=1n
 if(exponent>=0)numerator<<=BigInt(exponent);else denominator<<=BigInt(-exponent)
 let rounded=numerator/denominator;const remainder=numerator%denominator
 if(remainder*2n>denominator || remainder*2n===denominator && rounded%2n===1n)rounded++
 return Math.sign(value)*Number(rounded)/10000
}

/** 读取Python和Node生产者共用的按日运维hash；不触发采集或清理。 */
export function createOpsSummaryReader(hgetall:OpsHashReader,now:()=>Date=()=>new Date()) {
 return async(days=1)=>{
const today = now()
const dayKeys = Array.from({ length: days }, (_, offset) => {
  const day = new Date(today.getTime())
  day.setUTCDate(day.getUTCDate() - offset)
  return dayKey(day)
})
const tools: Record<string, { calls: number; fails: number; ms_sum: number }> = Object.create(null)
const latency: Record<string, number> = Object.create(null)
for (const day of dayKeys) {
  const toolHash = await readHash(hgetall, `ops:tool:${day}`)
  for (const [key, raw] of Object.entries(toolHash)) {
    const separator = key.lastIndexOf(':')
    const tool = separator < 0 ? '' : key.slice(0, separator)
    const kind = separator < 0 ? key : key.slice(separator + 1)
    const aggregate = tools[tool] ??= { calls: 0, fails: 0, ms_sum: 0 }
    aggregate[kind as 'calls' | 'fails' | 'ms_sum'] = ((aggregate as Record<string, number>)[kind] ?? 0) + integer(raw)
  }
  const latencyHash = await readHash(hgetall, `ops:lat:${day}`)
  for (const [bucket, raw] of Object.entries(latencyHash))
    latency[bucket] = (latency[bucket] ?? 0) + integer(raw)
}

const security: Record<string, number> = Object.assign(Object.create(null),Object.fromEntries(securityEvents.map((event) => [event, 0])))
for (const day of dayKeys) {
  const hash = await readHash(hgetall, `ops:sec:${day}`)
  for (const [event, raw] of Object.entries(hash)) security[event] = (security[event] ?? 0) + integer(raw)
}

const email = { calls: 0, sent: 0, failed: 0, ms_sum: 0, errors: Object.create(null) as Record<string, number> }
for (const day of dayKeys) {
  const hash = await readHash(hgetall, `ops:email:${day}`)
  for (const [key, raw] of Object.entries(hash)) {
    const value = integer(raw)
    if (key.startsWith('error:')) {
      const code = key.slice(6)
      email.errors[code] = (email.errors[code] ?? 0) + value
    } else if (key === 'calls' || key === 'sent' || key === 'failed' || key === 'ms_sum') {
      email[key] += value
    }
  }
}
const emailSummary = {
  ...email,
  avg_ms: email.calls ? Math.trunc(email.ms_sum / email.calls) : 0,
  fail_rate: email.calls ? roundFour(email.failed / email.calls) : 0,
}

const filesystem: Record<'session' | 'scheduled_task', Record<FilesystemOutcome, number>> = {
  session: { requested: 0, granted: 0, revoked: 0, denied: 0 },
  scheduled_task: { requested: 0, granted: 0, revoked: 0, denied: 0 },
}
for (const day of dayKeys) {
  const hash = await readHash(hgetall, `ops:filesystem-auth:${day}`)
  for (const [key, raw] of Object.entries(hash)) {
    const separator = key.indexOf(':')
    const subject = separator < 0 ? key : key.slice(0, separator)
    const outcome = separator < 0 ? '' : key.slice(separator + 1)
    if ((subject === 'session' || subject === 'scheduled_task') && filesystemOutcomes.includes(outcome as FilesystemOutcome))
      filesystem[subject][outcome as FilesystemOutcome] += integer(raw)
  }
}

const rows = Object.entries(tools).map(([tool, aggregate]) => {
  const calls = aggregate.calls || 0
  const fails = aggregate.fails || 0
  return {
    tool,
    calls,
    fails,
    fail_rate: calls ? roundFour(fails / calls) : 0,
    avg_ms: calls ? Math.trunc(aggregate.ms_sum / calls) : 0,
  }
}).sort((left, right) => right.fails - left.fails || right.calls - left.calls)

const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0)
const totalFails = rows.reduce((sum, row) => sum + row.fails, 0)
const totalLatency = Object.values(latency).reduce((sum, count) => sum + count, 0)
let p99: number | null = null
if (totalLatency) {
  let accumulated = 0
  for (const bucket of [...buckets, 'inf']) {
    accumulated += latency[bucket] ?? 0
    if (accumulated >= totalLatency * 0.99) {
      p99 = bucket === 'inf' ? null : Number(bucket)
      break
    }
  }
}
return {
  days,
  total_calls: totalCalls,
  total_fails: totalFails,
  fail_rate: totalCalls ? roundFour(totalFails / totalCalls) : 0,
  p99_ms: p99,
  latency_buckets: Object.fromEntries([...buckets, 'inf'].map((bucket) => [bucket, latency[bucket] ?? 0])),
  tools: rows,
  security,
  filesystem_authorization: filesystem,
  email_delivery: emailSummary,
}
 }
}
