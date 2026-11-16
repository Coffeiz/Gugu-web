import {createHash} from 'node:crypto'
import {pinyin} from 'pinyin-pro'
import {createMcpToolDirectory,type McpDirectoryTool} from '@gugu/core/mcp/tool-directory'
import {createMcpSnapshotStore} from '@gugu/core/mcp/snapshot-store'
import {mcpConfigDigestPayload} from '@gugu/core/mcp/config-digest'
import {descriptionForProvider,descriptionShortOf,prefixedToolName,sanitizeInputSchema,validateInputSchema} from '@gugu/core/mcp/schema-adapter'
import {normalizeMcpSlots,validateMcpCredentialValues} from '@gugu/core/mcp/server-config'
import {createMcpServerConfigLister,type McpStoredServer} from '@gugu/core/mcp/server-list'
import type {ProviderTransport} from '@gugu/core/providers'
import {createMcpHttpClient} from './sdk-client.js'
import {createMcpSafeFetch} from './safe-fetch.js'

interface McpEnvelopeDecrypt {decrypt(input:{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}):Promise<string>}
interface McpClient {
 connect():Promise<void>
 listTools():Promise<{tools:unknown[]}>
 close():Promise<void>
}
interface DirectoryPorts {
 configs(owner:string):Promise<readonly McpStoredServer[]>
 read(owner:string):Promise<{digest:string;tools:readonly McpDirectoryTool[]}|null>
 writeIfCurrent(owner:string,digest:string,tools:readonly McpDirectoryTool[]):Promise<void>
}
type ClientFactory=(input:{endpoint:string;headers:Readonly<Record<string,string>>;fetch:typeof fetch})=>McpClient

function sha256(value:string):string{return createHash('sha256').update(value).digest('hex')}
function chinesePinyin(value:string):string{return pinyin(value,{toneType:'none',type:'array'}).join('')}
function timestamp(value:Date|string|null):string{
 if(value===null)return ''
 const raw=value instanceof Date?value.toISOString().replace(/Z$/,'+00:00'):value
 return raw.includes('T')?raw.replace(/Z$/,'+00:00'):raw.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00')
}
function digest(configs:readonly McpStoredServer[]):string{
 return sha256(mcpConfigDigestPayload(configs.map(row=>({
  id:row.id,name:row.name,transport:row.transport,
  updated_at:timestamp(row.updated_at),
  allowlist:Array.isArray(row.tool_allowlist)?row.tool_allowlist.filter((item):item is string=>typeof item==='string'):[],
 }))))
}
async function decryptJson(decrypt:McpEnvelopeDecrypt,row:McpStoredServer,prefix:'credentials'|'headers'):
 Promise<Record<string,string>>{
 const ciphertext=row[`encrypted_${prefix}`]
 if(!ciphertext)return {}
 const raw=await decrypt.decrypt({ciphertext,nonce:row[`${prefix}_nonce`],encryptedDataKey:row[`encrypted_${prefix}_key`],keyVersion:row[`${prefix}_key_version`]})
 const value=JSON.parse(raw)
 return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter((item):item is [string,string]=>typeof item[1]==='string')):{}
}
async function authHeaders(decrypt:McpEnvelopeDecrypt,row:McpStoredServer):Promise<Record<string,string>>{
 const slots=normalizeMcpSlots(Array.isArray(row.credential_slots)?row.credential_slots.filter((value):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)):[])
 const values=await decryptJson(decrypt,row,'credentials')
 const validated=validateMcpCredentialValues(slots,values),headers:Record<string,string>={}
 for(const slot of slots){
  const value=validated[slot.id]
  if(value===undefined)throw new Error('MCP 缺少凭据值')
  if(slot.target==='query')throw new Error('MCP 查询参数凭据不允许用于工具发现')
  headers[slot.name]=slot.prefix+value
 }
 if(row.encrypted_headers){
  const legacy=await decryptJson(decrypt,row,'headers')
  for(const [name,value]of Object.entries(legacy))headers[name]=value
 }
 if(row.encrypted_query_params)throw new Error('MCP 查询参数凭据不允许用于工具发现')
 return headers
}

