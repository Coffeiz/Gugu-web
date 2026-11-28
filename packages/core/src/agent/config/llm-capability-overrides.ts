import {ensureLlmPresets,LlmStrategyConfigurationError,type LlmStrategyMutator} from './llm-strategy.js'
import {llmAiSegment} from './llm-preset-selection.js'

export class LlmCapabilityOverrideError extends Error {
 override name='LlmCapabilityOverrideError'
 constructor(readonly code:'invalid_overrides'|'not_found',message:string){super(message)}
}
const allowed=new Set(['thinking','structured_json','structured_schema','tools','parallel_tools','image','audio','video'])
/** 人工覆盖是完整替换；旧自动检测指纹失效，不进行网络探测或扩大允许字段。 */
export function createLlmCapabilityOverrideSetter(mutate:LlmStrategyMutator,invalidate:()=>Promise<number>){
 return async(id:string,body:unknown)=>{
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.entries(body).some(([key,value])=>!allowed.has(key)||typeof value!=='boolean'))throw new LlmCapabilityOverrideError('invalid_overrides','能力覆盖字段或值无效')
  const overrides={...body} as Record<string,boolean>
  try{await mutate(document=>{
   const presets=ensureLlmPresets(document)
   if(!Array.isArray(presets.items))throw new LlmStrategyConfigurationError()
   const item=presets.items.find(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'id'))throw new LlmStrategyConfigurationError()
    return (value as Record<string,unknown>).id===id
   }) as Record<string,unknown>|undefined
   if(!item)throw new LlmCapabilityOverrideError('not_found','预设不存在')
   item.capability_overrides={...overrides};item.capability_checked_at='';item.capability_fingerprint=''
   if(presets.active_id===id)document.ai=llmAiSegment(item)
  })}catch(error){if(error instanceof LlmCapabilityOverrideError)throw error;throw new LlmStrategyConfigurationError()}
  await invalidate()
  return {capability_overrides:overrides}
 }
}
