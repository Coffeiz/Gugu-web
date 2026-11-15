import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import type {McpStoredServer} from '@gugu/core/mcp/server-list'

interface EnvelopeReader {decrypt(input:{ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}):Promise<string>}
function timestamp(value:Date|string|null){return value instanceof Date?value.toISOString():value}
async function decryptJson(envelope:EnvelopeReader,row:McpStoredServer,prefix:'credentials'|'headers'|'query_params'){
 const ciphertext=row[`encrypted_${prefix}` as keyof McpStoredServer] as string
 if(!ciphertext)return {}
 try{const decoded=JSON.parse(await envelope.decrypt({ciphertext,nonce:row[`${prefix}_nonce` as keyof McpStoredServer] as string,encryptedDataKey:row[`encrypted_${prefix}_key` as keyof McpStoredServer] as string,keyVersion:row[`${prefix}_key_version` as keyof McpStoredServer] as number}));return decoded&&typeof decoded==='object'&&!Array.isArray(decoded)?Object.fromEntries(Object.entries(decoded).map(([key,value])=>[key,String(value)])):{}
 }catch{return {}}
}
function endpoint(row:McpStoredServer,envelope:EnvelopeReader){
 if(!row.encrypted_endpoint)return Promise.resolve(row.endpoint)
 return envelope.decrypt({ciphertext:row.encrypted_endpoint,nonce:row.endpoint_nonce,encryptedDataKey:row.encrypted_endpoint_key,keyVersion:row.endpoint_key_version}).catch(()=> '')
}
export function createMcpServerListReader(options:{list(owner:string):Promise<McpStoredServer[]>;decrypt:EnvelopeReader;settings():{enabled:unknown;max_servers_per_user:number}}){
 return async(owner:string)=>{
  const rows=await options.list(owner),items=[]
  for(const row of rows){
   const endpointValue=await endpoint(row,options.decrypt)
   let slots=Array.isArray(row.credential_slots)?row.credential_slots as Array<Record<string,unknown>>:[]
   let values=await decryptJson(options.decrypt,row,'credentials')
   if(!slots.length&&(row.encrypted_headers||row.encrypted_query_params)){
    const [headers,query]=await Promise.all([decryptJson(options.decrypt,row,'headers'),decryptJson(options.decrypt,row,'query_params')])
    const legacy=[...Object.entries(headers).map(([name,value])=>({target:'header',name,value})),...Object.entries(query).map(([name,value])=>({target:'query',name,value}))]
    if(legacy.length){slots=legacy.map((item,index)=>({id:`legacy_${item.target}_${index}`,label:item.name,target:item.target,name:item.name,prefix:''}));values=Object.fromEntries(legacy.map((item,index)=>[`legacy_${item.target}_${index}`,item.value]))}
   }
   let endpointHasCredential=false
   try{endpointHasCredential=[...new URL(endpointValue).searchParams.values()].some(value=>!value.includes('{{secret:'))}catch{}
   const configured=Boolean(row.encrypted_credentials||row.encrypted_headers||row.encrypted_query_params||Object.keys(values).length||endpointHasCredential)
   items.push({id:row.id,name:row.name,scope:row.scope,transport:row.transport,endpoint:endpointValue,command:row.command,credential_slots:slots,credential_values:values,credential_state:{configured,slot_ids:slots.filter(item=>item&&typeof item==='object').map(item=>String(item.id??''))},has_credentials:configured,enabled:Boolean(row.enabled),confirm_mode:row.confirm_mode,timeout_seconds:row.timeout_seconds,tool_allowlist:Array.isArray(row.tool_allowlist)?row.tool_allowlist:[],created_at:timestamp(row.created_at),state:'unloaded',loaded_tool_count:0,loaded_tool_names:[]})
  }
  const settings=options.settings()
  return {enabled:settings.enabled,max_servers:settings.max_servers_per_user,items}
 }
}
export interface McpServerListRouteOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;read(owner:string):Promise<unknown>}
export function registerMcpServerListRoute(app:FastifyInstance,options:McpServerListRouteOptions){app.get('/api/v1/mcp/servers',{preHandler:options.requireUser},request=>options.read(options.ownerIdFromRequest(request)))}
