import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createLlmCapabilityOverrideSetter} from '@gugu/core/agent/config/llm-capability-overrides'
import {pythonQueryBoolean} from '../../http/python-query.js'

export interface LlmCapabilityOverrideOptions {requireAdmin:preHandlerHookHandler;set:ReturnType<typeof createLlmCapabilityOverrideSetter>}
function parse(value:unknown):Record<string,boolean>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const result:Record<string,boolean>={}
 try{for(const [key,raw] of Object.entries(value)){
  if(raw===null||Array.isArray(raw))return null
  Object.defineProperty(result,key,{value:raw===0||raw===1?Boolean(raw):pythonQueryBoolean(raw),enumerable:true,writable:true,configurable:true})
 }}catch{return null}
 return result
}
export function registerLlmCapabilityOverrideRoute(app:FastifyInstance,options:LlmCapabilityOverrideOptions):void{
 app.put<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/capability-overrides',{preHandler:options.requireAdmin},async(request,reply)=>{
  const input=parse(request.body)
  if(!input)return reply.code(422).send({detail:'模型能力覆盖参数无效'})
  try{return await options.set(request.params.preset_id,input)}catch(error){
   if(error instanceof Error&&error.name==='LlmCapabilityOverrideError')return reply.code((error as Error&{code?:string}).code==='not_found'?404:400).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 })
}
