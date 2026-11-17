import {sql,type Kysely} from 'kysely'
import {dataContext} from '../contracts/index.js'
import {mcpJsonArray,mcpOwnerKey,type McpDatabaseBackend} from './storage.js'

export interface McpStoredServer {
 id:string;name:string;scope:string;transport:string;endpoint:string;encrypted_endpoint:string;endpoint_nonce:string;encrypted_endpoint_key:string;endpoint_key_version:number;command:string
 credential_slots:unknown;encrypted_credentials:string;credentials_nonce:string;encrypted_credentials_key:string;credentials_key_version:number
 encrypted_headers:string;headers_nonce:string;encrypted_headers_key:string;headers_key_version:number;encrypted_query_params:string;query_params_nonce:string;encrypted_query_params_key:string;query_params_key_version:number
 enabled:boolean;confirm_mode:string;timeout_seconds:number;tool_allowlist:unknown;created_at:Date|string|null;updated_at:Date|string|null
}
/** 只读取认证 owner 的 MCP 配置；不触发任何外部连接或运行时状态发现。 */
export function createMcpServerConfigLister<DB>(db:Kysely<DB>,backend:McpDatabaseBackend='postgres'){
 return async(rawOwner:string,connection:Kysely<DB>=db):Promise<McpStoredServer[]>=>{
  const owner=mcpOwnerKey(dataContext(rawOwner).ownerId,backend)
  const rows=backend==='postgres'
   ? await sql<McpStoredServer>`SELECT id::text AS id,name,scope,transport,endpoint,encrypted_endpoint,endpoint_nonce,encrypted_endpoint_key,endpoint_key_version,command,credential_slots,encrypted_credentials,credentials_nonce,encrypted_credentials_key,credentials_key_version,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at,updated_at::text AS updated_at FROM user_mcp_servers WHERE user_id=${owner} AND scope='user' ORDER BY created_at`.execute(connection)
   : await sql<McpStoredServer>`SELECT id,name,scope,transport,endpoint,encrypted_endpoint,endpoint_nonce,encrypted_endpoint_key,endpoint_key_version,command,credential_slots,encrypted_credentials,credentials_nonce,encrypted_credentials_key,credentials_key_version,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at,updated_at FROM user_mcp_servers WHERE user_id=${owner} AND scope='user' ORDER BY created_at`.execute(connection)
  return rows.rows.map(row=>backend==='sqlite'?{
   ...row,
   credential_slots:mcpJsonArray<Record<string,unknown>>(row.credential_slots),
   tool_allowlist:mcpJsonArray<string>(row.tool_allowlist),
  }:row)
 }
}
