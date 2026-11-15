import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {readConfigOverride} from '../../adapters/config-override-file.js'

const objectSchema=z.record(z.string(),z.unknown())
const enabledSchema=z.union([z.boolean(),z.literal(0).transform(()=>false),z.literal(1).transform(()=>true),z.stringbool()])

/** 只读取MCP开关；override高于嵌套环境和环境JSON，每次读取反映后台热更新。 */
export function createMcpEnabledReader(overridePath:string,env:NodeJS.ProcessEnv):()=>unknown{
 return ()=>{
  const environment=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  const base=environment.MCP===undefined?{}:objectSchema.parse(JSON.parse(environment.MCP))
  const fromEnv=environment.MCP__ENABLED!==undefined?environment.MCP__ENABLED:Object.hasOwn(base,'enabled')?base.enabled:true
  const enabled=enabledSchema.parse(fromEnv)
  const override=readConfigOverride(overridePath)
  if(override.mcp===undefined||override.mcp===null)return enabled
  const mcp=objectSchema.parse(override.mcp)
  // Python model_construct保留override值；不将字符串等强制改成另一种开关语义。
  return Object.hasOwn(mcp,'enabled')?mcp.enabled:enabled
 }
}
export interface McpStatusOptions{
 requireUser:preHandlerHookHandler
 read():Promise<{enabled:unknown}>
}
export function registerMcpStatusRoute(app:FastifyInstance,options:McpStatusOptions):void{
 app.get('/api/v1/mcp/status',{preHandler:options.requireUser},()=>options.read())
}
