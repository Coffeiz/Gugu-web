import { dataContext, CoreError } from '@gugu/core/contracts'
import { allowsEmptyByokKey, supportsByokWebSearch, canReuseByokKeyForDestination, BYOK_DESTINATION_MISMATCH_MESSAGE } from '@gugu/core/byok/policy'
import type { RagQueryEmbeddingSettings } from '@gugu/core/agent/rag'
import type { Pool, PoolClient } from 'pg'
import { normalizeOwnerId } from '../../shared/owner-context.js'
import { sql, type Kysely } from 'kysely'
import type { ByokListRow } from '@gugu/core/agent/config'
import { createHmac } from 'node:crypto'
import type { CredentialDestination } from '@gugu/core/byok/policy'

export interface CredentialInput {provider:string;capability:'llm'|'deep_research'|'similar_image_search'|'speech_to_text'|'embedding';value:string;api_format?:string;base_url?:string;model?:string;dimensions?:number|null;max_tokens?:number|null;context_tokens?:number|null;thinking?:string|null;reasoning_effort?:string|null;reasoning_persistence?:string;web_search_enabled?:boolean|null;image?:boolean;video?:boolean;audio?:boolean;image_detail?:string}

export interface EncryptedCredential {ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}

export type CreatedCredential = Record<string, unknown> & {id: number | string; has_value: boolean}

type Query=(text:string,values:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>

export interface CreateCredentialOptions {transaction:<T>(work:(query:Query)=>Promise<T>)=>Promise<T>;encrypt:(value:string,allowEmpty:boolean)=>Promise<EncryptedCredential>;enabled:()=>boolean}

/** owner锁覆盖禁用旧凭据、插入新凭据及推理状态失效。 */
export function createCredentialCreator(options:CreateCredentialOptions){
 return async(ownerId:string,input:CredentialInput, makeDefault = true):Promise<CreatedCredential>=>{
  if(!options.enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId,webSupported=input.capability==='llm'&&supportsByokWebSearch(input.provider,input.api_format??''),web=input.web_search_enabled??webSupported
  if(web&&!webSupported)throw Object.assign(new Error('当前 Provider 或 API 格式不支持联网搜索'),{statusCode:422})
  const allowEmpty=allowsEmptyByokKey(input.capability, input.provider, input.base_url ?? '')
  if(!input.value&&!allowEmpty)throw Object.assign(new Error('该 Provider 需要 API Key，不能为空'),{statusCode:422})
  let encrypted:EncryptedCredential
  try{encrypted=await options.encrypt(input.value,allowEmpty)}catch{throw Object.assign(new Error('BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY'),{statusCode:503})}
  return options.transaction(async query=>{
   await query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner])
   if (makeDefault) await query('UPDATE user_provider_credentials SET enabled=false WHERE user_id=$1 AND capability=$2 AND enabled IS TRUE',[owner,input.capability])
   const fields=['user_id','provider','api_format','capability','encrypted_value','nonce','encrypted_data_key','key_version','base_url','model','max_tokens','context_tokens','thinking','reasoning_effort','reasoning_persistence','web_search_enabled','image','video','audio','image_detail','dimensions','enabled','created_at','updated_at']
   const values=[owner,input.provider,input.api_format??'',input.capability,encrypted.ciphertext,encrypted.nonce,encrypted.encryptedDataKey,encrypted.keyVersion,input.base_url??'',input.model??'',input.max_tokens??null,input.context_tokens??null,input.thinking??null,input.reasoning_effort??null,input.reasoning_persistence??'off',web,input.image??false,input.video??false,input.audio??false,input.image_detail??'auto',input.dimensions??null,makeDefault,new Date(),new Date()]
   const row=(await query(`INSERT INTO user_provider_credentials(${fields.join(',')}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id,provider,api_format,capability,base_url,model,max_tokens,context_tokens,thinking,reasoning_effort,reasoning_persistence,web_search_enabled,image,video,audio,image_detail,dimensions,enabled,last_verified_at,created_at,updated_at`,values)).rows[0]!
   if (makeDefault) await query(
    `INSERT INTO user_provider_bindings (user_id, capability, credential_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, capability) DO UPDATE SET credential_id = EXCLUDED.credential_id`,
    [owner, input.capability, row.id],
   )
   if(makeDefault && input.capability==='llm')await query("UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND status='active'",[owner])
   return {...row,id:Number(row.id),has_value:Boolean(encrypted.ciphertext)}
  })
 }
}

