import type {JsonObject,ProviderTransport} from '../agent/providers/contracts.js'
import {asciiDecimalDigits} from '../shared/unicode-decimal.js'
export interface EmbeddingProbeSettings {provider:string;base_url:string;api_key:string;model:string;dimensions:number}
export interface EmbeddingProbeInput extends Partial<EmbeddingProbeSettings> {multimodal?:boolean}
const bailian=(provider:string,url:string)=>['bailian','dashscope','aliyun'].includes(provider.trim().toLowerCase())||url.toLowerCase().includes('aliyuncs.com')
/** 与Python normalize_dimensions一致：空/不可解析为0，数字截断，保留负值。 */
export function embeddingDimensions(value:unknown):number {
 if(typeof value==='boolean')return Number(value)
 if(typeof value==='number')return Number.isFinite(value)?Math.trunc(value):0
 if(typeof value!=='string')return 0
 const text=asciiDecimalDigits(value.trim());return /^[+-]?\d(?:_?\d)*$/.test(text)?Number(text.replaceAll('_','')):0
}
export async function probeEmbedding(input:EmbeddingProbeInput,settings:EmbeddingProbeSettings,transport:ProviderTransport):Promise<{ok:boolean;message:string}> {
 const provider=input.provider||settings.provider,model=input.model||settings.model,key=input.api_key||settings.api_key,dims=input.dimensions||settings.dimensions
 let base=(input.base_url||settings.base_url||'').trim().replace(/\/+$/,'')
 if(!base&&bailian(provider,base))base='https://dashscope.aliyuncs.com/compatible-mode/v1'
 const fail=(message:string)=>({ok:false,message})
 if(!base||!model)return fail('缺少 Base URL 或模型名')
 const multimodal=input.multimodal===true
 if(multimodal&&!['bailian','dashscope','aliyun'].includes(provider.toLowerCase()))return fail('多模态 Embedding 目前仅支持百炼')
 const payload:JsonObject=multimodal?{model,input:{contents:[{text:'连通性测试'}]},parameters:{output_type:'dense',...(dims?{dimension:dims}:{})}}:{model,input:'连通性测试',...(dims?{dimensions:dims}:{}),...(bailian(provider,base)?{encoding_format:'float'}:{})}
 const url=multimodal?base.split('/compatible-mode/v1',1)[0]!.replace(/\/+$/,'')+'/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding':base+'/embeddings'
 const format=multimodal?'返回格式不对（不是百炼多模态 Embedding 响应）':'返回格式不对（不是 OpenAI 兼容 /embeddings 响应）'
 let response
 try{response=await transport.request({url,method:'POST',headers:{'content-type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},body:payload,timeoutMs:15000,allowLocal:['local','ollama'].includes(provider.toLowerCase())},AbortSignal.timeout(15000))}catch{return fail('连不上：请检查端点、网络和认证配置')}
 try{
  if(response.status!==200)return fail(`HTTP ${response.status}：端点请求失败`)
  let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true})
  try{for await(const chunk of response.body){size+=chunk.byteLength;if(size>1024*1024)return fail(format);text+=decoder.decode(chunk,{stream:true})}text+=decoder.decode()}catch{return fail(format)}
  let vec:unknown
  try{const data=JSON.parse(text);vec=multimodal?data.output.embeddings[0].embedding:data.data[0].embedding;if(vec===undefined)throw Error()}catch{return fail(format)}
  if(!Array.isArray(vec)||!vec.length)return fail(multimodal?'返回的多模态向量为空':'返回的向量为空')
  return {ok:true,message:`OK — ${multimodal?'多模态连通':'连通'}，向量维度 ${vec.length}`}
 }finally{await response.cancel()}
}
