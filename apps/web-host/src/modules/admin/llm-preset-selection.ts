import type {FastifyInstance,FastifyReply,preHandlerHookHandler} from 'fastify'
import type {createLlmPresetSelection} from '@gugu/core/agent/config/llm-preset-selection'

export interface LlmPresetSelectionOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createLlmPresetSelection>}
export function registerLlmPresetSelectionRoutes(app:FastifyInstance,options:LlmPresetSelectionOptions):void{
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&error.name==='LlmPresetSelectionError')return reply.code((error as Error&{code?:string}).code==='not_found'?404:400).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 }
 app.post<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/activate',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.activate(request.params.preset_id),reply))
 app.delete<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.delete(request.params.preset_id),reply))
}
