import {dataContext} from '../contracts/index.js'
import {integer} from '../data/codec.js'
import {strip} from '../shared/values.js'
export interface CredentialInput {provider:string;capability:'llm'|'deep_research'|'similar_image_search'|'speech_to_text'|'embedding';value:string;api_format?:string;base_url?:string;model?:string;dimensions?:number|null;max_tokens?:number|null;context_tokens?:number|null;thinking?:string|null;reasoning_effort?:string|null;reasoning_persistence?:string;web_search_enabled?:boolean|null;image?:boolean;video?:boolean;audio?:boolean;image_detail?:string}
export interface EncryptedCredential {ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}
export type CreatedCredential = Record<string, unknown> & {id: number | string; has_value: boolean}
type Query=(text:string,values:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>
export interface CreateCredentialOptions {transaction:<T>(work:(query:Query)=>Promise<T>)=>Promise<T>;encrypt:(value:string,allowEmpty:boolean)=>Promise<EncryptedCredential>;enabled:()=>boolean}
function supported(provider:string,format:string){const p=strip(provider).toLowerCase(),f=strip(format||'openai').toLowerCase();return ['minimax','glm','deepseek','mimo','ollama'].includes(p)||p==='qwen'&&['openai','responses'].includes(f)}
/** owner锁覆盖禁用旧凭据、插入新凭据及推理状态失效。 */
export function createCredentialCreator(options:CreateCredentialOptions){
 return async(ownerId:string,input:CredentialInput):Promise<CreatedCredential>=>{
  if(!options.enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId,webSupported=input.capability==='llm'&&supported(input.provider,input.api_format??''),web=input.web_search_enabled??webSupported
  if(web&&!webSupported)throw Object.assign(new Error('当前 Provider 或 API 格式不支持联网搜索'),{statusCode:422})
  const allowEmpty=input.capability==='embedding'&&(input.provider==='local'||input.provider==='ollama'&&!(input.base_url??'').includes('ollama.com'))
  if(!input.value&&!allowEmpty)throw Object.assign(new Error('该 Provider 需要 API Key，不能为空'),{statusCode:422})
  let encrypted:EncryptedCredential
  try{encrypted=await options.encrypt(input.value,allowEmpty)}catch{throw Object.assign(new Error('BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY'),{statusCode:503})}
  return options.transaction(async query=>{
   await query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner])
   await query('UPDATE user_provider_credentials SET enabled=false WHERE user_id=$1 AND capability=$2 AND enabled IS TRUE',[owner,input.capability])
   const fields=['user_id','provider','api_format','capability','encrypted_value','nonce','encrypted_data_key','key_version','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','web_search_enabled','image','video','audio','image_detail','dimensions','enabled','created_at','updated_at']
   const values=[owner,input.provider,input.api_format??'',input.capability,encrypted.ciphertext,encrypted.nonce,encrypted.encryptedDataKey,encrypted.keyVersion,input.base_url??'',input.model??'',input.max_tokens??null,input.context_tokens??null,input.thinking??null,input.reasoning_effort??null,input.reasoning_persistence??'off',web,input.image??false,input.video??false,input.audio??false,input.image_detail??'auto',input.dimensions??null,true,new Date(),new Date()]
   const row=(await query(`INSERT INTO user_provider_credentials(${fields.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id,provider,api_format,capability,base_url,model,max_tokens,context_tokens,thinking,reasoning_effort,reasoning_persistence,web_search_enabled,image,video,audio,image_detail,dimensions,enabled,last_verified_at,created_at,updated_at`,values)).rows[0]!
   if(input.capability==='llm')await query("UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND status='active'",[owner])
   return {...row,id:integer(row.id),has_value:Boolean(encrypted.ciphertext)}
  })
 }
}
