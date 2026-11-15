import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {createUserBotUpdater,UserBotPatch} from '@gugu/core/im/user-bot-update'
import {pythonQueryBoolean} from '../../http/python-query.js'
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
