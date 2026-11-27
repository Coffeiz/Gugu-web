import {sql,type Kysely} from 'kysely'
import {CoreError,dataContext} from '../contracts/index.js'
type Group={records:number;bytes:number}
export interface DataExportPreview {categories:Record<string,Group>;format_version:string}
const owned=[
 ['preferences','user_preferences','user_id'],['projects','projects','user_id'],['clients','clients','user_id'],['workspaces','workspace_directories','user_id'],['mind','mind_maps','user_id'],['mind','mind_nodes','user_id'],['mind','mind_canvas_items','user_id'],['mind','mind_relations','user_id'],['calendar','calendar_events','user_id'],['workspaces','workspaces','user_id'],['conversations','conversation_sessions','user_id'],['feedback','feedbacks','user_id'],['scheduled_tasks','scheduled_tasks','user_id'],['drafts','conversation_pending_queues','user_id'],['im_memory','memory_entries','owner_user_id'],['connections','user_provider_credentials','user_id'],['connections','user_smtp_configs','user_id'],['connections','user_bots','user_id'],['connections','user_mcp_servers','user_id'],
] as const
const categories=['account','preferences','projects','clients','calendar','mind','feedback','workspaces','scheduled_tasks','conversations','drafts','connections','owner_memory','im_memory','archive_docs']
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function truthy(value:unknown):boolean{return value!==null&&value!==undefined&&value!==false&&value!==0&&value!==''&&(!Array.isArray(value)||value.length>0)&&(!object(value)||Object.keys(value).length>0)}
function iterable(value:unknown):unknown[]{if(!truthy(value))return [];if(Array.isArray(value))return value;if(typeof value==='string')return [...value];if(object(value))return Object.keys(value);throw new CoreError('storage_error','待发送草稿格式无效')}
function identity(value:unknown):string {
 if(value===true)return 'True';if(value===false)return 'False';if(value==null)return 'None'
 if(Array.isArray(value))return `[${value.map(item=>typeof item==='string'?JSON.stringify(item).replace(/^"|"$/g,"'"):identity(item)).join(', ')}]`
 if(object(value))return `{${Object.entries(value).map(([key,item])=>`'${key}': ${typeof item==='string'?`'${item}'`:identity(item)}`).join(', ')}}`
 return String(value)
}
function number(value:unknown):number{const result=Number(value??0);if(!Number.isFinite(result))throw new CoreError('storage_error','导出统计数据无效');return result}
/** 只统计归档范围，不生成身份、任务或文件；关联记录必须同时满足owner归属。 */
export function createDataExportPreviewReader<DB>(db:Kysely<DB>) {
 return async(ownerId:string):Promise<DataExportPreview>=>{
  const owner=dataContext(ownerId).ownerId,groups:Record<string,Group>=Object.fromEntries(categories.map(key=>[key,{records:0,bytes:0}]))
  for(const [category,table,column] of owned){const row=(await sql<{n:unknown}>`SELECT COUNT(*) AS n FROM ${sql.table(table)} WHERE ${sql.ref(column)}=${owner}`.execute(db)).rows[0];groups[category]!.records+=number(row?.n)}
  for(const table of ['conversation_messages','conversation_batches']){const row=(await sql<{n:unknown}>`SELECT COUNT(*) AS n FROM ${sql.table(table)} AS r JOIN conversation_sessions AS s ON s.id=r.session_id WHERE s.user_id=${owner}`.execute(db)).rows[0];groups.conversations!.records+=number(row?.n)}
  const source=(await sql<{n:unknown}>`SELECT COUNT(*) AS n FROM memory_sources AS r JOIN memory_entries AS e ON e.id=r.entry_id JOIN conversation_messages AS m ON m.id=r.message_id JOIN conversation_sessions AS s ON s.id=m.session_id WHERE e.owner_user_id=${owner} AND s.user_id=${owner}`.execute(db)).rows[0];groups.im_memory!.records+=number(source?.n)
  const pending=new Set<string>()
  for(const row of (await sql<{items:unknown}>`SELECT CAST(items AS TEXT) AS items FROM conversation_pending_queues WHERE user_id=${owner}`.execute(db)).rows){let items=row.items;if(typeof items==='string'){try{items=JSON.parse(items)}catch{throw new CoreError('storage_error','待发送草稿格式无效')}}for(const item of iterable(items)){if(!object(item))continue;for(const attachment of iterable(item.attachments)){if(object(attachment)&&truthy(attachment.attach_id))pending.add(identity(attachment.attach_id))}}}
  let after:number|undefined
  for(;;){
   const rows=(await sql<{id:number;attach_id:string;state:string;size:unknown}>`SELECT a.id,a.attach_id,a.state,a.size FROM chat_attachments AS a WHERE a.user_id=${owner} AND (a.state='draft' OR (a.state='attached' AND EXISTS(SELECT 1 FROM conversation_messages AS m JOIN conversation_sessions AS s ON s.id=m.session_id WHERE m.id=a.message_id AND s.user_id=${owner}))) AND ${after===undefined?sql`1=1`:sql`a.id>${after}`} ORDER BY a.id LIMIT 500`.execute(db)).rows
   if(!rows.length)break
   for(const row of rows)if(row.state!=='draft'||pending.has(row.attach_id)){groups.conversations!.records++;groups.conversations!.bytes+=number(row.size)}
   after=rows.at(-1)!.id
  }
  groups.account!.records=1
  return {categories:groups,format_version:'1.0'}
 }
}
