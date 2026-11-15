import { openLocalFile } from '@gugu/fs/node'
import { embedRagQuery, type RagQueryEmbeddingSettings, type RagVectorSource } from '@gugu/core/agent'
import type { ProviderTransport } from '@gugu/core/providers'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import type { Pool } from 'pg'
import { normalizeOwnerId } from '../../../adapters/owner-context.js'

const vectorFiles = {
 memory: '.agent/memory_vec.json',
 knowledge: '.agent/knowledge/vectors.json',
 pattern: '.agent/pattern_vec.json',
} as const
const maxCharacters = 50_000_000
type EmbeddingCredentialEnvelope={encrypted_value:string;nonce:string;encrypted_data_key:string;key_version:number}

/** 由可信 Host 绑定存储根与 owner，模型不得控制两者。 */
export function createOwnerRagVectorSource(root:string,ownerId:string) {
 const owner=normalizeOwnerId(ownerId)
 return async (kind:keyof typeof vectorFiles,signal?:AbortSignal):Promise<string|null>=>{
  signal?.throwIfAborted()
  if(!Object.hasOwn(vectorFiles,kind))throw new Error('RAG 向量来源无效')
  const file=await openLocalFile(root,`${owner}/${vectorFiles[kind]}`)
  if(!file)return null
  try{
   if(file.size>maxCharacters*4)throw new Error('RAG 向量文件过大')
   const value=await file.handle.readFile({encoding:'utf8',signal})
   signal?.throwIfAborted()
   if(value.length>maxCharacters)throw new Error('RAG 向量文件过大')
   return value
  }finally{await file.handle.close()}
 }
}

/**
 * 绑定 owner 的旧向量文件和可信 embedding 配置；凭据解析、传输策略均由 Host 提供。
 * 未配置 embedding 时返回 null，保持旧版词法召回；请求失败只返回空向量，不泄露上游错误。
 */
export function createOwnerAgentRagVectorResolver(options:{
 root:string
 resolveEmbedding(ownerId:string,signal?:AbortSignal):Promise<RagQueryEmbeddingSettings|null>
 createTransport(settings:RagQueryEmbeddingSettings):ProviderTransport
}) {
 return async(ownerId:string,signal?:AbortSignal)=>{
  signal?.throwIfAborted()
  const owner=normalizeOwnerId(ownerId),settings=await options.resolveEmbedding(owner,signal)
  signal?.throwIfAborted()
  if(!settings)return null
  const version=`${settings.provider}:${settings.model}:${settings.dimensions||'default'}`
  const source=async(boundOwner:string,readSignal?:AbortSignal):Promise<RagVectorSource>=>{
   readSignal?.throwIfAborted()
   if(normalizeOwnerId(boundOwner)!==owner)throw new Error('RAG 向量 owner 不匹配')
   return createOwnerRagVectorSource(options.root,owner)
  }
  const embed=async(boundOwner:string,query:string,embedSignal?:AbortSignal):Promise<readonly number[]>=>{
   if(normalizeOwnerId(boundOwner)!==owner)throw new Error('RAG embedding owner 不匹配')
   embedSignal?.throwIfAborted()
   const transport=options.createTransport(settings)
   try {
    const result=await embedRagQuery(settings,query,transport,embedSignal??new AbortController().signal)
    embedSignal?.throwIfAborted()
    return result.outcome==='success'?result.vector:[]
   } finally { await transport.close?.() }
  }
  return {version,source,embed}
 }
}

/** 只读取当前 owner 明确启用的 embedding BYOK；解密器与密钥轮换由 Host 注入。 */
export function createPostgresAgentEmbeddingSettingsResolver(pool:Pick<Pool,'query'>,options:{enabled():boolean|Promise<boolean>;decrypt(row:EmbeddingCredentialEnvelope):Promise<string>}) {
 return async(ownerId:string,signal?:AbortSignal):Promise<RagQueryEmbeddingSettings|null>=>{
  signal?.throwIfAborted()
  if(!await options.enabled())return null
  signal?.throwIfAborted()
  const owner=normalizeOwnerId(ownerId)
  const result=await pool.query(`SELECT provider,base_url,model,dimensions,encrypted_value,nonce,encrypted_data_key,key_version
   FROM user_provider_credentials WHERE user_id=$1 AND capability='embedding' AND enabled IS TRUE ORDER BY id LIMIT 1`,[owner])
  signal?.throwIfAborted()
  const row=result.rows[0] as (EmbeddingCredentialEnvelope&{provider?:unknown;base_url?:unknown;model?:unknown;dimensions?:unknown})|undefined
  if(!row||typeof row.provider!=='string'||typeof row.base_url!=='string'||typeof row.model!=='string'||!row.base_url.trim()||!row.model.trim())return null
  const dimensions=row.dimensions==null?0:Number(row.dimensions)
  if(!Number.isSafeInteger(dimensions)||dimensions<0||dimensions>65536)return null
  const apiKey=await options.decrypt(row)
  signal?.throwIfAborted()
  if(!await options.enabled())return null
  signal?.throwIfAborted()
  return {provider:row.provider,baseUrl:row.base_url,model:row.model,apiKey,dimensions,allowLocal:false}
 }
}

/** 提供给 search_memory 的可信 BYOK resolver 与受限 Node Transport；请求前再次检查 Host gate。 */
export function createPostgresAgentRagEmbeddingPort(pool:Pick<Pool,'query'>,options:{enabled():boolean|Promise<boolean>;decrypt(row:EmbeddingCredentialEnvelope):Promise<string>;createTransport?(settings:RagQueryEmbeddingSettings):ProviderTransport}) {
 const resolve=createPostgresAgentEmbeddingSettingsResolver(pool,options)
 return {
  resolve,
  createTransport(settings:RagQueryEmbeddingSettings):ProviderTransport {
   const transport=options.createTransport?.(settings)??createNodeProviderTransport({allowLocal:false})
   return {
    async request(request,signal) {
     signal.throwIfAborted()
     if(!await options.enabled())throw new Error('BYOK embedding 当前不可用')
     signal.throwIfAborted()
     return transport.request(request,signal)
    },
    async close(){await transport.close?.()},
   }
  },
 }
}
