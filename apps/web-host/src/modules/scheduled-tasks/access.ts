import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { readConfigOverride } from '../../adapters/config/config-override-file.js'
import { parsePythonInteger } from '../../http/request.js'

const object=z.record(z.string(),z.unknown())

const bool=z.union([z.boolean(),z.literal(0).transform(()=>false),z.literal(1).transform(()=>true),z.stringbool()])

function truthy(value:unknown){return Array.isArray(value)?value.length>0:value&&typeof value==='object'?Object.keys(value).length>0:Boolean(value)}

/** 授权入口只取可信本地存储及灰度开关，每次读取反映后台热更新。 */
export function createTaskAuthorizationEnabledReader(path:string,env:NodeJS.ProcessEnv):()=>boolean{
 return()=>{
  const values=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  const storage=values.STORAGE===undefined?{}:object.parse(JSON.parse(values.STORAGE))
  const sandbox=values.SANDBOX===undefined?{}:object.parse(JSON.parse(values.SANDBOX))
  let backend:unknown=values.STORAGE__BACKEND!==undefined?values.STORAGE__BACKEND:Object.hasOwn(storage,'backend')?storage.backend:'local'
  z.string().parse(backend)
  let enabled:unknown=bool.parse(values.SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED!==undefined?values.SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED:Object.hasOwn(sandbox,'full_user_sandbox_authorization_enabled')?sandbox.full_user_sandbox_authorization_enabled:true)
  const override=readConfigOverride(path)
  if(override.storage!==undefined){const value=object.parse(override.storage);if(Object.hasOwn(value,'backend'))backend=value.backend}
  if(override.sandbox!==undefined&&override.sandbox!==null){const value=object.parse(override.sandbox);if(Object.hasOwn(value,'full_user_sandbox_authorization_enabled'))enabled=value.full_user_sandbox_authorization_enabled}
  return backend==='local'&&truthy(enabled)
 }
}

export interface TaskFilesystemAuthorizationOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 request(ownerId:string,taskId:number):Promise<unknown>
 confirm(ownerId:string,taskId:number,code:string):Promise<unknown>
}

const confirmBody=z.object({confirm_code:z.string().min(1).max(128)})

export function registerTaskFilesystemAuthorizationRoutes(app:FastifyInstance,options:TaskFilesystemAuthorizationOptions):void{
 app.post<{Params:{task_id:string}}>('/api/v1/scheduled-tasks/:task_id/filesystem-authorization/request',{preHandler:options.requireUser},(request,reply)=>{
  const id=parsePythonInteger(request.params.task_id)
  if(id==null)return reply.code(422).send({detail:'任务标识无效'})
  return options.request(options.ownerIdFromRequest(request),id)
 })
 app.post<{Params:{task_id:string}}>('/api/v1/scheduled-tasks/:task_id/filesystem-authorization',{preHandler:options.requireUser},(request,reply)=>{
  const id=parsePythonInteger(request.params.task_id),parsed=confirmBody.safeParse(request.body)
  if(id==null||!parsed.success)return reply.code(422).send({detail:'任务授权参数无效'})
  return options.confirm(options.ownerIdFromRequest(request),id,parsed.data.confirm_code)
 })
}

export interface TaskFilesystemRevokeOptions{
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 revoke(ownerId:string,taskId:number):Promise<{status:string;task_id:number;revoked:boolean}>
}

export function registerTaskFilesystemRevokeRoute(app:FastifyInstance,options:TaskFilesystemRevokeOptions):void{
 app.delete<{Params:{task_id:number}}>('/api/v1/scheduled-tasks/:task_id/filesystem-authorization',{
  preHandler:options.requireUser,schema:{params:{type:'object',required:['task_id'],properties:{task_id:{type:'integer'}}}},
 },request=>options.revoke(options.ownerIdFromRequest(request),request.params.task_id))
}
