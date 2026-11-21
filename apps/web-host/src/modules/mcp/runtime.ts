import {createHash} from 'node:crypto'
import {pinyin} from 'pinyin-pro'
import type {McpStoredServer} from '@gugu/core/mcp/server-list'
import {descriptionForProvider,descriptionShortOf,prefixedToolName,sanitizeInputSchema,validateInputArguments,validateInputSchema} from '@gugu/core/mcp/schema-adapter'
import {normalizeMcpSlots,validateMcpCredentialValues} from '@gugu/core/mcp/server-config'
import type {ProviderTransport} from '@gugu/core/providers'
import {createMcpHttpClient} from '@gugu/core/mcp/sdk-client'
import {createMcpSafeFetch} from '@gugu/core/mcp/safe-fetch'

interface EnvelopeReader {decrypt(input:{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}):Promise<string>}
interface RuntimeTool {name:string;tool_name:string;description:string;description_short:string;input_schema:Record<string,unknown>}
interface RuntimeClient {
 connect():Promise<void>
 listTools():Promise<{tools:unknown[]}>
 callTool(name:string,args:Record<string,unknown>,options?:{signal?:AbortSignal;timeout?:number}):Promise<unknown>
 close():Promise<void>
 isOpen?():boolean
}
interface RuntimeEntry {
 state:'ok'|'error';tools:RuntimeTool[];last_error:string|null;configFingerprint:string;client?:RuntimeClient;transport?:ProviderTransport
 errorKind?:'configuration'|'auth'|'timeout'|'network'|'protocol'
}
function configFingerprint(row:McpStoredServer):string{
 const configuration=[row.name,row.transport,row.endpoint,row.encrypted_endpoint,row.endpoint_nonce,row.encrypted_endpoint_key,row.endpoint_key_version,
  row.command,row.credential_slots,row.encrypted_credentials,row.credentials_nonce,row.encrypted_credentials_key,row.credentials_key_version,
  row.encrypted_headers,row.headers_nonce,row.encrypted_headers_key,row.headers_key_version,
  row.encrypted_query_params,row.query_params_nonce,row.encrypted_query_params_key,row.query_params_key_version,
  row.enabled,row.timeout_seconds,row.tool_allowlist]
 return createHash('sha256').update(JSON.stringify(configuration)).digest('hex')
}
function safeError(error:unknown):{last_error:string;errorKind:NonNullable<RuntimeEntry['errorKind']>} {
 const text=error instanceof Error?error.message:''
 if(/\b(401|403)\b/.test(text))return {last_error:'MCP server 认证失败，请检查凭据',errorKind:'auth'}
 if(/timeout|timed out|超时/i.test(text))return {last_error:'连接 MCP server 超时',errorKind:'timeout'}
 if(text.includes('超出单个 server 上限'))return {last_error:'MCP server 工具数量超出上限，请配置工具白名单后重试',errorKind:'configuration'}
 if(text.includes('stdio MCP 会话数已达上限'))return {last_error:'MCP stdio 会话数已达上限，请稍后重试',errorKind:'configuration'}
 if(text.includes('stdio MCP 隔离运行能力不可用'))return {last_error:'MCP stdio 隔离运行能力不可用',errorKind:'configuration'}
 if(text.startsWith('MCP 缺少凭据值'))return {last_error:'MCP 缺少凭据值，请填写凭据后重试',errorKind:'configuration'}
 if(text.startsWith('MCP 凭据不得放入 URL'))return {last_error:'MCP 凭据不得放入 URL；请改用 Header 凭据槽位',errorKind:'configuration'}
 if(text.startsWith('MCP endpoint 无效'))return {last_error:'MCP endpoint 无效',errorKind:'configuration'}
 return {last_error:'无法连接 MCP server，请检查地址与网络',errorKind:'network'}
}
function extractText(value:unknown):string {
 if(!value||typeof value!=='object'||Array.isArray(value))return ''
 const content=(value as Record<string,unknown>).content
 if(!Array.isArray(content))return ''
 const parts:string[]=[]
 for(const block of content){
  if(!block||typeof block!=='object'||Array.isArray(block))continue
  if((block as Record<string,unknown>).type==='text'){
   const text=(block as Record<string,unknown>).text
   const normalized=typeof text==='string'?text:String(text??'')
   if(normalized)parts.push(normalized)
  }else{
   try{const encoded=JSON.stringify(block);if(encoded)parts.push(encoded)}catch{parts.push('[无法读取的 MCP 内容]')}
  }
 }
 const text=parts.join('\n')
 return text.length>20_000?`${text.slice(0,20_000)}\n…（结果过长已截断）`:text
}
function romanize(value:string){return pinyin(value,{toneType:'none',type:'array'}).join('')}
async function decryptedObject(decrypt:EnvelopeReader,row:McpStoredServer,prefix:'credentials'|'headers'){
 const ciphertext=row[`encrypted_${prefix}`]
 if(!ciphertext)return {}
 const result=JSON.parse(await decrypt.decrypt({ciphertext,nonce:row[`${prefix}_nonce`],encryptedDataKey:row[`encrypted_${prefix}_key`],keyVersion:row[`${prefix}_key_version`]}))
 return result&&typeof result==='object'&&!Array.isArray(result)?Object.fromEntries(Object.entries(result).filter((entry):entry is [string,string]=>typeof entry[1]==='string')):{}
}
async function headersFor(decrypt:EnvelopeReader,row:McpStoredServer){
 const slots=normalizeMcpSlots(Array.isArray(row.credential_slots)?row.credential_slots.filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)):[])
 const values=await decryptedObject(decrypt,row,'credentials'),validated=validateMcpCredentialValues(slots,values),headers:Record<string,string>={}
 for(const slot of slots){const value=validated[slot.id];if(value===undefined)throw new Error('MCP 缺少凭据值');if(slot.target==='query')throw new Error('MCP 凭据不得放入 URL');headers[slot.name]=slot.prefix+value}
 if(row.encrypted_headers)Object.assign(headers,await decryptedObject(decrypt,row,'headers'))
 if(row.encrypted_query_params)throw new Error('MCP 凭据不得放入 URL')
 return headers
}

