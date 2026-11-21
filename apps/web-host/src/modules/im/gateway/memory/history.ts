import type {Pool,PoolClient} from 'pg'
import type {RunIdentity} from '@gugu/core/agent'
import {normalizeFileOwnerId,isOwnedFileStorageKey} from '../../../files/store.js'
import {withPostgresTransaction} from '../../../../adapters/database/postgres-transaction.js'

export class ImHistoryRetentionError extends Error{constructor(){super('IM 历史保留任务暂不可用');this.name='ImHistoryRetentionError'}}
const invalid=()=>new ImHistoryRetentionError()
const sessionNumber=(raw:string|number)=>{const value=Number(raw);if(!/^[1-9]\d*$/.test(String(raw))||!Number.isSafeInteger(value)||value>2147483647)throw invalid();return value}
function safeKey(owner:string,key:unknown):key is string{return typeof key==='string'&&key.length<=4096&&isOwnedFileStorageKey(owner,key)
 &&!/[\\\u0000-\u001f]/u.test(key)&&key.split('/').every(part=>part!==''&&part!=='.'&&part!=='..')}

/** 只登记真实删除事务取回的owned附件引用；消息/会话删除失败时本记录也回滚。 */
export async function enqueueCleanupLocked(client:PoolClient,rawOwner:string,storageKeys:readonly string[]):Promise<void>{
 try{
  const owner=normalizeFileOwnerId(rawOwner),keys=[...new Set(storageKeys)]
  if(keys.some(key=>!safeKey(owner,key)))throw invalid()
  for(let offset=0;offset<keys.length;offset+=500)await client.query(`INSERT INTO gugu_im_history_retention_storage(user_id,storage_key)
    SELECT $1,unnest($2::text[]) ON CONFLICT(user_id,storage_key) DO UPDATE SET generation=gugu_im_history_retention_storage.generation+1,
      next_attempt_at=clock_timestamp()`,[owner,keys.slice(offset,offset+500)])
 }catch{throw invalid()}
}
export interface ImHistoryRetentionOptions{
 pool:Pick<Pool,'query'|'connect'>
 beforeRemoveLocked(client:PoolClient,ownerId:string,sessionId:number,messageIds:readonly number[]):Promise<void>
 /** 同client读取scope后只允许有界Redis GET，不可另借PG/HTTP/FS。unknown必须延期。 */
 pendingAsk(client:PoolClient,ownerId:string,sessionId:number,signal:AbortSignal):Promise<'clear'|'pending'|'unknown'>
 removeIfUnreferenced(ownerId:string,storageKey:string):Promise<boolean>
 concurrency?:number;deferMs?:number;diagnose?(code:string):void
}
export interface ImHistoryRetentionStats{targets:number;messages:number;interactions:number;deferred:number;storageProcessed:number}
interface Target{user_id:string;session_id:number}
// 只从真正保留区/未覆盖/pending引用出发保护完整Node批次及原语音来源，允许安全多留。
const candidates=`WITH RECURSIVE keep AS (
 SELECT id FROM conversation_messages WHERE session_id=$2 ORDER BY coalesce(history_anchor_seq,conversation_seq) DESC,conversation_seq DESC LIMIT 2000
), old AS (
 SELECT id,run_id,coalesce(history_anchor_seq,conversation_seq) AS effective,history_anchor_seq,conversation_seq
 FROM conversation_messages WHERE session_id=$2 AND id NOT IN(SELECT id FROM keep)
  AND coalesce(history_anchor_seq,conversation_seq)<=$3::bigint AND role<>'summary' AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%')
), quote_edges AS (
 SELECT DISTINCT coalesce(qm.id,0) AS source_id,anchor.id AS target_id FROM chat_attachments q
 LEFT JOIN conversation_messages qm ON qm.id=q.message_id
 JOIN chat_attachments original ON original.user_id=q.user_id AND original.storage_key=q.storage_key AND original.state='attached'
  AND original.platform=q.platform AND original.extra->>'im_ingress_scope'=q.extra->>'im_ingress_scope'
  AND coalesce(original.extra->>'quoted','false')<>'true'
 JOIN conversation_messages om ON om.id=original.message_id
 JOIN conversation_sessions os ON os.id=om.session_id AND os.user_id=$1
 JOIN conversation_messages anchor ON anchor.session_id=$2 AND (anchor.id=om.id
  OR om.run_id IS NOT NULL AND anchor.run_id=om.run_id OR qm.run_id IS NOT NULL AND anchor.run_id=qm.run_id)
 JOIN gugu_im_inbound_receipts r ON r.user_id=$1 AND r.session_id=$2 AND r.message_id=anchor.id
 WHERE q.user_id=$1 AND (q.state='attached' OR q.state='draft' AND q.created_at>clock_timestamp()-interval '24 hours')
  AND q.kind IN('voice','audio') AND q.extra->>'quoted'='true'
  AND (om.session_id=$2 OR qm.session_id=$2)
), protected AS (
 SELECT id FROM conversation_messages WHERE session_id=$2 AND id NOT IN(SELECT id FROM old)
 UNION SELECT source_id FROM quote_edges WHERE source_id=0 OR source_id NOT IN(SELECT id FROM conversation_messages WHERE session_id=$2)
 UNION SELECT e.target_id FROM quote_edges e JOIN protected p ON p.id=e.source_id
)
SELECT id FROM old WHERE id NOT IN(SELECT id FROM protected)
ORDER BY effective,CASE WHEN history_anchor_seq IS NOT NULL THEN 0 ELSE 1 END,conversation_seq LIMIT 500`

