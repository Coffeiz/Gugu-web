import type { createPostgresUserBotsReader } from './bots.js'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { createQqBotCreator, QqBotInput } from '@gugu/core/im/user-bot-create'
import { pythonQueryBoolean } from '../../http/python-query.js'
import type { createUserBotUpdater, UserBotPatch } from '@gugu/core/im/user-bot-update'
import type { createUserBotDeleter } from '@gugu/core/im/user-bot-delete'
import type { Pool } from 'pg'

function body(value:unknown):QqBotInput|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const input=value as Record<string,unknown>,result:QqBotInput={name:'',app_id:'',app_secret:'',sandbox:false,enabled:true}
 for(const field of ['name','app_id','app_secret'] as const){if(input[field]!==undefined){if(typeof input[field]!=='string')return null;result[field]=input[field]}}
 try{
  for(const field of ['sandbox','enabled'] as const)if(input[field]!==undefined){const raw=input[field];result[field]=raw===0||raw===1?Boolean(raw):pythonQueryBoolean(raw)}
 }catch{return null}
 return result
}

export interface UserBotCreateOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;create:ReturnType<typeof createQqBotCreator>}

export function registerUserBotCreateRoute(app:FastifyInstance,options:UserBotCreateOptions):void{
 app.post('/api/v1/me/bots',{preHandler:options.requireUser},async(request,reply)=>{
  const input=body(request.body)
  if(!input)return reply.code(422).send({detail:'机器人参数无效'})
  try{return await options.create(options.ownerIdFromRequest(request),input)}catch(error){
   if(error instanceof Error&&error.name==='QqBotCreationError'){
    const code=(error as Error&{code?:unknown}).code,status=code==='platform_disabled'?503:code==='invalid_credentials'?400:code==='already_exists'?409:null
    if(status)return reply.code(status).send({detail:error.message})
   }
   throw error
  }
 })
}

function parse(value:unknown):UserBotPatch|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const body=value as Record<string,unknown>,result:UserBotPatch={}
 for(const key of ['name','app_id','app_secret','group_response_mode','group_attention_mode','group_message_format','private_message_format'] as const)if(body[key]!==undefined){if(body[key]!==null&&typeof body[key]!=='string')return null;result[key]=body[key] as string|null}
 for(const key of ['sandbox','enabled','group_chat_enabled','feishu_group_chat_enabled','group_requires_at','group_read_enabled','group_memory_enabled','group_owner_memory_enabled','member_memory_enabled','private_streaming_enabled'] as const)if(body[key]!==undefined){const raw=body[key];if(raw===null){result[key]=null;continue}if(Array.isArray(raw))return null;try{result[key]=raw===0||raw===1?Boolean(raw):pythonQueryBoolean(raw)}catch{return null}}
 if(body.group_allowed_tools!==undefined){const raw=body.group_allowed_tools;if(raw!==null&&(!Array.isArray(raw)||raw.some(tool=>typeof tool!=='string')))return null;result.group_allowed_tools=raw as string[]|null}
 return result
}

export function registerUserBotUpdateRoute(app:FastifyInstance,options:{requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;update:ReturnType<typeof createUserBotUpdater>}):void {
 app.put<{Params:{bot_id:string}}>('/api/v1/me/bots/:bot_id',{preHandler:options.requireUser},async(request,reply)=>{
  const text=request.params.bot_id.trim(),id=/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(text)?Number(text.replaceAll('_','')):NaN,input=parse(request.body)
  if(!Number.isSafeInteger(id)||!input)return reply.code(422).send({detail:'机器人参数无效'})
  try{return await options.update(options.ownerIdFromRequest(request),id,input)}catch(error){if(error instanceof Error&&error.name==='UserBotUpdateError')return reply.code(400).send({detail:error.message});throw error}
 })
}

export function registerUserBotDeleteRoute(app:FastifyInstance,options:{requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;remove:ReturnType<typeof createUserBotDeleter>}):void {
 app.delete<{Params:{bot_id:string}}>('/api/v1/me/bots/:bot_id',{preHandler:options.requireUser},async(request,reply)=>{
  const text=request.params.bot_id.trim(),id=/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(text)?Number(text.replaceAll('_','')):NaN
  if(!Number.isSafeInteger(id))return reply.code(422).send({detail:'机器人标识必须是整数'})
  await options.remove(options.ownerIdFromRequest(request),id)
  return reply.code(204).send()
 })
}

type FeishuBot = { id: number; app_id: string; app_secret: string; owner_platform_user_id: string | null }

export async function readEnabledFeishuBot(pool: Pick<Pool, 'query'>, ownerId: string, botId?: number): Promise<FeishuBot | undefined> {
  return (await pool.query<FeishuBot>(`SELECT id,app_id,app_secret,owner_platform_user_id FROM user_bots
    WHERE user_id=$1 AND platform='feishu' AND enabled=TRUE
    ${botId === undefined ? 'ORDER BY id LIMIT 1' : 'AND id=$2'}`,
  botId === undefined ? [ownerId] : [ownerId, botId])).rows[0]
}

export interface UserBotsListOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;readBots:ReturnType<typeof createPostgresUserBotsReader>}
export function registerUserBotsListRoute(app:FastifyInstance,options:UserBotsListOptions):void {
 app.get('/api/v1/me/bots',{preHandler:options.requireUser},request=>options.readBots(options.ownerIdFromRequest(request)))
}
