import type {FastifyInstance,preHandlerHookHandler,FastifyReply} from 'fastify'
import type {createLlmPresetMutations} from '@gugu/core/agent/config/llm-preset-mutations'
import {pythonQueryBoolean} from '../../http/python-query.js'

export interface LlmPresetMutationOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createLlmPresetMutations>}
const strings=['name','provider','api_key','base_url','model','thinking','reasoning_effort','reasoning_persistence','image_detail','api_format','ollama_mode','ollama_api_mode','ollama_keep_alive','deployment_mode','local_runtime']
const booleans=['image','video','audio','web_search_enabled','in_pool']
function boolean(value:unknown):boolean{
 if(value===null||Array.isArray(value))throw new Error('布尔参数无效')
 return value===0||value===1?Boolean(value):pythonQueryBoolean(value)
}
function integer(value:unknown):number{
 if(typeof value==='boolean')return Number(value)
 if(typeof value==='number'&&Number.isInteger(value))return value
 if(typeof value==='string'&&/^\s*[+-]?\d(?:_?\d)*(?:\.0+)?\s*$/.test(value))return Number(value.replaceAll('_',''))
 throw new Error('整数参数无效')
}
function parse(value:unknown,create:boolean):Record<string,unknown>|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const input=value as Record<string,unknown>,result:Record<string,unknown>={}
 if(create&&(typeof input.name!=='string'||typeof input.provider!=='string'))return null
 try{
  for(const key of strings){if(input[key]===undefined)continue;if(input[key]===null&&!create){result[key]=null;continue}if(typeof input[key]!=='string')return null;result[key]=input[key]}
  for(const key of booleans){if(input[key]===undefined||(create&&key==='in_pool'))continue;if(input[key]===null&&(!create||key==='web_search_enabled')){result[key]=null;continue}result[key]=boolean(input[key])}
  for(const [key,min] of [['max_tokens',0],['context_tokens',1]] as const){if(input[key]===undefined)continue;if(input[key]===null&&!create){result[key]=null;continue}const count=integer(input[key]);if(count<=min||!Number.isFinite(count))return null;result[key]=count}
  if(result.reasoning_persistence!=null&&!['off','continuation'].includes(result.reasoning_persistence as string))return null
  if(create)for(const key of ['capability_checked_at','capability_fingerprint'])if(input[key]!==undefined){if(typeof input[key]!=='string')return null;result[key]=input[key]}
  if(input.capability_overrides!==undefined){
   const overrides=input.capability_overrides
   if(overrides===null&&!create)result.capability_overrides=null
   else{if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))return null;result.capability_overrides=Object.fromEntries(Object.entries(overrides).map(([key,item])=>[key,boolean(item)]))}
  }
 }catch{return null}
 return result
}
export function registerLlmPresetMutationRoutes(app:FastifyInstance,options:LlmPresetMutationOptions):void{
 const execute=async(input:Record<string,unknown>|null,reply:FastifyReply,work:(input:Record<string,unknown>)=>Promise<unknown>)=>{
  if(!input)return reply.code(422).send({detail:'模型预设参数无效'})
  try{return await work(input)}catch(error){
   if(error instanceof Error&&error.name==='LlmPresetMutationError')return reply.code((error as Error&{status:404|422}).status).send({detail:error.message})
   if(error instanceof Error&&error.name==='LlmStrategyConfigurationError')return reply.code(503).send({detail:error.message})
   throw error
  }
 }
 app.post('/api/v1/admin/agent/llm-presets',{preHandler:options.requireAdmin},(request,reply)=>execute(parse(request.body,true),reply,input=>options.operations.create(input)))
 app.put<{Params:{preset_id:string}}>('/api/v1/admin/agent/llm-presets/:preset_id',{preHandler:options.requireAdmin},(request,reply)=>execute(parse(request.body,false),reply,input=>options.operations.update(request.params.preset_id,input)))
}
