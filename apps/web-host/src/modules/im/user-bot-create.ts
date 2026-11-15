import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {createQqBotCreator,QqBotInput} from '@gugu/core/im/user-bot-create'
import {pythonQueryBoolean} from '../../http/python-query.js'

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
