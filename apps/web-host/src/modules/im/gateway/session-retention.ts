import type {PoolClient} from 'pg'
import {deleteAgentSessionLocked} from '@gugu/core/agent-sessions'
import {normalizeOwnerId} from '../../../shared/owner-context.js'

export interface ImRetiredSession {sessionId:number;storageKeys:string[]}
// 同一谓词用于候选过滤和附件加锁后的新快照复核；draft尚无message/session，但仍依赖原来源双证明。
const quotedVoiceDependency=`SELECT 1 FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
 JOIN chat_attachments q ON q.user_id=a.user_id AND q.platform=a.platform AND q.storage_key=a.storage_key
  AND q.extra->>'im_ingress_scope'=a.extra->>'im_ingress_scope'
 LEFT JOIN conversation_messages qm ON qm.id=q.message_id
 LEFT JOIN conversation_sessions qs ON qs.id=qm.session_id
 WHERE a.user_id=s.user_id AND m.session_id=s.id AND a.state='attached' AND a.kind IN ('voice','audio')
  AND a.extra->>'quoted' IS DISTINCT FROM 'true' AND q.kind IN ('voice','audio') AND q.extra->>'quoted'='true'
  AND (q.state='attached' AND qm.session_id<>s.id AND qs.user_id=s.user_id
   OR q.state='draft' AND q.created_at>clock_timestamp()-interval '24 hours')`
