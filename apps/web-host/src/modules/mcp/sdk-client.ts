import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface McpHttpClientOptions {
 endpoint:string
 fetch:typeof globalThis.fetch
 headers?:Readonly<Record<string,string>>
}

/** MCP HTTP 客户端只接受 Host 提供的受控 Fetch，凭据限于 Header。 */
export function createMcpHttpClient(options:McpHttpClientOptions){
 const url=new URL(options.endpoint)
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('MCP endpoint 无效')
 const transport=new StreamableHTTPClientTransport(url,{
  fetch:options.fetch as typeof fetch,
  requestInit:{redirect:'manual',headers:options.headers},
  redirectPolicy:'same-origin',
 })
 const client=new Client({name:'gugu-webui',version:'2.0.0'},{capabilities:{}})
 return {
  connect:()=>client.connect(transport),
  listTools:async()=>{
   const tools:unknown[]=[],seen=new Set<string>();let cursor:string|undefined
   for(let page=0;page<8;page++){
    const result=await client.listTools(cursor?{cursor}:undefined)
    tools.push(...result.tools)
    const next=result.nextCursor
    if(!next)return {tools}
    if(seen.has(next))throw new Error('MCP tools/list 分页游标重复')
    seen.add(next);cursor=next
   }
   if(cursor)throw new Error('MCP tools/list 分页超过上限')
   return {tools}
  },
  callTool:(name:string,args:Record<string,unknown>,options?:{signal?:AbortSignal;timeout?:number})=>client.callTool({name,arguments:args},undefined,options),
  close:()=>client.close(),
 }
}