/** 只扫描本Node队列；每个目标一短事务/最多500条，session→job顺序不跨Provider等待。 */
export function createImHistoryRetention(options:ImHistoryRetentionOptions){
 const concurrency=options.concurrency??1,deferMs=options.deferMs??5000,controller=new AbortController()
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4||!Number.isSafeInteger(deferMs)||deferMs<1||deferMs>300000
  ||typeof options.beforeRemoveLocked!=='function'||typeof options.pendingAsk!=='function'||typeof options.removeIfUnreferenced!=='function')throw invalid()
 let scanning:Promise<ImHistoryRetentionStats>|null=null,cleaning:Promise<number>|null=null,closed=false
 const diagnose=(code:string)=>{try{options.diagnose?.(code)}catch{}}
 const signalFor=(signal?:AbortSignal)=>signal?AbortSignal.any([signal,controller.signal]):controller.signal
 async function lockSession(client:PoolClient,target:Target,skip=false){return(await client.query(`SELECT s.* FROM conversation_sessions s
   WHERE s.user_id=$1 AND s.id=$2 FOR NO KEY UPDATE OF s ${skip?'SKIP LOCKED':''}`,[target.user_id,target.session_id])).rows[0]}
 async function touch(client:PoolClient,target:Target,runId?:string){
  if(!await lockSession(client,target))throw invalid()
  const verified=await client.query(`SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2
    AND ($3::text IS NULL OR run_id=$3 AND state='dispatched') LIMIT 1`,[target.user_id,target.session_id,runId??null])
  if(!verified.rowCount)throw invalid()
  await client.query(`INSERT INTO gugu_im_history_retention_targets(user_id,session_id,generation) VALUES($1,$2,1)
   ON CONFLICT(user_id,session_id) DO UPDATE SET generation=gugu_im_history_retention_targets.generation+1,next_attempt_at=clock_timestamp()`,[target.user_id,target.session_id])
 }
 async function busy(client:PoolClient,target:Target,session:Record<string,unknown>,signal:AbortSignal){
  if(session.active_run_id!=null||session.execution_state!=='idle'||!Number.isSafeInteger(Number(session.pending_message_count))||Number(session.pending_message_count)!==0)return true
  const row=(await client.query(`SELECT
    EXISTS(SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND (state IS NULL OR state<>'done'))
    OR EXISTS(SELECT 1 FROM agent_run_startups startup WHERE startup.user_id=$1 AND startup.session_id=$2 AND startup.status='pending'
      AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints checkpoint WHERE checkpoint.user_id=startup.user_id
        AND checkpoint.session_id=startup.session_id AND checkpoint.run_id=startup.run_id))
    OR EXISTS(SELECT 1 FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND (status IS NULL OR status NOT IN('completed','cancelled','failed')))
    OR EXISTS(SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM conversation_pending_queues WHERE user_id=$1 AND session_id=$2
      AND CASE WHEN jsonb_typeof(items::jsonb)='array' THEN jsonb_array_length(items::jsonb)>0 ELSE TRUE END)
    OR EXISTS(SELECT 1 FROM interaction_prompts WHERE user_id=$1 AND session_id=$2 AND status='active')
    OR EXISTS(SELECT 1 FROM agent_interaction_intents WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM agent_interaction_resumes WHERE user_id=$1 AND session_id=$2 AND completed_at IS NULL)
    OR EXISTS(SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND state='staged')
    OR EXISTS(SELECT 1 FROM gugu_im_inbound_segments WHERE user_id=$1 AND session_id=$2 AND state='started')
    OR EXISTS(SELECT 1 FROM gugu_im_pending_ask_runs p WHERE p.user_id=$1 AND p.session_id=$2 AND p.state='dispatched'
      AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=p.user_id AND c.session_id=p.session_id AND c.run_id=p.run_id AND c.status IN('completed','failed','cancelled')))
    OR EXISTS(SELECT 1 FROM gugu_im_delivery_receipts WHERE user_id=$1 AND session_id=$2 AND state<>'accepted')
    OR EXISTS(SELECT 1 FROM gugu_im_native_deliveries WHERE user_id=$1 AND session_id=$2 AND state<>'accepted')
    OR EXISTS(SELECT 1 FROM gugu_im_file_tool_receipts WHERE user_id=$1 AND session_id=$2 AND state IN('pending','unknown'))
    OR EXISTS(SELECT 1 FROM gugu_im_reaction_receipts WHERE user_id=$1 AND session_id=$2 AND state IN('pending','unknown'))
    OR EXISTS(SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2 AND state NOT IN('completed','cancelled','dead'))
    OR EXISTS(SELECT 1 FROM gugu_im_reflection_trigger_windows WHERE user_id=$1 AND session_id=$2 AND status='pending')
    OR EXISTS(SELECT 1 FROM memory_reflection_jobs j WHERE j.owner_user_id=$1 AND j.status NOT IN('completed','dead')
      AND(EXISTS(SELECT 1 FROM conversation_messages m WHERE m.session_id=$2 AND m.id>=j.from_message_id AND m.id<=j.to_message_id)
        OR(j.from_message_id IS NULL OR j.to_message_id IS NULL) AND j.platform=$3 AND j.bot_id=$4))
    OR EXISTS(SELECT 1 FROM agent_run_events e WHERE e.user_id=$1 AND e.session_id=$2 AND
      CASE WHEN EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=e.user_id AND r.session_id=e.session_id AND r.run_id=e.run_id AND r.state='dispatched')
       OR EXISTS(SELECT 1 FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id)
       THEN e.sequence>coalesce((SELECT d.cursor FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id),0)
       ELSE e.acknowledged_at IS NULL END) AS busy`,[target.user_id,target.session_id,session.source,session.bot_id])).rows[0]
  if(!row||typeof row.busy!=='boolean')throw invalid()
  if(row.busy)return true
  const pending=await options.pendingAsk(client,target.user_id,target.session_id,signal)
  if(!['clear','pending','unknown'].includes(pending))throw invalid()
  if(pending==='unknown')diagnose('im_retention_pending_unknown')
  return pending!=='clear'
 }
 async function runTarget(target:Target,signal:AbortSignal){
  try{return await withPostgresTransaction(options.pool,async client=>{
   signal.throwIfAborted();const session=await lockSession(client,target,true)
   if(!session)return{messages:0,interactions:0,deferred:1}
   const job=(await client.query<{generation:string}>(`SELECT generation::text FROM gugu_im_history_retention_targets
    WHERE user_id=$1 AND session_id=$2 AND generation>completed_generation AND next_attempt_at<=clock_timestamp() FOR UPDATE`,[target.user_id,target.session_id])).rows[0]
   if(!job)return{messages:0,interactions:0,deferred:0}
   if(await busy(client,target,session,signal)){
    await client.query("UPDATE gugu_im_history_retention_targets SET next_attempt_at=clock_timestamp()+$3*interval '1 millisecond' WHERE user_id=$1 AND session_id=$2",[target.user_id,target.session_id,deferMs])
    return{messages:0,interactions:0,deferred:1}
   }
   const summary=(await client.query<{count:string;baseline:string}>(`SELECT count(*)::text AS count,
    coalesce((SELECT coalesce(nullif(covers_until_seq,0),$3::bigint,0) FROM conversation_messages WHERE session_id=$2 AND role='summary' ORDER BY conversation_seq DESC LIMIT 1),0)::text AS baseline
    FROM conversation_messages WHERE session_id=$2 AND EXISTS(SELECT 1 FROM conversation_sessions WHERE id=$2 AND user_id=$1)`,[target.user_id,target.session_id,session.baseline_message_seq??0])).rows[0]!
   let ids:number[]=[],interactions=0,more=false
   if(BigInt(summary.count)>2000n&&BigInt(summary.baseline)>0n){
    ids=(await client.query<{id:number}>(candidates,[target.user_id,target.session_id,summary.baseline])).rows.map(row=>row.id)
    if(ids.length){
     // reuse先SHARE源附件再提交clone；等待它后重查，不能沿用等待前的删除判断。
     await client.query('SELECT attach_id FROM chat_attachments WHERE user_id=$1 AND message_id=ANY($2::integer[]) ORDER BY attach_id FOR UPDATE',[target.user_id,ids])
     const eligible=new Set((await client.query<{id:number}>(candidates,[target.user_id,target.session_id,summary.baseline])).rows.map(row=>row.id))
     ids=ids.filter(id=>eligible.has(id))
    }
    if(ids.length){
     await options.beforeRemoveLocked(client,target.user_id,target.session_id,ids)
     const keys=(await client.query<{storage_key:string}>(`SELECT DISTINCT storage_key FROM chat_attachments WHERE user_id=$1 AND message_id=ANY($2::integer[])`,[target.user_id,ids])).rows.map(row=>row.storage_key)
     await enqueueCleanupLocked(client,target.user_id,keys)
     await client.query('DELETE FROM chat_attachments WHERE user_id=$1 AND message_id=ANY($2::integer[])',[target.user_id,ids])
     const removed=await client.query('DELETE FROM conversation_messages WHERE session_id=$1 AND id=ANY($2::integer[])',[target.session_id,ids]);if(removed.rowCount!==ids.length)throw invalid()
    }
    more=(await client.query(candidates,[target.user_id,target.session_id,summary.baseline])).rows.length>0
    if(!more){const removed=await client.query(`DELETE FROM interaction_prompts WHERE user_id=$1 AND session_id=$2
      AND status IN('resolved','expired','cancelled') AND created_at<(SELECT min(created_at) FROM conversation_messages WHERE session_id=$2 AND role<>'summary')`,[target.user_id,target.session_id]);interactions=removed.rowCount??0}
   }
   await client.query(`UPDATE gugu_im_history_retention_targets SET completed_generation=CASE WHEN $3 THEN completed_generation ELSE generation END,
    attempts=0,next_attempt_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2`,[target.user_id,target.session_id,more])
   signal.throwIfAborted();return{messages:ids.length,interactions,deferred:0}
  })}catch{
   diagnose('im_history_retention_failed')
   // 错误后只更新自己任务的重试时间，同样遵守session→job；数据库异常不伪装已完成。
   try{await withPostgresTransaction(options.pool,async client=>{if(!await lockSession(client,target,true))return
    await client.query("UPDATE gugu_im_history_retention_targets SET attempts=LEAST(attempts+1,1000),next_attempt_at=clock_timestamp()+$3*interval '1 millisecond' WHERE user_id=$1 AND session_id=$2",[target.user_id,target.session_id,deferMs])})}catch{}
   throw invalid()
  }
 }
 async function cleanup(signal:AbortSignal){
  const rows=(await options.pool.query<{user_id:string;storage_key:string;generation:string}>(`SELECT user_id,storage_key,generation::text FROM gugu_im_history_retention_storage
   WHERE next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,user_id,storage_key LIMIT 500`)).rows
  let cursor=0,processed=0
  await Promise.all(Array.from({length:concurrency},async()=>{while(cursor<rows.length){signal.throwIfAborted();const row=rows[cursor++]!
   try{
    if(!safeKey(normalizeFileOwnerId(row.user_id),row.storage_key))throw invalid()
    await options.removeIfUnreferenced(row.user_id,row.storage_key)
    await options.pool.query('DELETE FROM gugu_im_history_retention_storage WHERE user_id=$1 AND storage_key=$2 AND generation=$3',[row.user_id,row.storage_key,row.generation]);processed++
   }catch{
    diagnose('im_history_storage_cleanup_failed')
    await options.pool.query("UPDATE gugu_im_history_retention_storage SET attempts=LEAST(attempts+1,1000),next_attempt_at=clock_timestamp()+$4*interval '1 millisecond' WHERE user_id=$1 AND storage_key=$2 AND generation=$3",[row.user_id,row.storage_key,row.generation,deferMs])
   }
  }}));return processed
 }
 function processCleanup(rawSignal?:AbortSignal):Promise<number>{
  if(closed)return Promise.reject(invalid());if(cleaning)return cleaning
  cleaning=cleanup(signalFor(rawSignal)).catch(()=>{throw invalid()}).finally(()=>{cleaning=null});return cleaning
 }
 return{
  enqueueCleanupLocked,
  async touchLocked(client:PoolClient,identity:RunIdentity){try{if(closed)throw invalid();await touch(client,{user_id:normalizeFileOwnerId(identity.ownerId),session_id:sessionNumber(identity.sessionId)},identity.runId)}catch{throw invalid()}},
  async schedule(rawOwner:string,sessionId:string|number){try{if(closed)throw invalid();const target={user_id:normalizeFileOwnerId(rawOwner),session_id:sessionNumber(sessionId)}
   await withPostgresTransaction(options.pool,client=>touch(client,target))}catch{throw invalid()}},
  processCleanup,
  scan(rawSignal?:AbortSignal):Promise<ImHistoryRetentionStats>{
   if(closed)return Promise.reject(invalid());if(scanning)return scanning
   const signal=signalFor(rawSignal)
   scanning=(async()=>{
    signal.throwIfAborted();const targets=(await options.pool.query<Target>(`SELECT user_id,session_id FROM gugu_im_history_retention_targets
     WHERE generation>completed_generation AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,user_id,session_id LIMIT $1`,[concurrency])).rows
    const results=await Promise.all(targets.map(target=>runTarget(target,signal)))
    const storageProcessed=await processCleanup(signal)
    return{targets:targets.length,messages:results.reduce((sum,row)=>sum+row.messages,0),interactions:results.reduce((sum,row)=>sum+row.interactions,0),
     deferred:results.reduce((sum,row)=>sum+row.deferred,0),storageProcessed}
   })().catch(()=>{throw invalid()}).finally(()=>{scanning=null});return scanning
  },
  async close(){closed=true;controller.abort();await Promise.allSettled([scanning,cleaning].filter((v):v is Promise<ImHistoryRetentionStats>|Promise<number>=>v!==null))},
 }
}
