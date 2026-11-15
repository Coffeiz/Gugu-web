import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'
import {canReuseByokKeyForDestination,BYOK_DESTINATION_MISMATCH_MESSAGE} from './credential-destination.js'

export interface CredentialPatchInput {
 provider?:string|null;value?:string|null;api_format?:string|null;base_url?:string|null;model?:string|null
 dimensions?:number|null;max_tokens?:number|null;context_tokens?:number|null;thinking?:string|null;reasoning_effort?:string|null
 reasoning_persistence?:string|null;web_search_enabled?:boolean|null;image?:boolean|null;video?:boolean|null;audio?:boolean|null
 image_detail?:string|null;enabled?:boolean|null
}
type Row=Record<string,any>&{provider:string;api_format:string;capability:string;encrypted_value:string;nonce:string;encrypted_data_key:string;key_version:number;user_id:string;id:number;dimensions:number|null;enabled:boolean;last_verified_at:unknown;created_at:unknown;updated_at:unknown}
export interface CredentialPatchOptions {
 enabled:()=>boolean
 encrypt:(value:string,allowEmpty:boolean)=>Promise<{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}>
 decrypt:(row:Pick<Row,'encrypted_value'|'nonce'|'encrypted_data_key'|'key_version'>)=>Promise<string>
}
function keyless(capability:string,provider:string,url:string){return capability==='embedding'&&(provider==='local'||provider==='ollama'&&!url.includes('ollama.com'))}
function webSearchSupported(provider:string,format:string){const p=provider.trim().toLowerCase(),f=(format||'openai').trim().toLowerCase();return ['minimax','glm','deepseek','mimo','ollama'].includes(p)||p==='qwen'&&['openai','responses'].includes(f)}
const viewFields=['id','provider','api_format','capability','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','web_search_enabled','image','video','audio','image_detail','dimensions','enabled','last_verified_at','created_at','updated_at']

/** 在单个事务中更新 BYOK 配置；复用密钥前必须证明实际目的地一致。 */
export function createCredentialPatch<DB>(db:Kysely<DB>,options:CredentialPatchOptions){
 return async(ownerId:string,credentialId:number,input:CredentialPatchInput)=>{
  if(!options.enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId
  return db.transaction().execute(async tx=>{
   await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
   const selected=await sql<Row>`SELECT * FROM user_provider_credentials WHERE user_id=${owner} AND id=${credentialId} FOR UPDATE`.execute(tx)
   const row=selected.rows[0];if(!row)throw new CoreError('not_found','凭据不存在')
   const provider=input.provider??row.provider,format=input.api_format??row.api_format,url=input.base_url??row.base_url,model=input.model??row.model
   const allowEmpty=keyless(row.capability,provider,url)
   let envelope:Awaited<ReturnType<CredentialPatchOptions['encrypt']>>|null=null
   if(input.value==null){
    if(!canReuseByokKeyForDestination(row,{provider,api_format:format||'',base_url:url||'',model:model||'',capability:row.capability}))throw Object.assign(new Error(BYOK_DESTINATION_MISMATCH_MESSAGE),{statusCode:422})
    if(!allowEmpty){let empty=false;try{empty=(await options.decrypt(row))===''}catch{};if(empty)throw Object.assign(new Error('该 Provider 需要 API Key，请填写后保存'),{statusCode:422})}
   }else{
    if(!input.value&&!allowEmpty)throw Object.assign(new Error('该 Provider 需要 API Key，不能为空'),{statusCode:422})
    try{envelope=await options.encrypt(input.value,allowEmpty)}catch{throw Object.assign(new Error('BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY'),{statusCode:503})}
   }
   if(input.web_search_enabled===true&&(row.capability!=='llm'||!webSearchSupported(provider,format)))throw Object.assign(new Error('当前 Provider 或 API 格式不支持联网搜索'),{statusCode:422})
   if(row.capability!=='llm'&&input.web_search_enabled!=null)throw Object.assign(new Error('联网搜索开关只适用于 LLM 凭据'),{statusCode:422})
   const columns:Record<string,string>={provider:'provider',api_format:'api_format',base_url:'base_url',model:'model',dimensions:'dimensions',max_tokens:'max_tokens',context_tokens:'context_tokens',thinking:'thinking',reasoning_effort:'reasoning_effort',reasoning_persistence:'reasoning_persistence',web_search_enabled:'web_search_enabled',image:'image',video:'video',audio:'audio',image_detail:'image_detail',enabled:'enabled'}
   const values:[string,unknown][]=[]
   for(const [field,column] of Object.entries(columns))if(input[field as keyof CredentialPatchInput]!=null)values.push([column,input[field as keyof CredentialPatchInput]])
   if(!webSearchSupported(provider,format))values.push(['web_search_enabled',false])
   if(envelope){values.push(['encrypted_value',envelope.ciphertext],['nonce',envelope.nonce],['encrypted_data_key',envelope.encryptedDataKey],['key_version',envelope.keyVersion])}
   values.push(['updated_at',new Date()])
   if(input.enabled===true)await sql`UPDATE user_provider_credentials SET enabled=false WHERE user_id=${owner} AND capability=${row.capability} AND id<>${credentialId}`.execute(tx)
   const assignments=sql.join(values.map(([column,value])=>sql`${sql.ref(column)}=${value}`),sql`, `)
   const updated=await sql<Row>`UPDATE user_provider_credentials SET ${assignments} WHERE user_id=${owner} AND id=${credentialId} RETURNING *`.execute(tx)
   if(row.capability==='llm')await sql`UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner} AND status='active'`.execute(tx)
   const result=updated.rows[0]!
   return Object.fromEntries([...viewFields.map(field=>[field,result[field]]),['has_value',Boolean(result.encrypted_value)]])
  })
 }
}
