import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import type {createLlmStrategySetter,LlmStrategyInput,LlmStrategyMutator} from '@gugu/core/agent/config/llm-strategy'
import {mutateConfigOverride} from '../../adapters/config-override-file.js'
import {createPosixConfigFileLock} from '../../adapters/posix-config-lock.js'

export function createLlmStrategyFileMutator(path:string):LlmStrategyMutator{
 return work=>mutateConfigOverride(path,work,createPosixConfigFileLock())
}
export interface LlmStrategyRouteOptions {requireAdmin:preHandlerHookHandler;set:ReturnType<typeof createLlmStrategySetter>}
function parse(value:unknown):LlmStrategyInput|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const input=value as Record<string,unknown>
 for(const field of ['strategy','pool_mode'])if(input[field]!=null&&typeof input[field]!=='string')return null
 return {strategy:input.strategy as string|null|undefined,pool_mode:input.pool_mode as string|null|undefined}
}
export function registerLlmStrategyRoute(app:FastifyInstance,options:LlmStrategyRouteOptions):void{
 app.post('/api/v1/admin/agent/llm-presets/strategy',{preHandler:options.requireAdmin},async(request,reply)=>{
  const input=parse(request.body)
  if(!input)return reply.code(422).send({detail:'模型分流参数无效'})
  try{return await options.set(input)}catch(error){
   if(error instanceof Error&&error.name==='LlmStrategyError')return reply.code(400).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 })
}
