import type {FastifyInstance,FastifyReply,preHandlerHookHandler} from 'fastify'
import type {createAdminModelDirectory} from '@gugu/core/agent/config/admin-model-directory'

export interface ModelDirectoryRouteOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createAdminModelDirectory>}
function parse(value:unknown,voice:boolean):Record<string,string>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const input=value as Record<string,unknown>,result:Record<string,string>={provider:'openai',base_url:'',api_key:'',api_format:''}
 for(const key of ['provider','base_url','api_key','api_format','local_runtime',...(voice?['preset_id']:[])]){
  if(input[key]===undefined)continue
  if(typeof input[key]!=='string')return null
  if(key!=='local_runtime')result[key]=input[key]
 }
 return result
}
export function registerModelDirectoryRoutes(app:FastifyInstance,options:ModelDirectoryRouteOptions):void{
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{
  try{return await work()}catch(error){
   if(error instanceof Error&&['AdminModelDirectoryError','LlmModelDirectoryError'].includes(error.name))return reply.code((error as Error&{status:number}).status).send({detail:error.message})
   throw error
  }
 }
 app.get<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id/models',{preHandler:options.requireAdmin},(request,reply)=>execute(()=>options.operations.saved(request.params.preset_id),reply))
 for(const kind of ['llm','voice'] as const)app.post(`/api/v1/admin/agent/${kind}-presets/models-preview`,{preHandler:options.requireAdmin},(request,reply)=>{
  const input=parse(request.body,kind==='voice')
  if(!input)return reply.code(422).send({detail:'模型列表参数无效'})
  return execute(()=>kind==='voice'?options.operations.voice(input):options.operations.preview(input),reply)
 })
}
