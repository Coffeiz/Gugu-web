import { sql, type Kysely } from 'kysely'
import { createSqlRagPersistentIndexWriter } from './persistent-writer.js'
import type { RagDocument } from './contracts.js'

export type RagRebuildSource = (owner:string,sourceId:string|null,signal?:AbortSignal)=>Promise<readonly RagDocument[]>
type Job={id:number;user_id:string;source_type:string;source_id:string;pending_source_ids:unknown;generation:number;attempts:number;lease_until:string}
function ids(value:unknown):string[] {
 const parsed=typeof value==='string'?JSON.parse(value):value
 if(parsed===null||parsed===undefined)return []
 if(!Array.isArray(parsed)||parsed.some(item=>typeof item!=='string'))throw new Error('RAG 任务来源无效')
 return [...new Set(parsed.filter(Boolean))]
}

/** 仅领取 Host 已注入真实来源的任务；重建和任务收据在同一事务提交。 */
export function createSqlRagRebuildWorker(db:Kysely<any>,backend:'postgres'|'sqlite',sources:Readonly<Record<string,RagRebuildSource>>,clock:()=>Date=()=>new Date()) {
 const allowed=Object.keys(sources).filter(key=>key!=='file'&&typeof sources[key]==='function')
 const writer=createSqlRagPersistentIndexWriter(db,backend)
 const stamp=(date:Date)=>backend==='sqlite'?date.toISOString().replace('T',' ').replace('Z','000'):date.toISOString()
 return async (signal?:AbortSignal):Promise<'idle'|'ready'|'retrying'|'superseded'>=>{
  signal?.throwIfAborted()
  if(!allowed.length)return 'idle'
  const now=clock(),started=stamp(now),lease=stamp(new Date(now.getTime()+600_000))
  const job=await db.transaction().execute(async tx=>{
   const lock=backend==='postgres'?sql`FOR UPDATE SKIP LOCKED`:sql``
   const found=await sql<Job>`SELECT id,user_id,source_type,source_id,pending_source_ids,generation,attempts,lease_until FROM rag_index_jobs
    WHERE source_type IN (${sql.join(allowed)}) AND ((status IN ('queued','retrying') AND next_attempt_at<=${started}) OR (status='running' AND lease_until<=${started}))
    ORDER BY next_attempt_at,id LIMIT 1 ${lock}`.execute(tx)
   const row=found.rows[0]
   if(!row)return null
   await sql`UPDATE rag_index_jobs SET status='running',attempts=attempts+1,last_started_at=${started},lease_until=${lease},next_attempt_at=NULL,updated_at=${started} WHERE id=${row.id}`.execute(tx)
   return {...row,generation:Number(row.generation),attempts:Number(row.attempts)+1,lease_until:lease}
  })
  if(!job)return 'idle'
  const sourceId=ids(job.pending_source_ids)[0]||job.source_id||null
  const rawOwner=String(job.user_id)
  const owner=backend==='sqlite'&&/^[0-9a-f]{32}$/iu.test(rawOwner)?rawOwner.replace(/^(........)(....)(....)(....)(............)$/u,'$1-$2-$3-$4-$5'):rawOwner
  try{
   const documents=await sources[job.source_type]!(owner,sourceId,signal)
   signal?.throwIfAborted()
   await writer.replaceFenced(owner,job.source_type,sourceId,documents,{
    before:async tx=>{
     const checkTime=stamp(clock())
     const lock=backend==='postgres'?sql`FOR UPDATE`:sql``
     const valid=await sql`SELECT id FROM rag_index_jobs WHERE id=${job.id} AND generation=${job.generation} AND status='running' AND lease_until=${lease} AND lease_until>${checkTime} ${lock}`.execute(tx)
     if(valid.rows.length!==1)throw new Error('RAG 任务租约已失效')
    },
    after:async tx=>{
     const finish=stamp(clock())
     if(finish>=lease)throw new Error('RAG 任务租约已失效')
     const pending=ids(job.pending_source_ids).filter(id=>id!==sourceId),next=pending.length?'queued':'ready'
     await sql`UPDATE rag_index_jobs SET status=${next},completed_generation=${job.generation},pending_source_ids=${JSON.stringify(pending)},next_attempt_at=${pending.length?finish:null},lease_until=NULL,last_error_code=NULL,last_succeeded_at=${finish},updated_at=${finish} WHERE id=${job.id} AND generation=${job.generation}`.execute(tx)
    },
   },signal)
   return 'ready'
  }catch(error){
   const failed=stamp(clock()),retry=stamp(new Date(clock().getTime()+Math.min(300,5*2**Math.min(Math.max(job.attempts-1,0),6))*1000))
   const result=await sql`UPDATE rag_index_jobs SET status='retrying',next_attempt_at=${retry},lease_until=NULL,last_error_code='index_update_failed',updated_at=${failed} WHERE id=${job.id} AND generation=${job.generation} AND status='running' AND lease_until=${lease}`.execute(db)
   signal?.throwIfAborted()
   if(Number(result.numAffectedRows??0)===0)return 'superseded'
   void error
   return 'retrying'
  }
 }
}