export class ImSessionRetentionError extends Error {
 constructor(readonly code:'busy'|'capacity'|'unavailable'){super('IM 会话暂不可创建');this.name='ImSessionRetentionError'}
}
/** 只在调用方READ COMMITTED事务内保留会话；返回的key由同事务持久清理队列在提交后回收。 */
export function createImSessionRetention(options:{
 /** 必须先在同事务写入Node永久去重墓碑；本方法已持有候选Session行锁，禁止反向取scope锁。 */
 beforeDeleteLocked(client:PoolClient,ownerId:string,sessionId:number):Promise<void>
}){
 if(typeof options.beforeDeleteLocked!=='function')throw new TypeError('IM 会话保留服务未装配')
 return {async beforeCreate(client:PoolClient,rawOwnerId:string):Promise<{deleted:ImRetiredSession[]}>{
  try{
   const ownerId=normalizeOwnerId(rawOwnerId)
   // 入口可能已持有当前scope/Session锁；NOWAIT使另一peer并发创建回滚重试，避免owner↔Session反序等待。
   const owner=await client.query('SELECT id FROM users WHERE id=$1::uuid FOR NO KEY UPDATE NOWAIT',[ownerId])
   if(owner.rows.length!==1)throw new ImSessionRetentionError('unavailable')
   const count=Number((await client.query('SELECT count(*)::text AS count FROM conversation_sessions WHERE user_id=$1',[ownerId])).rows[0]?.count)
   if(!Number.isSafeInteger(count)||count<0)throw new ImSessionRetentionError('unavailable')
   if(count<50)return {deleted:[]}
   const candidate=await client.query<{id:number}>(`SELECT s.id FROM conversation_sessions s WHERE s.user_id=$1
    AND s.execution_state='idle' AND s.active_run_id IS NULL AND s.pending_message_count=0
    AND NOT EXISTS(SELECT 1 FROM agent_run_leases l WHERE l.user_id=s.user_id AND l.session_id=s.id AND l.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=s.user_id AND c.session_id=s.id AND c.status NOT IN ('completed','failed','cancelled'))
    AND NOT EXISTS(SELECT 1 FROM agent_run_startups a WHERE a.user_id=s.user_id AND a.session_id=s.id AND a.status='pending'
      AND NOT EXISTS(SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id))
    AND NOT EXISTS(SELECT 1 FROM agent_run_dispatch d WHERE d.user_id=s.user_id AND d.session_id=s.id AND d.state<>'done')
    AND NOT EXISTS(SELECT 1 FROM conversation_pending_queues q WHERE q.user_id=s.user_id AND q.session_id=s.id
      AND CASE WHEN jsonb_typeof(q.items::jsonb)='array' THEN jsonb_array_length(q.items::jsonb)>0 ELSE TRUE END)
    AND NOT EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.state='staged')
    AND NOT EXISTS(SELECT 1 FROM gugu_im_inbound_segments b WHERE b.user_id=s.user_id AND b.session_id=s.id AND b.state='started')
    AND NOT EXISTS(SELECT 1 FROM interaction_prompts p WHERE p.user_id=s.user_id AND p.session_id=s.id AND p.status='active')
    AND NOT EXISTS(SELECT 1 FROM agent_interaction_intents i WHERE i.user_id=s.user_id AND i.session_id=s.id AND i.expires_at>clock_timestamp())
    AND NOT EXISTS(SELECT 1 FROM agent_interaction_resumes r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.completed_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM agent_run_events e WHERE e.user_id=s.user_id AND e.session_id=s.id AND
      CASE WHEN EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=e.user_id AND r.session_id=e.session_id
        AND r.run_id=e.run_id AND r.state='dispatched')
       OR EXISTS(SELECT 1 FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id)
      THEN e.sequence>COALESCE((SELECT d.cursor FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id),0)
      ELSE e.acknowledged_at IS NULL END)
    AND NOT EXISTS(SELECT 1 FROM gugu_im_delivery_receipts r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.state<>'accepted')
    AND NOT EXISTS(SELECT 1 FROM gugu_im_native_deliveries r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.state<>'accepted')
    AND NOT EXISTS(SELECT 1 FROM gugu_im_file_tool_receipts r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.state IN ('pending','unknown'))
    AND NOT EXISTS(SELECT 1 FROM gugu_im_reaction_receipts r WHERE r.user_id=s.user_id AND r.session_id=s.id AND r.state IN ('pending','unknown'))
    AND NOT EXISTS(SELECT 1 FROM gugu_im_reflection_trigger_windows w WHERE w.user_id=s.user_id AND w.session_id=s.id AND w.status='pending')
    AND NOT EXISTS(SELECT 1 FROM gugu_im_reflection_jobs j WHERE j.user_id=s.user_id AND j.session_id=s.id AND j.state NOT IN ('completed','cancelled','dead'))
    AND NOT EXISTS(${quotedVoiceDependency})
    AND NOT EXISTS(SELECT 1 FROM memory_reflection_jobs j WHERE j.owner_user_id=s.user_id AND j.status NOT IN ('completed','dead')
      AND (EXISTS(SELECT 1 FROM conversation_messages m WHERE m.session_id=s.id AND m.id>=j.from_message_id AND m.id<=j.to_message_id)
       OR (j.from_message_id IS NULL OR j.to_message_id IS NULL) AND j.platform=s.source AND j.bot_id=s.bot_id))
    ORDER BY s.updated_at ASC NULLS LAST,s.id ASC LIMIT 1 FOR UPDATE OF s SKIP LOCKED`,[ownerId])
   const sessionId=candidate.rows[0]?.id
   if(!Number.isSafeInteger(sessionId)||!sessionId)throw new ImSessionRetentionError('capacity')
   // reuse先持原附件SHARE至clone提交；此处等待后必须以新快照看见已提交draft，不能沿候选旧快照盲删。
   await client.query(`SELECT a.attach_id FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
    WHERE a.user_id=$1 AND m.session_id=$2 ORDER BY a.attach_id FOR UPDATE OF a`,[ownerId,sessionId])
   const referenced=await client.query(`SELECT s.id FROM conversation_sessions s WHERE s.user_id=$1 AND s.id=$2
    AND EXISTS(${quotedVoiceDependency})`,[ownerId,sessionId])
   if(referenced.rows.length)throw new ImSessionRetentionError('busy')
   await options.beforeDeleteLocked(client,ownerId,sessionId)
   const deleted=await deleteAgentSessionLocked(client,ownerId,sessionId)
   if(!deleted)throw new ImSessionRetentionError('unavailable')
   // 与Python一致：历史已超限时每次仅替换1个oldest，不批量扫掉既有存量。
   return {deleted:[{sessionId,storageKeys:deleted.storageKeys}]}
  }catch(error){
   if(error instanceof ImSessionRetentionError)throw error
   if(error&&typeof error==='object'&&'code'in error&&(error.code==='55P03'||error.code==='40P01'))throw new ImSessionRetentionError('busy')
   throw new ImSessionRetentionError('unavailable')
  }
 }}
}
