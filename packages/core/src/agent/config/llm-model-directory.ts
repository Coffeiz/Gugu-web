import type {ProviderConfig,ProviderHttpRequest,ProviderTransport} from '../providers/contracts.js'
import {providerDiagnosticRequest} from '../providers/diagnostics.js'
import {adapterFor} from '../providers/registry.js'

export interface LlmModelDirectoryInput {provider?:string;base_url?:string;api_key?:string;api_format?:string}
export class LlmModelDirectoryError extends Error {
 override name='LlmModelDirectoryError'
 constructor(readonly status:400|502,message:string){super(message)}
}
/** Python目录API只传四字段，不继承预设的运行时/模型/池选项。 */
export function llmModelDirectoryRequest(input:LlmModelDirectoryInput):ProviderHttpRequest{
 const config:ProviderConfig={provider:input.provider??'openai',base_url:(input.base_url??'').replace(/\/+$/,''),api_key:input.api_key??'',api_format:input.api_format??'',model:''}
 if(config.provider==='qwen'&&config.api_format==='dashscope'){
  const base=config.base_url==='https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'?'https://dashscope.aliyuncs.com/compatible-mode/v1':config.base_url
  return llmModelDirectoryRequest({...config,base_url:base,api_format:'openai'})
 }
 // Python Ollama native目录忽略凭据，既不发送Authorization也不校验未使用的key。
 const native=adapterFor(config).name==='ollama'
 const request=providerDiagnosticRequest(native?{...config,api_key:''}:config,'models')
 const headers={...request.headers}
 if(native)for(const key of Object.keys(headers))if(key.toLowerCase()==='authorization')delete headers[key]
 return {...request,headers,timeoutMs:8000}
}
class ModelNumber {constructor(readonly value:number,readonly text:string){}}
function truthy(value:unknown):boolean{
 if(value instanceof ModelNumber)return value.value!==0
 if(value==null||value===false||value===0||value==='')return false
 if(Array.isArray(value))return value.length>0
 if(typeof value==='object')return Object.keys(value).length>0
 return true
}
function compare(a:string,b:string):number{
 const left=Array.from(a),right=Array.from(b)
 for(let i=0;i<Math.min(left.length,right.length);i++){const diff=left[i]!.codePointAt(0)!-right[i]!.codePointAt(0)!;if(diff)return diff}
 return left.length-right.length
}
function quoted(value:string):string{
 const quote=value.includes("'")&&!value.includes('"')?'"':"'"
 let out=quote
 for(const char of value){
  const point=char.codePointAt(0)!
  if(char===quote||char==='\\')out+='\\'+char
  else if(char==='\n')out+='\\n'
  else if(char==='\r')out+='\\r'
  else if(char==='\t')out+='\\t'
  else if(char!==' '&&/[\p{C}\p{Z}]/u.test(char))out+=point<=255?'\\x'+point.toString(16).padStart(2,'0'):point<=65535?'\\u'+point.toString(16).padStart(4,'0'):'\\U'+point.toString(16).padStart(8,'0')
  else out+=char
 }
 return out+quote
}
function representation(value:unknown):string{
 if(value instanceof ModelNumber)return value.text
 if(typeof value==='string')return quoted(value)
 if(value===true)return 'True'
 if(value===false)return 'False'
 if(value===null)return 'None'
 if(Array.isArray(value))return '['+value.map(representation).join(', ')+']'
 if(value&&typeof value==='object')return '{'+Object.entries(value).map(([key,item])=>quoted(key)+': '+representation(item)).join(', ')+'}'
 return String(value)
}
function modelId(value:unknown):string{return typeof value==='string'?value:representation(value)}
function decode(body:string):unknown{
 const parse=JSON.parse as (text:string,reviver:(key:string,value:unknown,context:{source?:string})=>unknown)=>unknown
 return parse(body,(_key,value,context)=>{
  if(typeof value!=='number')return value
  const source=context.source??String(value)
  if(/^-?\d+$/.test(source))return new ModelNumber(value,BigInt(source).toString())
  let text=value.toString()
  if(Object.is(value,-0))text='-0.0'
  else if(value===0)text='0.0'
  else{
   if(!text.includes('e')&&(Math.abs(value)>=1e16||Math.abs(value)<1e-4))text=value.toExponential()
   if(text.includes('e')){const [mantissa,exponent]=text.split('e');const n=Number(exponent);text=mantissa+'e'+(n>=0?'+':'-')+String(Math.abs(n)).padStart(2,'0')}
   else if(Number.isInteger(value))text+='.0'
  }
  return new ModelNumber(value,text)
 })
}

function models(payload:unknown):string[]{
 if(payload instanceof ModelNumber)throw new Error('模型目录无效')
 const source=payload&&typeof payload==='object'&&!Array.isArray(payload)?(Object.hasOwn(payload,'data')?(payload as Record<string,unknown>).data:[]):payload
 if(source==null||source instanceof ModelNumber||typeof source==='number'||typeof source==='boolean')throw new Error('模型目录无效')
 const rows=Array.isArray(source)?source:typeof source==='object'?Object.keys(source):Array.from(String(source))
 const values=rows.filter((row):row is Record<string,unknown>=>!!row&&typeof row==='object'&&!Array.isArray(row)&&truthy(row.id)).map(row=>modelId(row.id))
 return [...new Set(values)].sort(compare)
}
/** 保留目录特有错误DTO，不消费聊天模型或Agent运行时；传输端口仍执行DNS/URL/重定向安全策略。 */
export function createLlmModelDirectory(createTransport:()=>ProviderTransport){
 return async(input:LlmModelDirectoryInput,signal:AbortSignal=new AbortController().signal)=>{
  // 与Python相同，配置/凭据构造发生于HTTP异常映射边界之外。
  const request=llmModelDirectoryRequest(input),transport=createTransport()
  let response:Awaited<ReturnType<ProviderTransport['request']>>|undefined
  try{
   response=await transport.request(request,signal)
   if(response.status>=400)throw new LlmModelDirectoryError(502,[401,403].includes(response.status)?'服务商鉴权失败':`服务商暂不支持模型列表（HTTP ${response.status}）`)
   const decoder=new TextDecoder('utf-8',{fatal:true});let body='',bytes=0
   for await(const chunk of response.body){if(signal.aborted)throw new Error('请求已取消');bytes+=chunk.byteLength;if(bytes>64*1024*1024)throw new Error('模型目录过大');body+=decoder.decode(chunk,{stream:true})}
   body+=decoder.decode()
   return {models:models(decode(body)),source:'provider' as const}
  }catch(error){if(error instanceof LlmModelDirectoryError)throw error;throw new LlmModelDirectoryError(502,'获取模型列表失败，请检查地址和网络')}
  finally{try{await response?.cancel()}finally{await transport.close?.()}}
 }
}
