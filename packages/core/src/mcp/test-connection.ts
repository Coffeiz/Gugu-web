import {CoreError} from '../contracts/index.js'
import {validateInputSchema} from './schema-adapter.js'

/** 将 MCP tools/list 结果裁成配置页可展示的原始工具名。 */
export function filterMcpConnectionTools(rawTools:unknown,options:{maxTools:number;allowlist?:readonly string[]}):string[]{
 if(!Number.isSafeInteger(options.maxTools)||options.maxTools<0)throw new TypeError('MCP 工具数量上限无效')
 if(!Array.isArray(rawTools))return []
 const allowlist=new Set(options.allowlist??[]),seen=new Set<string>(),accepted:string[]=[]
 for(const raw of rawTools){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))continue
  const item=raw as Record<string,unknown>,name=typeof item.name==='string'?item.name:''
  if(!name||validateInputSchema(item.inputSchema)!==null||!/^[A-Za-z0-9_]+$/.test(name)||seen.has(name))continue
  if(allowlist.size&&!allowlist.has(name))continue
  seen.add(name);accepted.push(name)
 }
 if(accepted.length>options.maxTools)throw new CoreError('invalid_request',`MCP server 工具数量 ${accepted.length} 超出单个 server 上限 ${options.maxTools}，请配置工具白名单后重试`)
 return accepted
}
