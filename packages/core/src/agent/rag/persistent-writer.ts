import { createHash } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { utc } from '../../shared/timestamps.js'
import type { RagDocument } from './contracts.js'

type Projection = {
 scope_type: string; scope_id: string; platform: string; bot_id: string; group_id: string
 document_id: string; parent_document_id: string; chunk_count: number; title: string; summary: string
 content: string; content_hash: string; metadata_json: string; source_updated_at: string | null
}
type Existing = Projection & { id:number; source_id:string; document_version:string; chunk_index:number; deleted_at:unknown }

function sameProjection(row: Existing, projection: Projection, backend: 'postgres' | 'sqlite'): boolean {
 if (row.deleted_at !== null) return false
 for (const field of Object.keys(projection) as (keyof Projection)[]) {
  if (field === 'source_updated_at' && backend === 'postgres' && projection.source_updated_at !== null) {
   try {
    if (row.source_updated_at !== utc(projection.source_updated_at)) return false
   } catch {
    // 交给数据库处理其接受的其他日期格式。
    return false
   }
  } else if (row[field] !== projection[field]) return false
 }
 return true
}
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
   const sourceUpdatedAt=backend==='postgres'
    ? sql`replace(to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US'),'.000000','') || '+00:00'`
    : sql`source_updated_at`
   const result=await sql<Existing>`SELECT id,source_id,document_version,chunk_index,deleted_at,
    scope_type,scope_id,platform,bot_id,group_id,document_id,parent_document_id,chunk_count,title,summary,
    CASE WHEN deleted_at IS NULL THEN content ELSE '' END AS content,content_hash,
    CASE WHEN deleted_at IS NULL THEN CAST(metadata_json AS TEXT) ELSE '' END AS metadata_json,
    ${sourceUpdatedAt} AS source_updated_at
    FROM knowledge_index_entries WHERE owner_user_id=${owner} AND source_type=${sourceType} ${whereSource}`.execute(trx)
   const existing=new Map(result.rows.map(row=>[key(row.source_id,row.document_version,Number(row.chunk_index)),row]))
   let inserted=0,updated=0,deleted=0
   for(const doc of documents){
    signal?.throwIfAborted()
    const row=existing.get(key(doc.source_id!,doc.document_version!,doc.chunk_index!)),content=doc.content??''
    const projection: Projection = {
     scope_type:doc.scope_type,scope_id:doc.scope_id||'',platform:doc.platform||'',bot_id:doc.bot_id||'',group_id:doc.group_id||'',
     document_id:doc.parent_id!,parent_document_id:doc.parent_id!,chunk_count:doc.chunk_count!,title:doc.title||'',summary:doc.summary||'',
     content,content_hash:createHash('sha256').update(content.trim(),'utf8').digest('hex'),metadata_json:JSON.stringify(doc.metadata??{}),
     source_updated_at:doc.updated_at&&Number.isFinite(Date.parse(doc.updated_at))?doc.updated_at:null,
    }
    if(row){
     // 相同投影不推进索引水位，也不触发快照失效。
     if(sameProjection(row,projection,backend))continue
     await trx.updateTable('knowledge_index_entries').set({...projection,deleted_at:null,indexed_at:stamp})
      .where('id','=',row.id).where('owner_user_id','=',owner).execute()
     updated++
    }else{
     await trx.insertInto('knowledge_index_entries').values({...projection,owner_user_id:owner,source_type:sourceType,
      source_id:doc.source_id!,document_version:doc.document_version!,chunk_index:doc.chunk_index!,indexed_at:stamp,deleted_at:null}).execute()
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
