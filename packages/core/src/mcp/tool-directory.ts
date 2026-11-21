import { prefixedToolName } from './schema-adapter.js'
import {dataContext} from '../contracts/index.js'
export interface McpDirectoryTool {name:string;description_short:string;description:string;input_schema:Record<string,unknown>;server_id:string;server_name:string;tool_name:string}
export interface McpToolLookup { server?: string; names?: readonly string[] }
export interface McpServiceSummary { name: string }

export function matchesMcpLookup(name: string, lookup: McpToolLookup, romanize: (value: string) => string): boolean {
 if (lookup.server && name.toLowerCase() !== lookup.server.trim().toLowerCase()) return false
 if (!lookup.names) return Boolean(lookup.server)
 const prefix = prefixedToolName(name, 'x', romanize)?.slice(0, -1)
 return Boolean(prefix && lookup.names.some(tool => tool.startsWith(prefix)))
}

export function mcpServiceReminder(services: readonly McpServiceSummary[]): string {
 if (!services.length) return ''
 const names = [...new Set(services.map(service => service.name))]
 return ['## 当前会话可用的 MCP 服务', JSON.stringify(names),
  '服务名仅用于选择服务。需要 MCP 时，用 search_tools 传 query 和 mcp_server 查找工具，再用 names 读取完整参数，最后用 call_tool 调用。已有当前版本的参数定义时可直接调用。'].join('\n')
}

export interface McpDirectoryPorts<Config> {
 enabled():boolean|Promise<boolean>
 configs(owner:string):Promise<readonly Config[]>
 select?(config:Config,lookup:McpToolLookup):boolean
 digest(configs:readonly Config[]):string
 read(owner:string):Promise<{digest:string;tools:readonly McpDirectoryTool[]}|null>
 discover(owner:string,configs:readonly Config[]):Promise<{tools:readonly McpDirectoryTool[];complete:boolean}>
 /** 写入时必须复核同一 owner 的配置摘要，避免并发修改覆盖新快照。 */
 writeIfCurrent(owner:string,digest:string,tools:readonly McpDirectoryTool[]):Promise<void>
}
/** 首次或配置变化时发现；任何 server 失败保留旧数据库快照以便下次重试。 */
export function createMcpToolDirectory<Config>(ports:McpDirectoryPorts<Config>){
 const scopedCache = new Map<string, { owner: string; digest: string; expires: number; tools: readonly McpDirectoryTool[] }>()
 return async(rawOwner:string,lookup?:McpToolLookup):Promise<McpDirectoryTool[]>=>{
  const owner=dataContext(rawOwner).ownerId
  if(!await ports.enabled())return []
  const configs=await ports.configs(owner),digest=ports.digest(configs),snapshot=await ports.read(owner)
  const matches=(tool:McpDirectoryTool)=>!lookup
    || ((!lookup.server || tool.server_name.toLowerCase()===lookup.server.trim().toLowerCase())
      && (!lookup.names || lookup.names.includes(tool.name)))
  if(snapshot?.digest===digest)return snapshot.tools.filter(matches).map(tool=>({...tool}))
  const selected=lookup ? configs.filter(config=>ports.select?.(config,lookup)) : configs
  if(!selected.length){
   if(!lookup || lookup.server || lookup.names)return []
   const cachedTools=new Map<string,McpDirectoryTool>()
   for(const entry of scopedCache.values()){
    if(entry.expires<=Date.now() || entry.owner!==owner || entry.digest!==digest)continue
    for(const tool of entry.tools)cachedTools.set(tool.name,tool)
   }
   return [...cachedTools.values()].map(tool=>({...tool}))
  }
  const key=JSON.stringify([owner,digest,ports.digest(selected)])
  const cached=lookup ? scopedCache.get(key) : undefined
  if(cached && cached.expires>Date.now())return cached.tools.filter(matches).map(tool=>({...tool}))
  const result=await ports.discover(owner,selected)
  if(!await ports.enabled() || ports.digest(await ports.configs(owner))!==digest)return []
  if(result.complete){
   if(selected.length===configs.length)await ports.writeIfCurrent(owner,digest,result.tools)
   else if(lookup){
    if(scopedCache.size>=128)scopedCache.delete(scopedCache.keys().next().value!)
    scopedCache.set(key,{owner,digest,expires:Date.now()+60_000,tools:result.tools})
   }
  }
  return result.tools.filter(matches).map(tool=>({...tool}))
 }
}
