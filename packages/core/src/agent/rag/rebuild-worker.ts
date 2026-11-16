import { sql, type Kysely } from 'kysely'
import { dataContext } from '../../contracts/index.js'
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
  const rawOwner=String(job.user_id)
  const owner=backend==='sqlite'&&/^[0-9a-f]{32}$/iu.test(rawOwner)?rawOwner.replace(/^(........)(....)(....)(....)(............)$/u,'$1-$2-$3-$4-$5'):rawOwner
  try{
   const sourceId=ids(job.pending_source_ids)[0]||job.source_id||null
   const documents=await sources[job.source_type]!(owner,sourceId,signal)
   signal?.throwIfAborted()
   // Memory rebuild reads the complete owner index, so its write must replace the whole
   // owner/source projection even when an upstream event carries one leaf source id.
   const writeSourceId=job.source_type==='memory'?null:sourceId
   await writer.replaceFenced(owner,job.source_type,writeSourceId,documents,{
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

/**
 * 队列为空的老 owner 也需要首次建立当前支持来源的持久索引。只为既无
 * 索引行也无队列行的来源入队；空 source_id 在 Worker 边界表示全来源重建，
 * 已有的增量任务与正在更新的索引均不会被启动扫描覆盖。
 */
export async function enqueueMissingAgentRagBaselines(db:Kysely<any>,backend:'postgres'|'sqlite',sourceTypes:readonly string[]):Promise<number> {
 let queued=0
 const owners=backend==='postgres'?sql`SELECT id FROM users`:sql`SELECT user_id AS id FROM projects
  UNION SELECT user_id AS id FROM calendar_events UNION SELECT user_id AS id FROM mind_nodes
  UNION SELECT user_id AS id FROM mind_maps UNION SELECT user_id AS id FROM scheduled_tasks
  UNION SELECT user_id AS id FROM conversation_sessions UNION SELECT owner_user_id AS id FROM knowledge_index_entries
  UNION SELECT user_id AS id FROM rag_index_jobs`
 for(const sourceType of new Set(sourceTypes.filter(value=>typeof value==='string'&&/^[a-z_]{1,32}$/u.test(value)&&value!=='file'))){
  const pending=backend==='postgres'?sql`CAST(${JSON.stringify([])} AS json)`:sql`${JSON.stringify([])}`
  const result=await sql`INSERT INTO rag_index_jobs (
   user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,
   next_attempt_at,lease_until,last_error_code,last_started_at,last_succeeded_at,created_at,updated_at
  ) SELECT u.id,${sourceType},'',${pending},'','upsert','queued',1,0,0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
   FROM (${owners}) u
   WHERE NOT EXISTS (SELECT 1 FROM rag_index_jobs j WHERE j.user_id=u.id AND j.source_type=${sourceType})
    AND NOT EXISTS (SELECT 1 FROM knowledge_index_entries i WHERE i.owner_user_id=u.id AND i.source_type=${sourceType})
  `.execute(db)
  queued+=Number(result.numAffectedRows??0)
 }
 return queued
}

/** 来源文件在 Host 成功变更后，排入该 owner 的完整来源重建。 */
const REBUILDABLE_AGENT_RAG_SOURCES=new Set(['project','calendar','note','scheduled_task','conversation','canvas','knowledge','memory'])
export async function enqueueAgentRagRebuild(db:Kysely<any>,backend:'postgres'|'sqlite',rawOwner:string,sourceType:string):Promise<void> {
 const normalized=dataContext(rawOwner).ownerId
 const owner=backend==='sqlite'?normalized.replaceAll('-',''):normalized
 if(!REBUILDABLE_AGENT_RAG_SOURCES.has(sourceType))throw new Error('RAG 索引来源无效')
 const pending=JSON.stringify([])
 await db.transaction().execute(async tx=>{
  await sql`INSERT INTO rag_index_jobs (
   user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,
   next_attempt_at,lease_until,last_error_code,last_started_at,last_succeeded_at,created_at,updated_at
  ) VALUES (${owner},${sourceType},'',${pending},'','refresh','queued',1,0,0,CURRENT_TIMESTAMP,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  ON CONFLICT (user_id,source_type) DO UPDATE SET
   source_id='',pending_source_ids=${pending},version='',operation='refresh',status='queued',
   generation=rag_index_jobs.generation+1,next_attempt_at=CURRENT_TIMESTAMP,lease_until=NULL,
   last_error_code=NULL,updated_at=CURRENT_TIMESTAMP`.execute(tx)
  // Memory removal is security-sensitive: hide the previous projection immediately,
  // rather than keeping it searchable until the asynchronous rebuild is claimed.
  if(sourceType==='memory')await sql`UPDATE knowledge_index_entries SET deleted_at=CURRENT_TIMESTAMP,indexed_at=CURRENT_TIMESTAMP
   WHERE owner_user_id=${owner} AND source_type='memory' AND deleted_at IS NULL`.execute(tx)
 })
}

export async function readAgentRagRebuildProgress(db:Kysely<any>,backend:'postgres'|'sqlite',rawOwner:string,sourceType:string):Promise<{generation:number;completedGeneration:number;status:string}|null>{
 const normalized=dataContext(rawOwner).ownerId
 const owner=backend==='sqlite'?normalized.replaceAll('-',''):normalized
 const result=await sql<{generation:number|string;completed_generation:number|string;status:string}>`SELECT generation,completed_generation,status FROM rag_index_jobs WHERE user_id=${owner} AND source_type=${sourceType}`.execute(db)
 const row=result.rows[0]
 return row?{generation:Number(row.generation),completedGeneration:Number(row.completed_generation),status:String(row.status)}:null
}
