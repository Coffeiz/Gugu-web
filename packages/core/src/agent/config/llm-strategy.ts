import {sql,type Kysely} from 'kysely'

type Document=Record<string,unknown>
export type LlmStrategyMutator=<T>(work:(document:Document)=>T)=>Promise<T>
export interface LlmStrategyInput {strategy?:string|null;pool_mode?:string|null}
export class LlmStrategyError extends Error {override name='LlmStrategyError'}
export class LlmStrategyConfigurationError extends Error {override name='LlmStrategyConfigurationError';constructor(message='暂时无法保存模型分流配置'){super(message)}}
const record=(value:unknown):value is Document=>!!value&&typeof value==='object'&&!Array.isArray(value)
export function ensureLlmPresets(document:Document):Document{
 if(Object.hasOwn(document,'ai_presets')){
  if(!record(document.ai_presets))throw new LlmStrategyConfigurationError()
  return document.ai_presets
 }
 const ai=document.ai===undefined?{}:document.ai
 if(!record(ai))throw new LlmStrategyConfigurationError()
 const provider=Object.hasOwn(ai,'provider')?ai.provider:'openai'
 const get=(field:string,fallback:unknown)=>Object.hasOwn(ai,field)?ai[field]:fallback
 const item={id:'default',name:provider===null?'None':provider===true?'True':provider===false?'False':String(provider),provider,
  api_key:get('api_key',''),base_url:get('base_url',''),model:get('model',''),thinking:get('thinking','disabled'),reasoning_persistence:get('reasoning_persistence','off'),ollama_mode:get('ollama_mode','local')}
 const value={active_id:'default',items:[item]};document.ai_presets=value;return value
}
/** 全局配置变化只清 active continuation；不解密、不删除会话或 canonical history。 */
export async function invalidateAllProviderReasoningStates<DB>(db:Kysely<DB>):Promise<number>{
 const result=await sql<{id:number}>`UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE status='active' RETURNING id`.execute(db)
 return result.rows.length
}
/** 保留 Python 配置先提交、状态后失效的跨资源顺序；后者失败不能把前者伪装回滚。 */
export function createLlmStrategySetter(mutate:LlmStrategyMutator,invalidate:()=>Promise<number>){
 return async(input:LlmStrategyInput)=>{
  if(input.strategy!=null&&!['active','pool','router'].includes(input.strategy))throw new LlmStrategyError('strategy 只能是 active / pool / router')
  if(input.pool_mode!=null&&!['random','round_robin','least_loaded'].includes(input.pool_mode))throw new LlmStrategyError('pool_mode 只能是 random / round_robin / least_loaded')
  let result:{strategy:unknown;pool_mode:unknown}
  try{result=await mutate(document=>{
   const current=ensureLlmPresets(document)
   if(input.strategy!=null)current.strategy=input.strategy
   if(input.pool_mode!=null)current.pool_mode=input.pool_mode
   return {strategy:Object.hasOwn(current,'strategy')?current.strategy:'active',pool_mode:Object.hasOwn(current,'pool_mode')?current.pool_mode:'random'}
  })}catch(error){if(error instanceof LlmStrategyError)throw error;throw new LlmStrategyConfigurationError()}
  await invalidate()
  return result
 }
}