export type EmbeddingCredentialEnvelope = { encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number }

/** 只读取当前 owner 启用的 Embedding BYOK；gate 与密钥解密由 Host 注入。 */
export function createPostgresAgentEmbeddingSettingsResolver(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean | Promise<boolean>
  decrypt(row: EmbeddingCredentialEnvelope): Promise<string>
}) {
  return async (ownerId: string, signal?: AbortSignal): Promise<RagQueryEmbeddingSettings | null> => {
    signal?.throwIfAborted()
    if (!await options.enabled()) return null
    signal?.throwIfAborted()
    const owner = normalizeOwnerId(ownerId)
    const result = await pool.query(`SELECT provider,base_url,model,dimensions,encrypted_value,nonce,encrypted_data_key,key_version
      FROM user_provider_credentials WHERE user_id=$1 AND capability='embedding' AND enabled IS TRUE ORDER BY id LIMIT 1`, [owner])
    signal?.throwIfAborted()
    const row = result.rows[0] as (EmbeddingCredentialEnvelope & { provider?: unknown; base_url?: unknown; model?: unknown; dimensions?: unknown }) | undefined
    if (!row || typeof row.provider !== 'string' || typeof row.base_url !== 'string' || typeof row.model !== 'string'
      || !row.base_url.trim() || !row.model.trim()) return null
    const dimensions = row.dimensions == null ? 0 : Number(row.dimensions)
    if (!Number.isSafeInteger(dimensions) || dimensions < 0 || dimensions > 65_536) return null
    const apiKey = await options.decrypt(row)
    signal?.throwIfAborted()
    if (!await options.enabled()) return null
    signal?.throwIfAborted()
    const allowLocal = ['local', 'ollama'].includes(row.provider.trim().toLowerCase())
    return { provider: row.provider, baseUrl: row.base_url, model: row.model, apiKey, dimensions, allowLocal }
  }
}

/** 删除不需要解密凭据；LLM配置变更与推理状态失效必须处于同一事务。 */
export function createCredentialDeletion<DB>(db:Kysely<DB>,enabled:()=>boolean){
 return async(ownerId:string,credentialId:number):Promise<void>=>{
  if(!enabled())throw Object.assign(new Error('用户 BYOK 未开放'),{statusCode:403})
  const owner=dataContext(ownerId).ownerId
  await db.transaction().execute(async tx=>{
   await sql`SELECT id FROM users WHERE id=${owner} FOR UPDATE`.execute(tx)
   const result=await sql<{capability:string;enabled:boolean}>`DELETE FROM user_provider_credentials WHERE user_id=${owner} AND id=${credentialId} RETURNING capability, enabled`.execute(tx)
   const row=result.rows[0]
   if(!row)throw new CoreError('not_found','凭据不存在')
   if(row.capability==='llm' && row.enabled)await sql`UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner} AND status='active'`.execute(tx)
  })
 }
}

/** 只读取当前 owner；密文仅供请求内状态校验，绝不作为响应返回。 */
export function createPostgresByokListReader(pool: Pick<Pool, 'query'>) {
  return async (ownerId: string): Promise<readonly ByokListRow[]> => {
    const owner = dataContext(ownerId).ownerId
    const result = await pool.query<ByokListRow>(`SELECT id,provider,api_format,capability,base_url,model,max_tokens,dimensions,context_tokens,
      thinking,reasoning_effort,reasoning_persistence,web_search_enabled,image,video,audio,image_detail,
      EXISTS (SELECT 1 FROM user_provider_bindings AS binding
        WHERE binding.user_id = item.user_id AND binding.capability = item.capability
          AND binding.credential_id = item.id) AS enabled,
      to_char(last_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS last_verified_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS created_at,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS updated_at,
      encrypted_value,nonce,encrypted_data_key,key_version FROM user_provider_credentials AS item WHERE user_id=$1 ORDER BY id`, [owner])
    return result.rows
  }
}

export interface CredentialPatchInput {
 provider?:string|null;value?:string|null;api_format?:string|null;base_url?:string|null;model?:string|null
 dimensions?:number|null;max_tokens?:number|null;context_tokens?:number|null;thinking?:string|null;reasoning_effort?:string|null
 reasoning_persistence?:string|null;web_search_enabled?:boolean|null;image?:boolean|null;video?:boolean|null;audio?:boolean|null
 image_detail?:string|null;enabled?:boolean|null
}

