import { createHash } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import type { RagDocument } from './contracts.js'

type Existing = { id:number; source_id:string; document_version:string; chunk_index:number; deleted_at:unknown }
export type RagIndexWriteFence = { before(tx:Transaction<any>):Promise<void>; after(tx:Transaction<any>):Promise<void> }
const key = (source:string, version:string, chunk:number) => JSON.stringify([source,version,chunk])

/** 索引是可重建投影；来源及其授权必须由可信调用方提供。 */
export function createSqlRagPersistentIndexWriter(db:Kysely<any>,backend:'postgres'|'sqlite') {
 async function write(rawOwner:string,sourceType:string,sourceId:string|null,documents:readonly RagDocument[],signal?:AbortSignal,fence?:RagIndexWriteFence) {
  signal?.throwIfAborted()
  const normalized=dataContext(rawOwner).ownerId,owner=backend==='sqlite'?normalized.replaceAll('-',''):normalized
  if(!sourceType || sourceType==='file')throw new Error('RAG 索引来源无效')
  const unique=new Set<string>()
  for(const doc of documents){
   if(doc.source_type!==sourceType || !doc.source_id || (sourceId!==null&&doc.source_id!==sourceId) || !doc.parent_id || !doc.document_version || !doc.scope_type || !Number.isSafeInteger(doc.chunk_index) || doc.chunk_index!<0 || !Number.isSafeInteger(doc.chunk_count) || doc.chunk_count!<1 || doc.chunk_index!>=doc.chunk_count!)throw new Error('RAG 索引文档无效')
   const item=key(doc.source_id,doc.document_version,doc.chunk_index!)
   if(unique.has(item))throw new Error('RAG 索引文档重复')
   unique.add(item)
  }
  return db.transaction().execute(async trx=>{
   signal?.throwIfAborted()
   if(fence)await fence.before(trx)
   // 同一 owner 的来源共用游标；提交必须串行并保证时间水位单调推进。
   if(backend==='postgres')await sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner},0))`.execute(trx)
   const stampResult=backend==='postgres'
    ? await sql<{stamp:string}>`SELECT to_char(GREATEST(clock_timestamp(),COALESCE(MAX(indexed_at)+interval '1 microsecond','epoch'::timestamptz)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS stamp FROM knowledge_index_entries WHERE owner_user_id=${owner}`.execute(trx)
    : await sql<{stamp:string}>`SELECT MAX(indexed_at) AS stamp FROM knowledge_index_entries WHERE owner_user_id=${owner}`.execute(trx)
   let stamp=stampResult.rows[0]?.stamp
   if(backend==='sqlite'){
    const previous=stamp?Date.parse(`${String(stamp).replace(' ','T').replace(/Z$/,'')}Z`):0
    if(stamp&&!Number.isFinite(previous))throw new Error('RAG 索引时间无效')
    stamp=new Date(Math.max(Date.now(),previous+1)).toISOString().replace('T',' ').replace('Z','000')
   }
   if(!stamp)throw new Error('RAG 索引时间无效')
   const whereSource=sourceId===null?sql``:sql`AND source_id=${sourceId}`
   const result=await sql<Existing>`SELECT id,source_id,document_version,chunk_index,deleted_at FROM knowledge_index_entries WHERE owner_user_id=${owner} AND source_type=${sourceType} ${whereSource}`.execute(trx)
   const existing=new Map(result.rows.map(row=>[key(row.source_id,row.document_version,Number(row.chunk_index)),row]))
   let inserted=0,updated=0,deleted=0
   for(const doc of documents){
    signal?.throwIfAborted()
    const row=existing.get(key(doc.source_id!,doc.document_version!,doc.chunk_index!)),content=doc.content??''
    const hash=createHash('sha256').update(content.trim(),'utf8').digest('hex'),metadata=JSON.stringify(doc.metadata??{})
    const values={scope:doc.scope_type,scopeId:doc.scope_id||'',platform:doc.platform||'',bot:doc.bot_id||'',group:doc.group_id||'',parent:doc.parent_id!,count:doc.chunk_count!,title:doc.title||'',summary:doc.summary||'',content,hash,metadata,updatedAt:doc.updated_at&&Number.isFinite(Date.parse(doc.updated_at))?doc.updated_at:null}
    if(row){
     await sql`UPDATE knowledge_index_entries SET scope_type=${values.scope},scope_id=${values.scopeId},platform=${values.platform},bot_id=${values.bot},group_id=${values.group},document_id=${values.parent},parent_document_id=${values.parent},chunk_count=${values.count},title=${values.title},summary=${values.summary},content=${values.content},content_hash=${values.hash},metadata_json=${values.metadata},source_updated_at=${values.updatedAt},deleted_at=NULL,indexed_at=${stamp} WHERE id=${row.id} AND owner_user_id=${owner}`.execute(trx)
     updated++
    }else{
     await sql`INSERT INTO knowledge_index_entries(owner_user_id,source_type,source_id,scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,document_version,chunk_index,chunk_count,title,summary,content,content_hash,metadata_json,source_updated_at,indexed_at,deleted_at) VALUES(${owner},${sourceType},${doc.source_id},${values.scope},${values.scopeId},${values.platform},${values.bot},${values.group},${values.parent},${values.parent},${doc.document_version},${doc.chunk_index},${values.count},${values.title},${values.summary},${values.content},${values.hash},${values.metadata},${values.updatedAt},${stamp},NULL)`.execute(trx)
     inserted++
    }
   }
   for(const [item,row] of existing){
    if(!unique.has(item)&&row.deleted_at===null){
     signal?.throwIfAborted()
     await sql`UPDATE knowledge_index_entries SET deleted_at=${stamp},indexed_at=${stamp} WHERE id=${row.id} AND owner_user_id=${owner}`.execute(trx)
     deleted++
    }
   }
   signal?.throwIfAborted()
   if(fence)await fence.after(trx)
   return {inserted,updated,deleted}
  })
 }
 return {
  replaceSource:(owner:string,sourceType:string,documents:readonly RagDocument[],signal?:AbortSignal)=>write(owner,sourceType,null,documents,signal),
  replaceDocument:(owner:string,sourceType:string,sourceId:string,documents:readonly RagDocument[],signal?:AbortSignal)=>{
   if(!sourceId)throw new Error('RAG 索引来源 ID 无效')
   return write(owner,sourceType,sourceId,documents,signal)
  },
  replaceFenced:(owner:string,sourceType:string,sourceId:string|null,documents:readonly RagDocument[],fence:RagIndexWriteFence,signal?:AbortSignal)=>write(owner,sourceType,sourceId,documents,signal,fence),
 }
}
