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
  listTools:()=>client.listTools(),
  callTool:(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args}),
  close:()=>client.close(),
 }
}
