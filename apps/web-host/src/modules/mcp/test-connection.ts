import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {filterMcpConnectionTools} from '@gugu/core/mcp/test-connection'
import {normalizeMcpSlots,validateMcpCredentialValues} from '@gugu/core/mcp/server-config'
import {createMcpHttpClient} from '@gugu/core/mcp/sdk-client'
import {createMcpSafeFetch} from '@gugu/core/mcp/safe-fetch'
import type {ProviderTransport} from '@gugu/core/providers'

export interface McpConnectionTestOptions {
 requireUser:preHandlerHookHandler
 ownerIdFromRequest(request:FastifyRequest):string
 test(owner:string,serverId:string):Promise<{ok:true;tool_count:number;tools:string[]}|{ok:false;error:string;tools:[];error_kind?:string;retryable?:boolean;next_action?:string}>
}

/** HTTP/SSE 接线和 Python 连接测试 DTO；连接失败作为可展示结果返回 200。 */
export function registerMcpConnectionTestRoute(app:FastifyInstance,options:McpConnectionTestOptions):void{
 app.post<{Params:{server_id:string}}>('/api/v1/mcp/servers/:server_id/test_connection',{preHandler:options.requireUser},async(request,reply)=>{
  try{return await options.test(options.ownerIdFromRequest(request),request.params.server_id)}
  catch(error){
   const status=Number((error as {statusCode?:unknown})?.statusCode)
   if(status===404)return reply.code(404).send({detail:'MCP server 不存在'})
   throw error
  }
 })
}

interface McpConnectionRow {
 id:string;transport:string;endpoint:string;encrypted_endpoint:string;endpoint_nonce:string;encrypted_endpoint_key:string;endpoint_key_version:number
 command:string;credential_slots:unknown;encrypted_credentials:string;credentials_nonce:string;encrypted_credentials_key:string;credentials_key_version:number
 encrypted_headers:string;headers_nonce:string;encrypted_headers_key:string;headers_key_version:number
 encrypted_query_params:string;query_params_nonce:string;encrypted_query_params_key:string;query_params_key_version:number
 tool_allowlist:unknown;timeout_seconds:number;name:string
}
export interface McpEnvelopeDecrypt {decrypt(input:{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}):Promise<string>}
/** PG owner 配置读取、受控 HTTP/stdio 握手与工具发现；凭据不会进入 endpoint 或可见错误。 */
interface McpStdioTestClient {
 connect():Promise<void>
 listTools():Promise<{tools:unknown[]}>
 close():Promise<void>
}