type Row=Record<string,any>&{provider:string;api_format:string;capability:string;base_url:string;model:string;encrypted_value:string;nonce:string;encrypted_data_key:string;key_version:number;user_id:string;id:number;dimensions:number|null;enabled:boolean;last_verified_at:unknown;created_at:unknown;updated_at:unknown}

export interface CredentialPatchOptions {
 enabled:()=>boolean
 encrypt:(value:string,allowEmpty:boolean)=>Promise<{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}>
 decrypt:(row:Pick<Row,'encrypted_value'|'nonce'|'encrypted_data_key'|'key_version'>)=>Promise<string>
}

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
   const allowEmpty=allowsEmptyByokKey(row.capability,provider,url)
   let envelope:Awaited<ReturnType<CredentialPatchOptions['encrypt']>>|null=null
   if(input.value==null){
    if(!canReuseByokKeyForDestination(row,{provider,api_format:format||'',base_url:url||'',model:model||'',capability:row.capability}))throw Object.assign(new Error(BYOK_DESTINATION_MISMATCH_MESSAGE),{statusCode:422})
    if(!allowEmpty){let empty=false;try{empty=(await options.decrypt(row))===''}catch{};if(empty)throw Object.assign(new Error('该 Provider 需要 API Key，请填写后保存'),{statusCode:422})}
   }else{
    if(!input.value&&!allowEmpty)throw Object.assign(new Error('该 Provider 需要 API Key，不能为空'),{statusCode:422})
    try{envelope=await options.encrypt(input.value,allowEmpty)}catch{throw Object.assign(new Error('BYOK 加密服务未配置，请先设置 CREDENTIALS_MASTER_KEY'),{statusCode:503})}
   }
   if(input.web_search_enabled===true&&(row.capability!=='llm'||!supportsByokWebSearch(provider,format)))throw Object.assign(new Error('当前 Provider 或 API 格式不支持联网搜索'),{statusCode:422})
   if(row.capability!=='llm'&&input.web_search_enabled!=null)throw Object.assign(new Error('联网搜索开关只适用于 LLM 凭据'),{statusCode:422})
   const columns:Record<string,string>={provider:'provider',api_format:'api_format',base_url:'base_url',model:'model',dimensions:'dimensions',max_tokens:'max_tokens',context_tokens:'context_tokens',thinking:'thinking',reasoning_effort:'reasoning_effort',reasoning_persistence:'reasoning_persistence',web_search_enabled:'web_search_enabled',image:'image',video:'video',audio:'audio',image_detail:'image_detail',enabled:'enabled'}
   const values:[string,unknown][]=[]
   for(const [field,column] of Object.entries(columns))if(input[field as keyof CredentialPatchInput]!=null)values.push([column,input[field as keyof CredentialPatchInput]])
   if (input.web_search_enabled == null && row.web_search_enabled === true && !supportsByokWebSearch(provider, format))
    values.push(['web_search_enabled', false])
   if(envelope){values.push(['encrypted_value',envelope.ciphertext],['nonce',envelope.nonce],['encrypted_data_key',envelope.encryptedDataKey],['key_version',envelope.keyVersion])}
   if (values.some(([column]) => column !== 'enabled') || !values.length)
    values.push(['updated_at', sql`clock_timestamp()`])
   if(input.enabled===true)await sql`UPDATE user_provider_credentials SET enabled=false WHERE user_id=${owner} AND capability=${row.capability} AND id<>${credentialId}`.execute(tx)
   const assignments=sql.join(values.map(([column,value])=>sql`${sql.ref(column)}=${value}`),sql`, `)
   const updated=await sql<Row>`UPDATE user_provider_credentials SET ${assignments} WHERE user_id=${owner} AND id=${credentialId} RETURNING *`.execute(tx)
   if (input.enabled === true) {
    await sql`INSERT INTO user_provider_bindings (user_id, capability, credential_id)
      VALUES (${owner}, ${row.capability}, ${credentialId})
      ON CONFLICT (user_id, capability) DO UPDATE SET credential_id = EXCLUDED.credential_id`.execute(tx)
   } else if (input.enabled === false) {
    await sql`DELETE FROM user_provider_bindings WHERE user_id=${owner}
      AND capability=${row.capability} AND credential_id=${credentialId}`.execute(tx)
   }
   if(row.capability==='llm' && (row.enabled || input.enabled === true))await sql`UPDATE provider_reasoning_states SET status='invalidated',invalidated_reason='config_changed',invalidated_at=CURRENT_TIMESTAMP,encrypted_payload='',payload_nonce='',encrypted_data_key='',payload_size=0,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${owner} AND status='active'`.execute(tx)
   const result=updated.rows[0]!
   return Object.fromEntries([...viewFields.map(field=>[field,result[field]]),['has_value',Boolean(result.encrypted_value)]])
  })
 }
}

