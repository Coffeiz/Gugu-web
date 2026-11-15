import type { JsonObject, ProviderTransport } from '../providers/contracts.js'

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

/** 不缓存跨用户查询或凭据；公开结果只包含稳定状态和向量。 */
export async function embedRagQuery(settings:RagQueryEmbeddingSettings,text:string,transport:ProviderTransport,signal:AbortSignal):Promise<RagQueryEmbeddingResult> {
 signal.throwIfAborted()
 const normalized=text.trim(),request=normalized?requestFor(settings,normalized):null
 if(!request)return {vector:[],outcome:'invalid_config'}
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
  return vector?{vector,outcome:'success',httpStatus:response.status}:{vector:[],outcome:'invalid_response',httpStatus:response.status}
 }catch{
  signal.throwIfAborted()
  return {vector:[],outcome:timeout.aborted?'timeout':'network_error'}
 }
}