export function createPostgresMcpConnectionTester<DB>(database:DB,options:{decrypt:McpEnvelopeDecrypt;transport():ProviderTransport;maxTools:number|(()=>number);client?:(input:Parameters<typeof createMcpHttpClient>[0])=>ReturnType<typeof createMcpHttpClient>;stdioClient?:(input:{owner:string;command:string;timeoutSeconds:number})=>Promise<McpStdioTestClient>}){
 const db=database as {selectFrom:(table:any)=>any}
 return async(owner:string,serverId:string)=>{
  const row=await db.selectFrom('user_mcp_servers').select(['id','name','transport','endpoint','encrypted_endpoint','endpoint_nonce','encrypted_endpoint_key','endpoint_key_version','command','credential_slots','encrypted_credentials','credentials_nonce','encrypted_credentials_key','credentials_key_version','encrypted_headers','headers_nonce','encrypted_headers_key','headers_key_version','encrypted_query_params','query_params_nonce','encrypted_query_params_key','query_params_key_version','tool_allowlist','timeout_seconds']).where('id','=',serverId).where('user_id','=',owner).where('scope','=','user').executeTakeFirst() as McpConnectionRow|undefined
  if(!row)throw Object.assign(new Error('MCP server 不存在'),{statusCode:404})
  let transport:ProviderTransport|undefined,client:ReturnType<typeof createMcpHttpClient>|undefined,stdioClient:McpStdioTestClient|undefined
  try{
   if(row.transport==='stdio'){
    if(!options.stdioClient)throw new Error('MCP stdio 隔离运行能力不可用')
    if(!row.command)throw new Error('MCP stdio 启动命令无效')
    stdioClient=await options.stdioClient({owner,command:row.command,timeoutSeconds:row.timeout_seconds})
    await stdioClient.connect()
    const tools=filterMcpConnectionTools((await stdioClient.listTools()).tools,{maxTools:typeof options.maxTools==='function'?options.maxTools():options.maxTools,allowlist:Array.isArray(row.tool_allowlist)?row.tool_allowlist.filter((item):item is string=>typeof item==='string'):[]})
    return {ok:true as const,tool_count:tools.length,tools:tools.slice(0,64)}
   }
   const endpoint=row.encrypted_endpoint?await options.decrypt.decrypt({ciphertext:row.encrypted_endpoint,nonce:row.endpoint_nonce,encryptedDataKey:row.encrypted_endpoint_key,keyVersion:row.endpoint_key_version}):row.endpoint
   const slots=normalizeMcpSlots(Array.isArray(row.credential_slots)?row.credential_slots as Array<Record<string,unknown>>:[])
   let values:Record<string,string>={}
   if(row.encrypted_credentials){const decoded=JSON.parse(await options.decrypt.decrypt({ciphertext:row.encrypted_credentials,nonce:row.credentials_nonce,encryptedDataKey:row.encrypted_credentials_key,keyVersion:row.credentials_key_version}));if(decoded&&typeof decoded==='object'&&!Array.isArray(decoded))values=Object.fromEntries(Object.entries(decoded).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))}
   const validatedValues=validateMcpCredentialValues(slots,values),headers:Record<string,string>={}
   for(const slot of slots){const value=validatedValues[slot.id]
    if(value===undefined)throw new Error('MCP 缺少凭据值，请填写凭据后重试')
    if(slot.target==='query')throw new Error('MCP 凭据不得放入 URL；请改用 Header 凭据槽位')
    headers[slot.name]=slot.prefix+value
   }
   if(row.encrypted_headers){const raw=await options.decrypt.decrypt({ciphertext:row.encrypted_headers,nonce:row.headers_nonce,encryptedDataKey:row.encrypted_headers_key,keyVersion:row.headers_key_version}),legacy=JSON.parse(raw);if(legacy&&typeof legacy==='object'&&!Array.isArray(legacy))for(const [name,value] of Object.entries(legacy))if(typeof value==='string')headers[name]=value}
   if(row.encrypted_query_params)throw new Error('MCP 凭据不得放入 URL；请改用 Header 凭据槽位')
   transport=options.transport();client=(options.client??createMcpHttpClient)({endpoint,headers,fetch:createMcpSafeFetch(transport,{timeoutMs:Math.max(1000,Math.min(300_000,row.timeout_seconds*1000))})})
   await client.connect()
   const rawTools=(await client.listTools()).tools
   const allowlist=Array.isArray(row.tool_allowlist)?row.tool_allowlist.filter((item):item is string=>typeof item==='string'):[]
   const maxTools=typeof options.maxTools==='function'?options.maxTools():options.maxTools
   const tools=filterMcpConnectionTools(rawTools,{maxTools,allowlist})
   return {ok:true as const,tool_count:tools.length,tools:tools.slice(0,64)}
  }catch(error){
   const message=(error as {message?:unknown})?.message
   const text=typeof message==='string'?message:''
   const limit=text.includes('超出单个 server 上限')||text.includes('MCP stdio 会话数已达上限'),credentials=text.startsWith('MCP 凭据不得放入 URL'),missing=text.startsWith('MCP 缺少凭据值'),stdioUnavailable=text.startsWith('MCP stdio 隔离运行能力不可用')||text.startsWith('MCP stdio 启动命令无效'),configuration=credentials||missing||stdioUnavailable,timeout=/timeout|timed out|超时/i.test(text),auth=/\b(401|403)\b/.test(text)
   const safe=limit?text:credentials?text:missing?text:stdioUnavailable?text:auth?'MCP server 认证失败，请检查凭据':'无法连接 MCP server，请检查地址与网络'
   const kind=limit?'limit':configuration?'configuration':timeout?'timeout':auth?'auth':'network'
   return {ok:false as const,error:safe,tools:[] as [],error_kind:kind,retryable:['timeout','network'].includes(kind),next_action:limit?'请检查工具数量上限或稍后重试。':credentials?'请改用 Header 凭据槽位。':missing?'请填写 MCP server 凭据。':stdioUnavailable?'请检查 MCP stdio 沙盒与启动命令配置。':auth?'请检查 MCP server 凭据。':'请检查 MCP server 地址与网络。'}
  }finally{await stdioClient?.close().catch(()=>{});await client?.close().catch(()=>{});await transport?.close?.().catch(()=>{})}
 }
}
