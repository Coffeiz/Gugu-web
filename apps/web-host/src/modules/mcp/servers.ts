import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {CoreError} from '@gugu/core'
import {z} from 'zod'
import {normalizeMcpServerName,validateMcpCommon,validateMcpEndpoint,normalizeMcpSlots,validateMcpCredentialValues} from '@gugu/core/mcp/server-config'
import {isPublicAddress} from '@gugu/core/providers/node'
import type {McpServerCreateInput} from '@gugu/core/mcp/server-create'

const createBody=z.object({name:z.string().min(1).max(64),transport:z.enum(['http','stdio']).default('http'),endpoint:z.string().max(1000).default(''),command:z.string().max(1000).default(''),credential_slots:z.array(z.record(z.string(),z.unknown())).max(16).default([]),credential_values:z.record(z.string(),z.string()).default({}),enabled:z.boolean().default(true),confirm_mode:z.string().default('confirm_all'),timeout_seconds:z.number().int().default(30),tool_allowlist:z.array(z.string()).default([])})
const patchBody=z.object({name:z.string().min(1).max(64).nullable().optional(),transport:z.enum(['http','stdio']).nullable().optional(),endpoint:z.string().max(1000).nullable().optional(),command:z.string().max(1000).nullable().optional(),credential_slots:z.array(z.record(z.string(),z.unknown())).max(16).nullable().optional(),credential_values:z.record(z.string(),z.string()).nullable().optional(),enabled:z.boolean().nullable().optional(),confirm_mode:z.string().nullable().optional(),timeout_seconds:z.number().int().nullable().optional(),tool_allowlist:z.array(z.string()).nullable().optional()})
export interface McpServerConfigOperations {
 list(owner:string):Promise<unknown>
 create(owner:string,input:Record<string,unknown>):Promise<unknown>
 update(owner:string,id:string,input:Record<string,unknown>):Promise<unknown>
 remove(owner:string,id:string):Promise<unknown>
}
export interface McpServerRoutesOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 operations:McpServerConfigOperations
 invalidate?(owner:string,id:string):void|Promise<void>
 refreshSnapshot?(owner:string):void|Promise<void>
}
export interface McpServerCreateRouteOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 create(owner:string,input:McpServerCreateInput):Promise<unknown>
}
function validateInput(input:Record<string,any>,partial:boolean):Record<string,unknown>{
 const value={...input}
 if(!partial||value.name!==undefined&&value.name!==null)value.name=normalizeMcpServerName(String(value.name))
 if(!partial||value.credential_slots!==undefined&&value.credential_slots!==null)value.credential_slots=normalizeMcpSlots(value.credential_slots??[])
 const slots=(value.credential_slots??[]) as ReturnType<typeof normalizeMcpSlots>
 if(value.credential_values!==undefined&&value.credential_values!==null)value.credential_values=validateMcpCredentialValues(slots,value.credential_values)
 if(value.transport==='http'&&value.endpoint!==undefined&&value.endpoint!==null)value.endpoint=validateMcpEndpoint(String(value.endpoint),isPublicAddress)
 if(value.transport==='stdio'&&value.command!==undefined&&value.command!==null){const command=String(value.command).trim();if(!command)throw new Error('stdio MCP server 必须填写启动命令');if(command.includes('\0'))throw new Error('stdio 启动命令无效');value.command=command}
 if(['confirm_mode','timeout_seconds','tool_allowlist'].some(key=>value[key]!==undefined&&value[key]!==null)){
  const common={confirm_mode:value.confirm_mode??'confirm_all',timeout_seconds:value.timeout_seconds??30,tool_allowlist:value.tool_allowlist??[]}
  validateMcpCommon(common,64)
 }
 return value
}
function sendError(reply:any,error:unknown){
 if(error instanceof CoreError){const status=error.code==='not_found'?404:error.code==='invalid_request'?400:error.code==='conflict'?409:500;return reply.code(status).send({detail:error.message})}
 const code=Number((error as {statusCode?:unknown})?.statusCode)
 if(Number.isInteger(code)&&code>=400&&code<600)return reply.code(code).send({detail:(error as Error).message})
 throw error
}
export function registerMcpServerRoutes(app:FastifyInstance,options:McpServerRoutesOptions):void{
 app.get('/api/v1/mcp/servers',{preHandler:options.requireUser},async(request,reply)=>{try{return await options.operations.list(options.ownerIdFromRequest(request))}catch(error){return sendError(reply,error)}})
 app.post('/api/v1/mcp/servers',{preHandler:options.requireUser},async(request,reply)=>{
  const parsed=createBody.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'MCP server 参数无效'})
  let input:Record<string,unknown>
  try{input=validateInput(parsed.data,false)}catch(error){return reply.code(400).send({detail:(error as Error).message})}
  try{const owner=options.ownerIdFromRequest(request),result=await options.operations.create(owner,input);await options.refreshSnapshot?.(owner);return reply.code(201).send(result)}catch(error){return sendError(reply,error)}
 })
 app.patch<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id',{preHandler:options.requireUser},async(request,reply)=>{
  const parsed=patchBody.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'MCP server 参数无效'})
  let input:Record<string,unknown>
  try{input=validateInput(parsed.data,true)}catch(error){return reply.code(400).send({detail:(error as Error).message})}
  try{const owner=options.ownerIdFromRequest(request),result=await options.operations.update(owner,request.params.server_id,input);await options.invalidate?.(owner,request.params.server_id);await options.refreshSnapshot?.(owner);return result}catch(error){return sendError(reply,error)}
 })
 app.delete<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id',{preHandler:options.requireUser},async(request,reply)=>{
  try{const owner=options.ownerIdFromRequest(request),result=await options.operations.remove(owner,request.params.server_id);await options.invalidate?.(owner,request.params.server_id);await options.refreshSnapshot?.(owner);return result}catch(error){return sendError(reply,error)}
 })
}

/** 配置创建写入共享表并清除 Python Manager 使用的持久工具声明快照。 */
export function registerMcpServerCreateRoute(app:FastifyInstance,options:McpServerCreateRouteOptions):void{
 app.post('/api/v1/mcp/servers',{preHandler:options.requireUser},async(request,reply)=>{
  const parsed=createBody.safeParse(request.body)
  if(!parsed.success)return reply.code(422).send({detail:'MCP server 参数无效'})
  let input:Record<string,unknown>
  try{input=validateInput(parsed.data,false)}catch(error){return reply.code(400).send({detail:(error as Error).message})}
  try{return reply.code(201).send(await options.create(options.ownerIdFromRequest(request),input as unknown as McpServerCreateInput))}
  catch(error){return sendError(reply,error)}
 })
}
