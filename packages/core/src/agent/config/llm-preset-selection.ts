import {ensureLlmPresets,LlmStrategyConfigurationError,type LlmStrategyMutator} from './llm-strategy.js'
type Document=Record<string,unknown>
export class LlmPresetSelectionError extends Error {
 override name='LlmPresetSelectionError'
 constructor(readonly code:'not_found'|'last_preset'|'active_preset',message:string){super(message)}
}
const keys=['provider','api_key','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','image','video','image_detail','audio','web_search_enabled','api_format','ollama_mode','ollama_api_mode','ollama_keep_alive','deployment_mode','local_runtime','capability_overrides','capability_checked_at','capability_fingerprint'] as const
const defaults:Document={max_tokens:25600,context_tokens:128000,thinking:'',reasoning_effort:'',reasoning_persistence:'off',image:false,image_detail:'auto',video:false,audio:false,web_search_enabled:false,api_format:'',ollama_mode:'local',ollama_api_mode:'native',ollama_keep_alive:'5m',deployment_mode:'cloud',local_runtime:'other',capability_overrides:{},capability_checked_at:'',capability_fingerprint:''}
export function llmAiSegment(item:Document):Document{
 return Object.fromEntries(keys.map(key=>[key,Object.hasOwn(item,key)?item[key]:Object.hasOwn(defaults,key)?structuredClone(defaults[key]):null]))
}
function itemId(value:unknown):unknown{
 if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'id'))throw new LlmStrategyConfigurationError()
 return (value as Document).id
}
/** 激活与移除配置本身不探测Provider；后续消费者读取完整ai段，旧状态必须失效。 */
export function createLlmPresetSelection(mutate:LlmStrategyMutator,invalidate:()=>Promise<number>){
 const commit=async<T>(work:(document:Document,presets:Document)=>T):Promise<T>=>{
  let result:T
  try{result=await mutate(document=>work(document,ensureLlmPresets(document)))}catch(error){if(error instanceof LlmPresetSelectionError)throw error;throw new LlmStrategyConfigurationError()}
  await invalidate();return result
 }
 return {
  activate(id:string){return commit((document,presets)=>{
   if(!Array.isArray(presets.items))throw new LlmStrategyConfigurationError()
   const item=presets.items.find(value=>itemId(value)===id) as Document|undefined
   if(!item)throw new LlmPresetSelectionError('not_found','预设不存在')
   presets.active_id=id
   document.ai=llmAiSegment(item)
   return {active_id:id}
  })},
  delete(id:string){return commit((_document,presets)=>{
   const items=Object.hasOwn(presets,'items')?presets.items:[]
   if(!Array.isArray(items))throw new LlmStrategyConfigurationError()
   if(items.length<=1)throw new LlmPresetSelectionError('last_preset','至少保留一个预设')
   if(presets.active_id===id)throw new LlmPresetSelectionError('active_preset','无法删除当前激活的预设，请先切换到其他预设')
   presets.items=items.filter(value=>itemId(value)!==id)
   return {deleted:id}
  })},
 }
}
