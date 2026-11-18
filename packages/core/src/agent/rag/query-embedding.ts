import type { JsonObject, ProviderTransport } from '../providers/contracts.js'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export interface RagQueryEmbeddingSettings {
 provider:string
 baseUrl:string
 model:string
 apiKey:string
 dimensions:number
 multimodal?:boolean
 /** 仅可信 Host 可对明确的本地 Provider 放行内网目标。 */
 allowLocal?:boolean
}
export type RagQueryEmbeddingOutcome='success'|'invalid_config'|'http_error'|'invalid_response'|'response_too_large'|'timeout'|'network_error'
export type RagQueryEmbeddingResult={vector:number[];outcome:RagQueryEmbeddingOutcome;httpStatus?:number}
const MAX_RESPONSE_BYTES=2*1024*1024
const QUERY_CACHE_TTL_MS=5*60_000
const QUERY_CACHE_LIMIT=64
const queryCache=new Map<string,{createdAt:number;vector:number[]}>()

function cacheKey(ownerId:string,settings:RagQueryEmbeddingSettings,url:string,format:string,query:string):string {
 return createHash('sha256').update(JSON.stringify([
  ownerId,settings.provider,settings.model,settings.dimensions,url,format,settings.apiKey,settings.allowLocal===true,query,
 ])).digest('hex')
}

/** 1.7.7 的端点和载荷规则；DNS、重定向及网络能力由可信传输实现约束。 */
function requestFor(settings:RagQueryEmbeddingSettings,text:string):{url:string;body:JsonObject;format:'openai'|'bailian'}|null {
 try{
  const base=new URL(settings.baseUrl.trim())
  if(!['http:','https:'].includes(base.protocol)||!base.hostname||base.username||base.password||base.search||base.hash||!settings.model.trim()||!Number.isSafeInteger(settings.dimensions)||/[^\x20-\x7e]/u.test(settings.apiKey))return null
  const bailian=['bailian','dashscope','aliyun'].includes(settings.provider.trim().toLowerCase())||base.toString().toLowerCase().includes('aliyuncs.com')
  if(settings.multimodal&&bailian){
   const prefix=base.pathname.split('/compatible-mode/v1',1)[0]!.replace(/\/+$/u,'')
   base.pathname=`${prefix}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`
   return {url:base.toString(),body:{model:settings.model,input:{contents:[{text}]},parameters:{output_type:'dense',...(settings.dimensions>0?{dimension:settings.dimensions}:{}),enable_fusion:false}},format:'bailian'}
  }
  base.pathname=`${base.pathname.replace(/\/+$/u,'')}/embeddings`
  return {url:base.toString(),body:{model:settings.model,input:text,...(settings.dimensions>0?{dimensions:settings.dimensions}:{}),...(bailian?{encoding_format:'float'}:{})},format:'openai'}
 }catch{return null}
}

function vectorFrom(value:unknown,format:'openai'|'bailian'):number[]|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const root=value as Record<string,unknown>
 const output=format==='bailian'?root.output:root
 if(!output||typeof output!=='object'||Array.isArray(output))return null
 const entries=(output as Record<string,unknown>)[format==='bailian'?'embeddings':'data']
 if(!Array.isArray(entries)||!entries[0]||typeof entries[0]!=='object')return null
 const vector=(entries[0] as Record<string,unknown>).embedding
 return Array.isArray(vector)&&vector.length>0&&vector.every(value=>typeof value==='number'&&Number.isFinite(value))?vector:null
}

/** 仅对可信 Host 提供的 owner 缓存成功查询；凭据及正文不保留于缓存。 */
export async function embedRagQuery(settings:RagQueryEmbeddingSettings,text:string,transport:ProviderTransport,signal:AbortSignal,cacheOwnerId?:string):Promise<RagQueryEmbeddingResult> {
 signal.throwIfAborted()
 const normalized=text.trim(),request=normalized?requestFor(settings,normalized):null
 if(!request)return {vector:[],outcome:'invalid_config'}
 const key=cacheOwnerId?cacheKey(cacheOwnerId,settings,request.url,request.format,normalized):null
 const now=performance.now(),cached=key?queryCache.get(key):undefined
 if(key&&cached){
  if(now-cached.createdAt<QUERY_CACHE_TTL_MS)return {vector:[...cached.vector],outcome:'success'}
  queryCache.delete(key)
 }
 const timeout=AbortSignal.timeout(4000),combined=AbortSignal.any([signal,timeout])
 try{
  const response=await transport.request({url:request.url,method:'POST',headers:{accept:'application/json','accept-encoding':'identity','content-type':'application/json',...(settings.apiKey?{authorization:`Bearer ${settings.apiKey}`}:{})},body:request.body,timeoutMs:4000,allowLocal:settings.allowLocal===true&&['local','ollama'].includes(settings.provider.trim().toLowerCase())},combined)
  if(response.status!==200){await response.cancel();signal.throwIfAborted();return {vector:[],outcome:'http_error',httpStatus:response.status}}
  let bytes=0;const chunks:Uint8Array[]=[]
  for await(const chunk of response.body){
   signal.throwIfAborted();if(timeout.aborted)throw timeout.reason
   bytes+=chunk.byteLength
   if(bytes>MAX_RESPONSE_BYTES){await response.cancel();signal.throwIfAborted();if(timeout.aborted)throw timeout.reason;return {vector:[],outcome:'response_too_large',httpStatus:response.status}}
   chunks.push(chunk)
  }
  signal.throwIfAborted();if(timeout.aborted)throw timeout.reason
  let parsed:unknown
  try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return {vector:[],outcome:'invalid_response',httpStatus:response.status}}
  const vector=vectorFrom(parsed,request.format)
  if(!vector)return {vector:[],outcome:'invalid_response',httpStatus:response.status}
  if(key){
   if(queryCache.size>=QUERY_CACHE_LIMIT){
    let oldestKey:string|undefined,oldestAt=Infinity
    for(const [entryKey,entry] of queryCache)if(entry.createdAt<oldestAt){oldestKey=entryKey;oldestAt=entry.createdAt}
    if(oldestKey!==undefined)queryCache.delete(oldestKey)
   }
   queryCache.set(key,{createdAt:performance.now(),vector:[...vector]})
  }
  return {vector,outcome:'success',httpStatus:response.status}
 }catch{
  signal.throwIfAborted()
  return {vector:[],outcome:timeout.aborted?'timeout':'network_error'}
 }
}
