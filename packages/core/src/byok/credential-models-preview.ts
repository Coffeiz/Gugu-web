import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'
import {canReuseByokKeyForDestination,BYOK_DESTINATION_MISMATCH_MESSAGE,type CredentialDestination} from './credential-destination.js'

interface CredentialRow extends CredentialDestination {
 id:number;user_id:string;encrypted_value:string;nonce:string;encrypted_data_key:string;key_version:number
}
export interface CredentialModelsPreviewInput {
 provider:string;api_format:string;base_url:string;model:string;api_key:string;credential_id?:number|null
}
export interface CredentialModelsPreviewOptions {
 enabled:()=>boolean
 decrypt:(row:Pick<CredentialRow,'encrypted_value'|'nonce'|'encrypted_data_key'|'key_version'>)=>Promise<string>
 fetchModels:(input:{provider:string;apiFormat:string;baseUrl:string;apiKey:string;model:string})=>Promise<readonly string[]>
}

/** Resolve a saved key only for its owner and its recorded network origin. */
export function createCredentialModelsPreview<DB>(db:Kysely<DB>,options:CredentialModelsPreviewOptions){
 return async(ownerId:string,input:CredentialModelsPreviewInput)=>{
  if(!options.enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId
  let row:CredentialRow|undefined
  if(input.credential_id!=null){
   const result=await sql<CredentialRow>`SELECT id,user_id,provider,api_format,capability,encrypted_value,nonce,encrypted_data_key,key_version,base_url,model FROM user_provider_credentials WHERE user_id=${owner} AND id=${input.credential_id} LIMIT 1`.execute(db)
   row=result.rows[0]
   if(!row)throw new CoreError('not_found','凭据不存在')
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
