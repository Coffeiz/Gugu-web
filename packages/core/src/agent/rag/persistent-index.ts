import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { RagDocument, RagSearchScope } from './contracts.js'

export interface RagIndexCursor { timestamp:string; id:number }
interface IndexRow {
 id:number|string; indexed_stamp:string; source_revision:string; deleted_at:unknown
 source_type:string; source_id:string; scope_type:string; scope_id:string; platform:string; bot_id:string; group_id:string
 document_id:string; parent_document_id:string|null; document_version:string; chunk_index:number; chunk_count:number
 title:string; summary:string; content:string; metadata_json:unknown; source_updated_at:unknown
}
function metadata(raw:unknown):Record<string,string|number|boolean|null> {
 let value=raw
 if(typeof value==='string')value=JSON.parse(value)
 if(value===null||value===undefined)return {}
 if(typeof value!=='object'||Array.isArray(value))throw new Error('RAG 索引元数据无效')
 return value as Record<string,string|number|boolean|null>
}
/** 保持旧版持久 chunk 的文档键、范围与正文投影。 */
function document(row:IndexRow):RagDocument {
 const sourceType=String(row.source_type||''),sourceId=String(row.source_id||''),parentId=String(row.parent_document_id||row.document_id||'')
 const chunkIndex=Number(row.chunk_index||0),chunkCount=Math.max(1,Number(row.chunk_count||1))
 const title=String(row.title||''),summary=String(row.summary||''),content=String(row.content||''),meta=metadata(row.metadata_json)
 const updated=row.source_updated_at instanceof Date?row.source_updated_at.toISOString():String(row.source_updated_at||'')
 return {id:`${sourceType}:${parentId}:${chunkIndex}`,source_id:sourceId,text:[title,...(summary?[summary]:[]),content].join('\n'),content,
  ...(sourceType==='conversation'?{ranking_text:content}:{}),
  ...(sourceType==='conversation'&&meta.kind==='message'?{context_text:[meta.context_before,meta.context_current??content,meta.context_after].map(part=>String(part||'')).filter(part=>part.trim()).join('\n')}:{}),
  source_type:sourceType,title,summary,platform:String(row.platform||''),bot_id:String(row.bot_id||''),group_id:String(row.group_id||''),
  scope_type:String(row.scope_type||'owner'),scope_id:String(row.scope_id||''),document_version:String(row.document_version||''),parent_id:parentId,chunk_index:chunkIndex,chunk_count:chunkCount,
  ...(updated?{updated_at:updated}:{}),metadata:meta}
}
/** 读取旧版可重建索引；授权由可信 Host 提供，调用方必须按 scope 再过滤。 */
export function createSqlRagPersistentIndexReader(db:Kysely<any>,backend:'postgres'|'sqlite') {
 const ownerKey=(raw:string)=>{const owner=dataContext(raw).ownerId;return backend==='sqlite'?owner.replaceAll('-',''):owner}
 const stamp=backend==='postgres'?sql`to_char(indexed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`:sql`indexed_at`
 const maxStamp=backend==='postgres'?sql`to_char(MAX(indexed_at) OVER (PARTITION BY source_type) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`:sql`MAX(indexed_at) OVER (PARTITION BY source_type)`
 const columns=sql`id,${stamp} AS indexed_stamp,${maxStamp} AS source_revision,deleted_at,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,chunk_index,chunk_count,title,summary,content,metadata_json,source_updated_at`
 function key(row:IndexRow){return `${row.source_type}:${row.parent_document_id||row.document_id}:${Number(row.chunk_index||0)}`}
 return {
  async snapshot(rawOwner:string,signal?:AbortSignal){
   signal?.throwIfAborted();const owner=ownerKey(rawOwner)
   const result=await sql<IndexRow>`SELECT ${columns} FROM knowledge_index_entries WHERE owner_user_id=${owner} AND source_type<>'file' ORDER BY id ASC`.execute(db)
   signal?.throwIfAborted()
   const revisions=new Map<string,string>(),documents:RagDocument[]=[]
   let watermark:RagIndexCursor|null=null
   for(const row of result.rows){
    revisions.set(row.source_type,row.source_revision)
    const cursor={timestamp:row.indexed_stamp,id:Number(row.id)}
    if(!Number.isSafeInteger(cursor.id)||cursor.id<1||!cursor.timestamp)throw new Error('RAG 索引游标无效')
    if(!watermark||cursor.timestamp>watermark.timestamp||cursor.timestamp===watermark.timestamp&&cursor.id>watermark.id)watermark=cursor
    if(row.deleted_at===null)documents.push(document(row))
   }
   const revision=revisions.size?`ts-jieba-words-v3:rag-projection-v5:${[...revisions].sort(([a],[b])=>a.localeCompare(b)).map(([source,value])=>`${source}:${value}`).join(';')}`:null
   return {revision,documents,watermark}
  },
  /** scope 必须来自 Host 已验证的授权快照，不能使用模型参数。 */
  async snapshotForScope(rawOwner:string,scope:RagSearchScope,signal?:AbortSignal){
   if(!scope || !['owner','group','member','project','folder'].includes(scope.scope_type||''))throw new Error('RAG 授权范围无效')
   if(['group','member'].includes(scope.scope_type!)&&(!scope.scope_id||!scope.platform||!scope.bot_id||!scope.group_id))throw new Error('RAG 授权范围不完整')
   if(['project','folder'].includes(scope.scope_type!)&&!scope.scope_id)throw new Error('RAG 授权范围不完整')
   const snapshot=await this.snapshot(rawOwner,signal)
   const documents=snapshot.documents.filter(doc=>{
    if(scope.scope_type==='owner')return doc.scope_type==='owner'
    if(scope.scope_type==='project'||scope.scope_type==='folder')return doc.scope_type==='owner'&&String(doc.metadata?.[scope.scope_type==='project'?'project_id':'folder_id']??'')===scope.scope_id
    if(doc.platform!==scope.platform||doc.bot_id!==scope.bot_id||doc.group_id!==scope.group_id)return false
    return doc.scope_type===scope.scope_type&&doc.scope_id===scope.scope_id || scope.scope_type==='member'&&doc.scope_type==='group'
   })
   return {...snapshot,documents}
  },
  async delta(rawOwner:string,cursor:RagIndexCursor|null,limit=2000,signal?:AbortSignal){
   signal?.throwIfAborted();const owner=ownerKey(rawOwner)
   if(!Number.isSafeInteger(limit)||limit<1||limit>2000)throw new Error('RAG 索引页大小无效')
   if(cursor&&(!Number.isSafeInteger(cursor.id)||cursor.id<0||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)?$/u.test(cursor.timestamp)))throw new Error('RAG 索引游标无效')
   const since=cursor?.timestamp??'1970-01-01T00:00:00+00:00',id=cursor?.id??0
   const result=await sql<IndexRow>`SELECT ${columns} FROM knowledge_index_entries WHERE owner_user_id=${owner} AND source_type<>'file' AND (indexed_at>${since} OR (indexed_at=${since} AND id>${id})) ORDER BY indexed_at ASC,id ASC LIMIT ${limit}`.execute(db)
   signal?.throwIfAborted();const upserts:RagDocument[]=[],deletes:string[]=[]
   for(const row of result.rows){if(row.deleted_at!==null)deletes.push(key(row));else upserts.push(document(row))}
   const last=result.rows.at(-1)
   return {upserts,deletes,cursor:last?{timestamp:last.indexed_stamp,id:Number(last.id)}:null,hasMore:result.rows.length===limit}
  },
 }
}
