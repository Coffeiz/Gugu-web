import { sql, type Kysely, type RawBuilder } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { RagDocument, RagSearchScope } from './contracts.js'

export interface RagIndexCursor { timestamp:string; id:number }
interface IndexRow {
 id:number|string; indexed_stamp:string; deleted_at:unknown
 source_type:string; source_id:string; scope_type:string; scope_id:string; platform:string; bot_id:string; group_id:string
 document_id:string; parent_document_id:string|null; document_version:string; chunk_index:number; chunk_count:number
 title:string; summary:string; content:string; metadata_json:unknown; source_updated_at:unknown
}
function metadata(raw:unknown):Record<string,string|number|boolean|null> {
 let value=raw
 if(typeof value==='string'){
  try{value=JSON.parse(value)}catch{throw new Error('RAG 索引元数据无效')}
 }
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
 const formatStamp=(expression:RawBuilder<unknown>)=>backend==='postgres'
  ? sql`to_char(${expression} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`
  : expression
 const stamp=formatStamp(sql`indexed_at`)
 const columns=sql`id,${stamp} AS indexed_stamp,deleted_at,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,chunk_index,chunk_count,title,summary,content,metadata_json,source_updated_at`
 function key(row:IndexRow){return `${row.source_type}:${row.parent_document_id||row.document_id}:${Number(row.chunk_index||0)}`}
 async function readSnapshot(rawOwner:string, signal?:AbortSignal, scopeFilter?:RawBuilder<unknown>){
  signal?.throwIfAborted();const owner=ownerKey(rawOwner)
  const ownerRows=sql`FROM knowledge_index_entries WHERE owner_user_id=${owner} AND source_type<>'file'`
  // 版本摘要与有效正文取自同一条语句的读视图，已删除的行只参与版本和水位计算。
  const query=scopeFilter ? sql`
   WITH watermark AS (
    SELECT id,${stamp} AS indexed_stamp ${ownerRows} ORDER BY indexed_at DESC,id DESC LIMIT 1
   )
   SELECT ${columns},'document' AS row_kind ${ownerRows} AND deleted_at IS NULL AND (${scopeFilter})
   UNION ALL
   SELECT NULL,${formatStamp(sql`MAX(indexed_at)`)},NULL,source_type,NULL,NULL,NULL,NULL,NULL,NULL,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'revision'
    ${ownerRows} GROUP BY source_type
   UNION ALL
   SELECT id,indexed_stamp,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'watermark' FROM watermark
   ORDER BY id ASC` : sql`SELECT ${columns},'document' AS row_kind ${ownerRows} ORDER BY id ASC`
  const result=await sql<IndexRow & {row_kind:'document'|'revision'|'watermark'}>`${query}`.execute(db)
  signal?.throwIfAborted()
  const revisions=new Map<string,string>(),documents:RagDocument[]=[]
  let watermark:RagIndexCursor|null=null
  for(const row of result.rows){
   if(row.row_kind==='revision'){
    revisions.set(row.source_type,row.indexed_stamp)
    continue
   }
   const cursor={timestamp:row.indexed_stamp,id:Number(row.id)}
   if(!Number.isSafeInteger(cursor.id)||cursor.id<1||!cursor.timestamp)throw new Error('RAG 索引游标无效')
   if(row.row_kind==='watermark'){
    watermark=cursor
    continue
   }
   if(!scopeFilter){
    const revision=revisions.get(row.source_type)
    if(!revision||cursor.timestamp>revision)revisions.set(row.source_type,cursor.timestamp)
    if(!watermark||cursor.timestamp>watermark.timestamp||cursor.timestamp===watermark.timestamp&&cursor.id>watermark.id)watermark=cursor
   }
   if(row.deleted_at===null)documents.push(document(row))
  }
  const revision=revisions.size?`ts-jieba-words-v3:rag-projection-v5:${[...revisions].sort(([a],[b])=>a.localeCompare(b)).map(([source,value])=>`${source}:${value}`).join(';')}`:null
  return {revision,documents,watermark}
 }
 return {
  snapshot: (rawOwner:string,signal?:AbortSignal) => readSnapshot(rawOwner,signal),
  /** scope 必须来自 Host 已验证的授权快照，不能使用模型参数。 */
  async snapshotForScope(rawOwner:string,scope:RagSearchScope,signal?:AbortSignal){
   if(!scope || !['owner','group','member','project'].includes(scope.scope_type||''))throw new Error('RAG 授权范围无效')
   if(['group','member'].includes(scope.scope_type!)&&(!scope.scope_id||!scope.platform||!scope.bot_id||!scope.group_id))throw new Error('RAG 授权范围不完整')
   if(scope.scope_type==='project'&&!scope.scope_id)throw new Error('RAG 授权范围不完整')
   const scopeFilter = ['group','member'].includes(scope.scope_type!)
    ? sql`platform=${scope.platform} AND bot_id=${scope.bot_id} AND group_id=${scope.group_id}
      AND ((scope_type=${scope.scope_type} AND scope_id=${scope.scope_id}) OR (${Number(scope.scope_type==='member')}=1 AND scope_type='group'))`
    : sql`scope_type='owner' OR scope_type=''`
   const snapshot=await readSnapshot(rawOwner,signal,scopeFilter)
   const documents=snapshot.documents.filter(doc=>{
    if(scope.scope_type==='owner')return doc.scope_type==='owner'
    if(scope.scope_type==='project')return doc.scope_type==='owner'&&String(doc.metadata?.project_id??'')===scope.scope_id
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