async function discoverServer(input:{
 row:McpStoredServer;decrypt:McpEnvelopeDecrypt;transport():ProviderTransport;maxTools:number
 romanize(value:string):string;builtinNames:ReadonlySet<string>;client:ClientFactory
}):Promise<{tools:McpDirectoryTool[];complete:boolean}> {
 const {row}=input
 if(!row.enabled)return {tools:[],complete:true}
 if(row.transport!=='http')return {tools:[],complete:false}
 let transport:ProviderTransport|undefined,client:McpClient|undefined
 try{
  const endpoint=row.encrypted_endpoint?await input.decrypt.decrypt({ciphertext:row.encrypted_endpoint,nonce:row.endpoint_nonce,encryptedDataKey:row.encrypted_endpoint_key,keyVersion:row.endpoint_key_version}):row.endpoint
  const headers=await authHeaders(input.decrypt,row)
  transport=input.transport()
  client=input.client({endpoint,headers,fetch:createMcpSafeFetch(transport,{timeoutMs:Math.max(1000,Math.min(300_000,row.timeout_seconds*1000))})})
  await client.connect()
  const rawTools=(await client.listTools()).tools
  const allowlist=new Set(Array.isArray(row.tool_allowlist)?row.tool_allowlist.filter((item):item is string=>typeof item==='string'):[])
  const seen=new Set<string>(),accepted:McpDirectoryTool[]=[]
  for(const raw of rawTools){
   if(!raw||typeof raw!=='object'||Array.isArray(raw))continue
   const item=raw as Record<string,unknown>,toolName=typeof item.name==='string'?item.name.trim():''
   if(!toolName||validateInputSchema(item.inputSchema)!==null)continue
   const name=prefixedToolName(row.name,toolName,input.romanize)
   if(!name||input.builtinNames.has(name)||seen.has(name)||(allowlist.size&&!allowlist.has(toolName)))continue
   seen.add(name);accepted.push({
    name,description_short:descriptionShortOf(typeof item.description==='string'?item.description:null)||`${row.name} MCP 工具：${toolName}`,
    description:descriptionForProvider(typeof item.description==='string'?item.description:null,`${row.name} MCP 工具：${toolName}`),
    input_schema:sanitizeInputSchema(item.inputSchema),server_id:row.id,server_name:row.name,tool_name:toolName,
   })
  }
  if(accepted.length>input.maxTools)return {tools:[],complete:false}
  return {tools:accepted,complete:true}
 }catch{
  // MCP 配置与服务端响应属于不可信输入；此目录只返回空的失败结果，不向 API 暴露异常文本。
  return {tools:[],complete:false}
 }finally{
  await client?.close().catch(()=>{})
  await transport?.close?.().catch(()=>{})
 }
}

/** 通过 owner 配置、密文解包、受控出站及 Core 的 owner 快照目录发现 Skill 可关联的 MCP 工具。 */
export function createMcpSkillToolDirectory<DB>(database:DB,options:{
 enabled:()=>boolean|Promise<boolean>;decrypt:McpEnvelopeDecrypt;transport():ProviderTransport;maxTools:number|(()=>number)
 romanize?(value:string):string;builtinNames(owner:string):Promise<ReadonlySet<string>>
 configs?:DirectoryPorts['configs'];ports?:DirectoryPorts
 client?:ClientFactory
}): (owner:string)=>Promise<McpDirectoryTool[]> {
 const db=database as never
 const lister=createMcpServerConfigLister(db)
 const listConfigs=options.configs??(owner=>lister(owner))
 const snapshot=options.ports??createMcpSnapshotStore(db,'postgres',async(owner,connection)=>digest((await (options.configs?options.configs(owner):lister(owner,connection))).filter(row=>row.enabled)))
 const client=options.client??(input=>createMcpHttpClient(input))
 return createMcpToolDirectory({
  enabled:options.enabled,
  configs:async owner=>(await listConfigs(owner)).filter(row=>row.enabled),
  digest,
  read:snapshot.read,
  writeIfCurrent:snapshot.writeIfCurrent,
  async discover(owner,configs){
   const builtinNames=await options.builtinNames(owner),maxTools=typeof options.maxTools==='function'?options.maxTools():options.maxTools
   const results=await Promise.all(configs.map(row=>discoverServer({row,decrypt:options.decrypt,transport:options.transport,maxTools,romanize:options.romanize??chinesePinyin,builtinNames,client})))
   const seen=new Set<string>(),tools=results.flatMap(result=>result.tools).filter(tool=>{
    if(seen.has(tool.name))return false
    seen.add(tool.name);return true
   })
   return {tools,complete:results.every(result=>result.complete)}
  },
 })
}
