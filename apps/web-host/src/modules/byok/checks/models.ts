import { readOwnedCredential, type OwnedCredential } from '../store.js'
import { createHash } from 'node:crypto'
import { listProviderModels } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { stableJson } from '@gugu/core/agent'
import type { Kysely } from 'kysely'
import { dataContext } from '@gugu/core/contracts'
import { canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'

/** 查询真实 Provider 模型目录，沿用 Provider 的 DNS 固定、地址校验及禁止重定向传输。 */
export function createByokModelsPreviewFetcher(environment:NodeJS.ProcessEnv){
 return async(input:{provider:string;apiFormat:string;baseUrl:string;apiKey:string;model:string}):Promise<readonly string[]>=>{
  let provider=input.provider,apiFormat=input.apiFormat,baseUrl=input.baseUrl
  if(provider==='qwen'&&apiFormat==='dashscope'){
   if(baseUrl==='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')baseUrl='https://dashscope.aliyuncs.com/compatible-mode/v1'
   apiFormat='openai'
  }
  const transport=createNodeProviderTransport({allowLocal:['local','ollama'].includes(provider.trim().toLowerCase()),connectTimeoutMs:8000,environment:()=>environment})
  try{
   const rows=await listProviderModels({provider,api_format:apiFormat,base_url:baseUrl,api_key:input.apiKey,model:input.model||'model-list',timeout_ms:8000},{transport,digest:value=>createHash('sha256').update(stableJson(value)).digest('hex')},AbortSignal.timeout(8000))
   return [...new Set(rows.flatMap(row=>row&&typeof row==='object'&&!Array.isArray(row)&&typeof (row as Record<string,unknown>).id==='string'&&(row as Record<string,unknown>).id?[(row as Record<string,unknown>).id as string]:[]))].sort()
  }finally{await transport.close()}
 }
}

export interface CredentialModelsPreviewInput {
 provider:string;api_format:string;base_url:string;model:string;api_key:string;credential_id?:number|null
}

export interface CredentialModelsPreviewOptions {
 enabled:()=>boolean
 decrypt:(row:Pick<OwnedCredential,'encrypted_value'|'nonce'|'encrypted_data_key'|'key_version'>)=>Promise<string>
 fetchModels:(input:{provider:string;apiFormat:string;baseUrl:string;apiKey:string;model:string})=>Promise<readonly string[]>
}

/** Resolve a saved key only for its owner and its recorded network origin. */
export function createCredentialModelsPreview<DB>(db:Kysely<DB>,options:CredentialModelsPreviewOptions){
 return async(ownerId:string,input:CredentialModelsPreviewInput)=>{
  if(!options.enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId
  let row:OwnedCredential|undefined
  if(input.credential_id!=null){
   row = await readOwnedCredential(db, owner, input.credential_id)
  }
  let apiKey=input.api_key
  if(!apiKey){
   if(!row)throw Object.assign(new Error('请填写 API Key 后再获取模型列表'),{statusCode:422})
   const target={provider:input.provider,api_format:input.api_format,base_url:input.base_url,model:input.model,capability:row.capability}
   if(!canReuseByokKeyForDestination(row,target))throw Object.assign(new Error(BYOK_DESTINATION_MISMATCH_MESSAGE),{statusCode:422})
   apiKey=await options.decrypt(row)
  }
  if(!apiKey)throw Object.assign(new Error('请先填写 API Key 或保存后再获取模型列表'),{statusCode:422})
  try{return {models:await options.fetchModels({provider:input.provider,apiFormat:input.api_format,baseUrl:input.base_url,apiKey,model:input.model})}}
  catch{throw Object.assign(new Error('无法获取 Provider 模型列表'),{statusCode:502})}
 }
}
