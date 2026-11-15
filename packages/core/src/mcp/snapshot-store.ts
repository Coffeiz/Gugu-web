import {sql,type Kysely} from 'kysely'
import {dataContext} from '../contracts/index.js'
import type {McpDirectoryTool} from './tool-directory.js'
/** 用户隔离的完整MCP声明快照；凭据及endpoint不属于快照。 */
export function createMcpSnapshotStore<DB>(db:Kysely<DB>,backend:'postgres'|'sqlite',currentDigest:(owner:string,db:Kysely<DB>)=>Promise<string>){
 const keyFor=(owner:string)=>backend==='sqlite'?owner.replaceAll('-',''):owner
 const read=async(raw:string)=>{
  const owner=dataContext(raw).ownerId,key=keyFor(owner)
  const row=(await sql<{config_digest:string;schemas:unknown}>`SELECT config_digest,schemas FROM user_mcp_tool_schema_snapshots WHERE user_id=${key}`.execute(db)).rows[0]
  if(!row)return null
  const schemas=typeof row.schemas==='string'?JSON.parse(row.schemas):row.schemas
  if(!Array.isArray(schemas))throw new Error('MCP 声明快照格式无效')
  return {digest:row.config_digest,tools:schemas as McpDirectoryTool[]}
 }
 const writeIfCurrent=async(raw:string,digest:string,tools:readonly McpDirectoryTool[])=>{
  const owner=dataContext(raw).ownerId,key=keyFor(owner)
  await db.transaction().execute(async tx=>{
   if(await currentDigest(owner,tx)!==digest)return
   await sql`INSERT INTO user_mcp_tool_schema_snapshots(user_id,config_digest,schemas,refreshed_at) VALUES(${key},${digest},${JSON.stringify(tools)},CURRENT_TIMESTAMP) ON CONFLICT(user_id) DO UPDATE SET config_digest=excluded.config_digest,schemas=excluded.schemas,refreshed_at=excluded.refreshed_at`.execute(tx)
  })
 }
 return {read,writeIfCurrent}
}