/** Host 持有进程内连接状态；配置与工具语义来自 owner scoped Core 配置和共享 schema 规则。 */
export function createMcpRuntime(options:{
 configs(owner:string):Promise<readonly McpStoredServer[]>;enabled:()=>boolean|Promise<boolean>;maxTools:number|(()=>number)
 decrypt:EnvelopeReader;transport():ProviderTransport;builtinNames(owner:string):Promise<ReadonlySet<string>>
 client?:(input:Parameters<typeof createMcpHttpClient>[0])=>RuntimeClient
 stdioClient?:(input:{owner:string;command:string;timeoutSeconds:number})=>Promise<RuntimeClient>|RuntimeClient
}){
 const entries=new Map<string,RuntimeEntry>(),locks=new Map<string,Promise<RuntimeEntry>>(),versions=new Map<string,number>()
 const key=(owner:string,id:string)=>`${owner}\u0000${id}`
 const version=(entryKey:string)=>versions.get(entryKey)??0
 const staleEntry=(fingerprint:string):RuntimeEntry=>({state:'error',tools:[],last_error:'MCP 配置已变更，请重试',configFingerprint:fingerprint,errorKind:'configuration'})
 async function rowFor(owner:string,id:string){const row=(await options.configs(owner)).find(item=>item.id===id);if(!row)throw Object.assign(new Error('MCP server 不存在'),{statusCode:404});return row}
 async function closeEntry(entry:RuntimeEntry){await entry.client?.close().catch(()=>{});await entry.transport?.close?.().catch(()=>{})}
 function state(owner:string,id:string){const entry=entries.get(key(owner,id));return entry?{server_id:id,state:entry.state,loaded_tool_count:entry.state==='ok'?entry.tools.length:0,loaded_tool_names:entry.state==='ok'?entry.tools.map(tool=>tool.name).sort():[],last_error:entry.last_error}:{server_id:id,state:'unloaded',loaded_tool_count:0,loaded_tool_names:[],last_error:null}}
 async function loadWithDiagnosis(owner:string,id:string){
  const entryKey=key(owner,id),startingVersion=version(entryKey)
  const row=await rowFor(owner,id),fingerprint=configFingerprint(row)
  if(version(entryKey)!==startingVersion)return statusResult(staleEntry(fingerprint))
  if(!row.enabled||!(await options.enabled())){const previous=entries.get(entryKey);if(previous){entries.delete(entryKey);await closeEntry(previous)}return {ok:false as const,state:'disabled' as const,tool_count:0,tool_names:[] as string[],error:null,errorKind:null}}
  const cached=entries.get(entryKey)
  if(cached?.state==='ok'&&cached.configFingerprint===fingerprint&&cached.client?.isOpen?.()!==false)return statusResult(cached)
  if(cached)entries.delete(entryKey)
  if(cached)await closeEntry(cached)
  if(row.transport!=='http'&&row.transport!=='stdio'){
   const entry:RuntimeEntry={state:'error',tools:[],last_error:'MCP transport 配置无效',configFingerprint:fingerprint,errorKind:'configuration'};entries.set(entryKey,entry)
   return statusResult(entry)
  }
  const pending=locks.get(entryKey);if(pending){const result=await pending;if(version(entryKey)!==startingVersion||result.configFingerprint!==fingerprint)return loadWithDiagnosis(owner,id);return statusResult(result)}
  const work=(async():Promise<RuntimeEntry>=>{
   let transport:ProviderTransport|undefined,client:RuntimeClient|undefined
   try{
    if(row.transport==='stdio'){
     if(!row.command.trim()||!options.stdioClient)throw new Error('stdio MCP 隔离运行能力不可用')
     client=await options.stdioClient({owner,command:row.command,timeoutSeconds:Math.max(1,Math.min(300,row.timeout_seconds))})
    }else{
     const endpoint=row.encrypted_endpoint?await options.decrypt.decrypt({ciphertext:row.encrypted_endpoint,nonce:row.endpoint_nonce,encryptedDataKey:row.encrypted_endpoint_key,keyVersion:row.endpoint_key_version}):row.endpoint
     transport=options.transport()
     client=(options.client??(input=>createMcpHttpClient(input)))({endpoint,headers:await headersFor(options.decrypt,row),fetch:createMcpSafeFetch(transport,{timeoutMs:Math.max(1000,Math.min(300_000,row.timeout_seconds*1000))})})
    }
    await client.connect()
    const raw=(await client.listTools()).tools,allowlist=new Set(Array.isArray(row.tool_allowlist)?row.tool_allowlist.filter((item):item is string=>typeof item==='string'):[]),builtin=await options.builtinNames(owner),seen=new Set<string>(),tools:RuntimeTool[]=[]
    for(const value of raw){
     if(!value||typeof value!=='object'||Array.isArray(value))continue
     const tool=value as Record<string,unknown>,toolName=typeof tool.name==='string'?tool.name.trim():''
     if(!toolName||validateInputSchema(tool.inputSchema)!==null)continue
     const name=prefixedToolName(row.name,toolName,romanize)
     if(!name||builtin.has(name)||seen.has(name)||(allowlist.size&&!allowlist.has(toolName)))continue
     seen.add(name);tools.push({name,tool_name:toolName,description:descriptionForProvider(typeof tool.description==='string'?tool.description:null,`${row.name} MCP 工具：${toolName}`),description_short:descriptionShortOf(typeof tool.description==='string'?tool.description:null)||`${row.name} MCP 工具：${toolName}`,input_schema:sanitizeInputSchema(tool.inputSchema)})
    }
    const max=typeof options.maxTools==='function'?options.maxTools():options.maxTools
    if(tools.length>max)throw new Error('MCP server 工具数量超出单个 server 上限')
    if(version(entryKey)!==startingVersion){await client.close().catch(()=>{});await transport?.close?.().catch(()=>{});return staleEntry(fingerprint)}
    const loaded:RuntimeEntry={state:'ok',tools,last_error:null,configFingerprint:fingerprint,client,transport};entries.set(entryKey,loaded);return loaded
   }catch(error){await client?.close().catch(()=>{});await transport?.close?.().catch(()=>{});const failed:RuntimeEntry={state:'error',tools:[],...safeError(error),configFingerprint:fingerprint};if(version(entryKey)===startingVersion)entries.set(entryKey,failed);return version(entryKey)===startingVersion?failed:staleEntry(fingerprint)}
  })()
  locks.set(entryKey,work)
  try{return statusResult(await work)}finally{locks.delete(entryKey)}
 }
 function statusResult(entry:RuntimeEntry){return {ok:entry.state==='ok',state:entry.state,tool_count:entry.state==='ok'?entry.tools.length:0,tool_names:entry.state==='ok'?entry.tools.map(tool=>tool.name).sort():[],error:entry.last_error,errorKind:entry.errorKind??null}}
 async function load(owner:string,id:string){
  const {errorKind:_errorKind,...result}=await loadWithDiagnosis(owner,id)
  return result
 }
 async function reconnect(owner:string,id:string){
  await invalidate(owner,id)
  const result=await load(owner,id)
  return {...result,total_loaded:result.ok?result.tool_count:0}
 }
 /** 探测的是已保存且启用的 owner 配置，只执行握手及工具发现。 */
 async function testConnection(owner:string,id:string,signal:AbortSignal){
  signal.throwIfAborted()
  await rowFor(owner,id)
  signal.throwIfAborted()
  await invalidate(owner,id)
  signal.throwIfAborted()
  const result=await loadWithDiagnosis(owner,id)
  signal.throwIfAborted()
  return result.ok ? {ok:true as const,toolNames:result.tool_names} : {ok:false as const,errorKind:result.errorKind}
 }
 async function dispatchForAgent(owner:string,id:string,name:string,args:unknown,signal?:AbortSignal,authorize?:(row:McpStoredServer)=>Promise<boolean>):Promise<{result:string;executed?:false}|{error:string;executed?:boolean}|{uncertain:true}>{
  let row:McpStoredServer
  try{row=await rowFor(owner,id)}catch(error){if(Number((error as {statusCode?:unknown})?.statusCode)===404)return {error:'MCP 工具不可用，请重新加载工具目录',executed:false};throw error}
  if(!row.enabled||!(await options.enabled()))return {error:'MCP 工具不可用，请重新加载工具目录',executed:false}
  signal?.throwIfAborted()
  const loaded=await load(owner,id)
  signal?.throwIfAborted()
  if(!loaded.ok)return {error:loaded.error??'MCP server 不可用',executed:false}
  const entry=entries.get(key(owner,id)),tool=entry?.tools.find(item=>item.name===name)
  if(!entry||entry.state!=='ok'||!entry.client||!tool)return {error:'MCP 工具不可用，请重新加载工具目录',executed:false}
  const validated=validateInputArguments(tool.name,tool.input_schema,args)
  if(!validated.success)return {result:JSON.stringify(validated.error),executed:false}
  if(authorize){
   // 连接、发现和校验均可能等待；只在最新配置和任务授权仍有效时发送 tools/call。
   try{
    const current=await rowFor(owner,id)
    if(!current.enabled||configFingerprint(current)!==entry.configFingerprint||!await options.enabled()
     ||!await authorize(current)||entries.get(key(owner,id))!==entry)
     return {error:'当前定时任务无权调用该 MCP 工具',executed:false}
   }catch{signal?.throwIfAborted();return {error:'当前定时任务无权调用该 MCP 工具',executed:false}}
   signal?.throwIfAborted()
  }
  let response:unknown
  try{
   response=await entry.client.callTool(tool.tool_name,validated.data,{signal,timeout:Math.max(1000,Math.min(300_000,row.timeout_seconds*1000))})
  }catch{
   signal?.throwIfAborted()
   // 外部请求已开始，超时/断连不能证明 server 未提交副作用；Agent Harness 收到 unknown 后不得重放。
   return {uncertain:true}
  }
  try{
   signal?.throwIfAborted()
   if(response&&typeof response==='object'&&!Array.isArray(response)&&(response as Record<string,unknown>).isError===true){
    return {error:extractText(response).slice(0,2000)||'MCP 工具执行失败',executed:true}
   }
   return {result:extractText(response)}
  }catch(error){
   signal?.throwIfAborted()
   // tools/call 已返回，若结果投影本身失败也不能把可能已执行的外部操作当作安全重试。
   return {uncertain:true}
  }
 }
 async function dispatch(owner:string,id:string,name:string,args:unknown,signal?:AbortSignal):Promise<{result:string}|{error:string}>{
  const result=await dispatchForAgent(owner,id,name,args,signal)
  if('uncertain' in result)return {error:'MCP 工具结果不确定，请检查服务端状态后再决定是否重试'}
  if('error' in result)return {error:result.error}
  return {result:result.result}
 }
 async function invalidate(owner:string,id:string){const entryKey=key(owner,id);versions.set(entryKey,version(entryKey)+1);const entry=entries.get(entryKey);entries.delete(entryKey);if(entry)await closeEntry(entry);await locks.get(entryKey)?.catch(()=>{})}
 async function close(){for(const entryKey of new Set([...entries.keys(),...locks.keys()]))versions.set(entryKey,version(entryKey)+1);const pending=[...locks.values()],current=[...entries.values()];entries.clear();await Promise.all([...current.map(closeEntry),...pending.map(work=>work.then(()=>undefined,()=>undefined))])}
 async function tools(owner:string,id:string){
  const entryKey=key(owner,id)
  await rowFor(owner,id)
  await locks.get(entryKey)?.catch(()=>{})
  const row=await rowFor(owner,id),entry=entries.get(entryKey)
  if(entry&&entry.configFingerprint!==configFingerprint(row))await invalidate(owner,id)
  return state(owner,id)
 }
 return {load,reconnect,testConnection,dispatch,dispatchForAgent,tools,state,invalidate,close}
}
