import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {readConfigOverride} from '../../adapters/config/config-override-file.js'

const objectSchema=z.record(z.string(),z.unknown())
const enabledSchema=z.union([z.boolean(),z.literal(0).transform(()=>false),z.literal(1).transform(()=>true),z.stringbool()])

/** 只读取MCP开关；override高于嵌套环境和环境JSON，每次读取反映后台热更新。 */
export interface McpRuntimeSettings {enabled:unknown;max_servers_per_user:number;max_tools_per_server:number;default_timeout_seconds:number;stdio_max_sessions:number;stdio_max_sessions_per_user:number;stdio_idle_seconds:number}
function positiveOrZeroInteger(value:unknown,key:string):number{
 const parsed=typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value):NaN
 if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error(`MCP 配置 ${key} 无效`)
 return parsed
}
function boundedInteger(value:unknown,key:string,min:number,max:number):number{
 const parsed=positiveOrZeroInteger(value,key)
 if(parsed<min||parsed>max)throw new Error(`MCP 配置 ${key} 无效`)
 return parsed
}
/** 按 Python Settings 优先级热读总开关与配置限额。 */
export function createMcpSettingsReader(overridePath:string,env:NodeJS.ProcessEnv):()=>McpRuntimeSettings{
 return ()=>{
  const environment=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  const base=environment.MCP===undefined?{}:objectSchema.parse(JSON.parse(environment.MCP))
  const override=readConfigOverride(overridePath),mcp=override.mcp===undefined||override.mcp===null?{}:objectSchema.parse(override.mcp)
  const resolve=(key:keyof McpRuntimeSettings,envKey:string,fallback:unknown)=>Object.hasOwn(mcp,key)?mcp[key]:environment[envKey]!==undefined?environment[envKey]:Object.hasOwn(base,key)?base[key]:fallback
  const enabled=enabledSchema.parse(resolve('enabled','MCP__ENABLED',true))
  return {enabled,max_servers_per_user:positiveOrZeroInteger(resolve('max_servers_per_user','MCP__MAX_SERVERS_PER_USER',10),'max_servers_per_user'),
   max_tools_per_server:positiveOrZeroInteger(resolve('max_tools_per_server','MCP__MAX_TOOLS_PER_SERVER',64),'max_tools_per_server'),
   default_timeout_seconds:positiveOrZeroInteger(resolve('default_timeout_seconds','MCP__DEFAULT_TIMEOUT_SECONDS',30),'default_timeout_seconds'),
   stdio_max_sessions:positiveOrZeroInteger(resolve('stdio_max_sessions','MCP__STDIO_MAX_SESSIONS',8),'stdio_max_sessions'),
   stdio_max_sessions_per_user:positiveOrZeroInteger(resolve('stdio_max_sessions_per_user','MCP__STDIO_MAX_SESSIONS_PER_USER',4),'stdio_max_sessions_per_user'),
   stdio_idle_seconds:boundedInteger(resolve('stdio_idle_seconds','MCP__STDIO_IDLE_SECONDS',300),'stdio_idle_seconds',30,3600)}
 }
}
export function createMcpEnabledReader(overridePath:string,env:NodeJS.ProcessEnv):()=>unknown{
 const read=createMcpSettingsReader(overridePath,env)
 return ()=>read().enabled
}
export interface McpStatusOptions{
 requireUser:preHandlerHookHandler
 read():Promise<{enabled:unknown}>
}
export function registerMcpStatusRoute(app:FastifyInstance,options:McpStatusOptions):void{
 app.get('/api/v1/mcp/status',{preHandler:options.requireUser},()=>options.read())
}
