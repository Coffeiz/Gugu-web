import {capabilitySnapshot} from '../agent/providers/registry.js'

export interface ProviderCapabilityPreviewInput{
 provider:string
 api_format?:string
 base_url?:string
 model?:string
 ollama_api_mode?:string
 ollama_mode?:string
 local_runtime?:string
}
/** 只读取已有Provider声明，不访问凭据、网络或运行时模型。 */
export function createProviderCapabilityPreview(enabled:()=>boolean){
 return(input:ProviderCapabilityPreviewInput)=>{
  if(!enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  return capabilitySnapshot({provider:input.provider,api_format:input.api_format??'',base_url:input.base_url??'',model:input.model??'',ollama_api_mode:input.ollama_api_mode??'openai',ollama_mode:input.ollama_mode??'local',local_runtime:input.local_runtime??'other'})
 }
}
