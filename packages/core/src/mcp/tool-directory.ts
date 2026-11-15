import {dataContext} from '../contracts/index.js'
export interface McpDirectoryTool {name:string;description_short:string;description:string;input_schema:Record<string,unknown>;server_id:string;server_name:string;tool_name:string}
export interface McpDirectoryPorts<Config> {
 enabled():boolean|Promise<boolean>
 configs(owner:string):Promise<readonly Config[]>
 digest(configs:readonly Config[]):string
 read(owner:string):Promise<{digest:string;tools:readonly McpDirectoryTool[]}|null>
 discover(owner:string,configs:readonly Config[]):Promise<{tools:readonly McpDirectoryTool[];complete:boolean}>
 /** 写入时必须复核同一 owner 的配置摘要，避免并发修改覆盖新快照。 */
 writeIfCurrent(owner:string,digest:string,tools:readonly McpDirectoryTool[]):Promise<void>
}
/** 首次或配置变化时发现；任何 server 失败保留旧数据库快照以便下次重试。 */
export function createMcpToolDirectory<Config>(ports:McpDirectoryPorts<Config>){
 return async(rawOwner:string):Promise<McpDirectoryTool[]>=>{
  const owner=dataContext(rawOwner).ownerId
  if(!await ports.enabled())return []
  const configs=await ports.configs(owner),digest=ports.digest(configs),snapshot=await ports.read(owner)
  if(snapshot?.digest===digest)return snapshot.tools.map(tool=>({...tool}))
  const result=await ports.discover(owner,configs)
  if(result.complete)await ports.writeIfCurrent(owner,digest,result.tools)
  return result.tools.map(tool=>({...tool}))
 }
}