type CredentialRow = ByokCredential & { id: number | null; revision: string | null }

export class LlmCredentialUnavailable extends Error {
  readonly statusCode = 409
  constructor() { super('指定的 LLM 凭据不可用，请检查凭据配置后重新发起') }
}

/** undefined 选择账号默认，null 重取已固定的服务模型，数字精确重取指定凭据。 */
export async function readPostgresLlmCredentialSnapshot(
  client: Pick<PoolClient, 'query'>, ownerId: string, versionSecret: string, credentialId?: number | null,
) {
  if (!ownerId || !versionSecret) throw new Error('凭据快照身份无效')
  const id = credentialId === undefined
    ? (await client.query<{ credential_id: number }>(
      "SELECT credential_id FROM user_provider_bindings WHERE user_id=$1 AND capability='llm'", [ownerId],
    )).rows[0]?.credential_id ?? null
    : credentialId
  if (id === null) return { credential: null, credentialId: null, credentialVersion: 'service' }
  const result = await client.query<CredentialRow>(`SELECT id,extract(epoch from updated_at)::text AS revision,
      provider,api_format,base_url,model,encrypted_value,nonce,encrypted_data_key,key_version,
      max_tokens,context_tokens,thinking,reasoning_effort,reasoning_persistence,image,video,audio,image_detail,web_search_enabled
    FROM user_provider_credentials WHERE user_id=$1 AND capability='llm' AND id=$2`, [ownerId, id])
  const credential = result.rows[0]
  if (!credential) throw new LlmCredentialUnavailable()
  const credentialVersion = createHmac('sha256', versionSecret)
    .update(JSON.stringify(['agent-credential-v2', ownerId, credential])).digest('hex')
  return { credential, credentialId: id, credentialVersion }
}

export interface ByokCredential {
  provider: string; api_format: string; base_url: string; model: string
  encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number
  max_tokens: number | null; context_tokens: number | null; thinking: string | null
  reasoning_effort: string | null; reasoning_persistence: string
  image: boolean; video: boolean; audio: boolean; image_detail: string
  web_search_enabled: boolean
}

/** 按用户查询启用的 LLM 凭据；不接受调用方提供的凭据 ID。 */
export async function readActiveLlmCredential(pool: Pick<Pool, 'query'>, ownerId: string): Promise<ByokCredential | null> {
  const result = await pool.query('SELECT provider, api_format, base_url, model, encrypted_value, nonce, encrypted_data_key, key_version, max_tokens, context_tokens, thinking, reasoning_effort, reasoning_persistence, image, video, audio, image_detail, web_search_enabled FROM user_provider_credentials WHERE user_id = $1 AND capability = $2 AND enabled IS TRUE ORDER BY id LIMIT 1', [ownerId, 'llm'])
  return (result.rows[0] as ByokCredential | undefined) ?? null
}

export interface OwnedCredential extends CredentialDestination {
  id: number
  user_id: string
  capability: CredentialInput['capability']
  encrypted_value: string
  nonce: string
  encrypted_data_key: string
  key_version: number
  dimensions?: number | null
}

/** 已认证 owner 由调用方传入，查询只返回其凭据。 */
export async function readOwnedCredential<DB>(db: Kysely<DB>, owner: string, id: number, includeDimensions = false) {
  const result = await sql<OwnedCredential>`
    SELECT id, user_id, provider, api_format, capability, encrypted_value, nonce, encrypted_data_key,
      key_version, base_url, model${includeDimensions ? sql`, dimensions` : sql``}
    FROM user_provider_credentials WHERE user_id=${owner} AND id=${id} LIMIT 1
  `.execute(db)
  const row = result.rows[0]
  if (!row) throw new CoreError('not_found', '凭据不存在')
  return row
}
