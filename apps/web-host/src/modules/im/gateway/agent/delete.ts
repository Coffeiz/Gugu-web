import type {Pool,PoolClient} from 'pg'
import {deleteAgentSessionLocked,cleanupDeletedAgentSession,type AgentSessionDeletePorts} from '@gugu/core/agent-sessions'
import type {CancellationPort,RunIdentity} from '@gugu/core/agent'
import {normalizeOwnerId} from '../../../../shared/owner-context.js'
import {decryptAgentDispatchInput,type ImAgentDispatchInput} from '../../../agent/run/dispatch.js'
import {createImInboundEnvelope} from '../inbound/envelope.js'
import {createImRetiredInbound} from '../inbound/retired.js'
import {enqueueCleanupLocked} from '../memory/history.js'
import {withImReflectionOwnerLock} from '../memory/jobs.js'
import {imActorInputForDispatch} from './reconstruct.js'
import {createImRunSourceProof} from './scope.js'
import type {ImPendingAskScope} from '@gugu/gateway'
import type {createRedisImPendingAskStore} from '../interactions/ask.js'

export class ImSessionDeleteBusy extends Error{readonly statusCode=409;constructor(){super('会话仍在处理消息或被引用，请稍后重试');this.name='ImSessionDeleteBusy'}}
export class ImSessionDeleteUnavailable extends Error{readonly statusCode=503;constructor(){super('会话删除服务暂不可用');this.name='ImSessionDeleteUnavailable'}}
export interface ImSessionDeleteOptions{
 pool:Pick<Pool,'query'|'connect'>;secretKey:string
 pendingAsks:Pick<ReturnType<typeof createRedisImPendingAskStore>,'hasPending'|'cancel'>
 cancellation:Pick<CancellationPort,'request'|'notify'>
 wakeDispatch():void|Promise<void>;wakeInteractions():void|Promise<void>;wakeMaintenance():void|Promise<void>
 diagnose?(code:'session_delete_notification_pending'|'session_delete_cleanup_pending'):void
 /** 只限已实际请求取消后的同次删除重试；不扩大到未知投递或外部引用。 */
 cancelWaitMs?:number
}
const terminals=['completed','cancelled','failed']
const quotedDependency=`SELECT 1 FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
 JOIN chat_attachments q ON q.user_id=a.user_id AND q.platform=a.platform AND q.storage_key=a.storage_key
  AND q.extra->>'im_ingress_scope'=a.extra->>'im_ingress_scope'
 LEFT JOIN conversation_messages qm ON qm.id=q.message_id LEFT JOIN conversation_sessions qs ON qs.id=qm.session_id
 WHERE a.user_id=$1 AND m.session_id=$2 AND a.state='attached' AND a.kind IN('voice','audio')
  AND a.extra->>'quoted' IS DISTINCT FROM 'true' AND q.kind IN('voice','audio') AND q.extra->>'quoted'='true'
  AND(q.state='attached' AND qm.session_id<>$2 AND qs.user_id=$1 OR q.state='draft' AND q.created_at>clock_timestamp()-interval '24 hours')`
type Decision={kind:'missing'}|{kind:'deleted';node:boolean;keys:string[]}|{kind:'busy';cancel:RunIdentity[]}

/** Web认证owner的显式删除；Node事实及删除在同Session事务内判定，不清Python状态。 */
export function createImSessionDelete(options:ImSessionDeleteOptions){
 const waitMs=options.cancelWaitMs??3000
 if(!options.secretKey||!Number.isSafeInteger(waitMs)||waitMs<0||waitMs>3000||typeof options.pendingAsks?.cancel!=='function'
  ||typeof options.pendingAsks?.hasPending!=='function'||typeof options.cancellation?.request!=='function'||typeof options.cancellation?.notify!=='function'
  ||[options.wakeDispatch,options.wakeInteractions,options.wakeMaintenance].some(fn=>typeof fn!=='function'))throw new ImSessionDeleteUnavailable()
 const retired=createImRetiredInbound(options),envelope=createImInboundEnvelope(options.secretKey)
 const diagnose=(code:'session_delete_notification_pending'|'session_delete_cleanup_pending')=>{try{options.diagnose?.(code)}catch{}}
 async function isNode(client:PoolClient,ownerId:string,sessionId:number){const owned=(await client.query(`SELECT EXISTS(SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2)
   OR EXISTS(SELECT 1 FROM gugu_im_inbound_segments WHERE user_id=$1 AND session_id=$2)
   OR EXISTS(SELECT 1 FROM gugu_im_run_delivery WHERE user_id=$1 AND session_id=$2)
   OR EXISTS(SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2) AS owned`,[ownerId,sessionId])).rows[0]?.owned
  if(typeof owned!=='boolean')throw new ImSessionDeleteUnavailable()
  if(owned)return true
  const rows=(await client.query('SELECT run_id,nonce,payload FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2',[ownerId,sessionId])).rows
  for(const row of rows){const input=decryptAgentDispatchInput(options.secretKey,{ownerId,sessionId:String(sessionId),runId:row.run_id},row.nonce,row.payload)
   if(input.v===3&&input.source==='im')return true}
  return false}
 async function authorizeOwner(client:PoolClient,ownerId:string,sessionId:number){
  // NOWAIT避免与持owner行锁后等待Session的quota/账户维护反序互锁；冲突由调用方安全重试。
  const owner=await client.query(`SELECT u.id FROM users u JOIN conversation_sessions s ON s.user_id=u.id
   WHERE u.id=$1 AND s.id=$2 AND u.is_active IS TRUE AND coalesce(u.account_status,'active')='active' FOR SHARE OF u NOWAIT`,[ownerId,sessionId])
  if(owner.rowCount!==1)throw new ImSessionDeleteBusy()
 }
 async function prove(client:PoolClient,identity:RunIdentity,row:{nonce:Buffer;payload:Buffer}){
  await authorizeOwner(client,identity.ownerId,Number(identity.sessionId))
  const input=decryptAgentDispatchInput(options.secretKey,identity,row.nonce,row.payload)
  if(input.v!==3||input.source!=='im')throw new ImSessionDeleteBusy()
  const binding={ownerId:identity.ownerId,botId:input.im.botId,platform:input.im.platform}
  const segments=(await client.query(`SELECT sealed_payload FROM gugu_im_inbound_segments
   WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='completed' AND mode='dispatch'`,[identity.ownerId,identity.sessionId,identity.runId])).rows
  let payload:Record<string,unknown>
  if(input.im.batch){if(segments.length!==1)throw new ImSessionDeleteBusy();payload=envelope.open(binding,segments[0]!.sealed_payload)}
  else{if(segments.length)throw new ImSessionDeleteBusy();const receipts=(await client.query(`SELECT sealed_payload FROM gugu_im_inbound_receipts
    WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='dispatched'`,[identity.ownerId,identity.sessionId,identity.runId])).rows
   if(receipts.length!==1)throw new ImSessionDeleteBusy();payload=envelope.open(binding,receipts[0]!.sealed_payload)}
  const source=imActorInputForDispatch({identity,input:input as ImAgentDispatchInput},{binding,payload})
  const ids=(input.im.batch?.messageIds??[input.userMessageId]).map(String)
  const all=(await client.query('SELECT message_id::text FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state=\'dispatched\'',[identity.ownerId,identity.sessionId,identity.runId])).rows
  if(all.length!==ids.length||all.some(r=>!ids.includes(r.message_id)))throw new ImSessionDeleteBusy()
  await createImRunSourceProof({pool:client,secretKey:options.secretKey,identity,scope:source,messageIds:ids,payload}).read()
  await authorizeOwner(client,identity.ownerId,Number(identity.sessionId))
 }
 async function decide(client:PoolClient,ownerId:string,sessionId:number):Promise<Decision>{
  const session=(await client.query('SELECT * FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',[ownerId,sessionId])).rows[0]
  if(!session)return{kind:'missing'}
  const node=await isNode(client,ownerId,sessionId)
  if(!node){const deleted=await deleteAgentSessionLocked(client,ownerId,sessionId);if(!deleted)throw new ImSessionDeleteUnavailable();return{kind:'deleted',node:false,keys:deleted.storageKeys}}
  await authorizeOwner(client,ownerId,sessionId)
  // Node延迟ASK只取消本Session真实scope；不能清旧Python Redis，也不能扩大到owner其他Bot/群。
  if(session.chat_type==='group'){
   if(!['feishu','qq','telegram'].includes(session.source)||!session.bot_id||!session.chat_id)throw new ImSessionDeleteBusy()
   const scope:ImPendingAskScope={ownerId,platform:session.source,botId:session.bot_id,groupId:session.chat_id}
   const at=Number((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS at')).rows[0].at)
   await options.pendingAsks.cancel(scope,at)
   if(await options.pendingAsks.hasPending(scope)!==false)throw new ImSessionDeleteBusy()
  }
  const active=(await client.query(`SELECT d.*,c.status FROM agent_run_dispatch d LEFT JOIN agent_run_checkpoints c
   ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
   WHERE d.user_id=$1 AND d.session_id=$2 AND(d.state<>'done' OR c.status NOT IN('completed','cancelled','failed')) ORDER BY d.sequence`,[ownerId,sessionId])).rows
  const cancel:RunIdentity[]=[]
  for(const row of active){
   if(terminals.includes(row.status))continue
   const identity={ownerId,sessionId:String(sessionId),runId:row.run_id}
   try{await prove(client,identity,row)}catch{throw new ImSessionDeleteBusy()}
   await client.query(`UPDATE agent_run_dispatch d SET cancel_requested=true,
    state=CASE WHEN d.state='done' THEN CASE WHEN EXISTS(SELECT 1 FROM agent_run_dispatch other WHERE other.user_id=d.user_id AND other.session_id=d.session_id AND other.state='selected') THEN 'queued' ELSE 'selected' END ELSE d.state END,
    token=CASE WHEN d.state='done' THEN NULL ELSE d.token END,lease_expires_at=CASE WHEN d.state='done' THEN NULL ELSE d.lease_expires_at END
    WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.sequence=$4`,[ownerId,sessionId,row.run_id,row.sequence])
   cancel.push(identity)
  }
  if(cancel.length){await client.query(`UPDATE conversation_sessions SET pending_message_count=(SELECT count(*) FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state='queued') WHERE user_id=$1 AND id=$2`,[ownerId,sessionId]);return{kind:'busy',cancel}}
  const busy=(await client.query(`SELECT
   EXISTS(SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state<>'done')
   OR EXISTS(SELECT 1 FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND status NOT IN('completed','cancelled','failed'))
   OR EXISTS(SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp())
   OR EXISTS(SELECT 1 FROM agent_run_startups a WHERE a.user_id=$1 AND a.session_id=$2 AND a.status='pending' AND NOT EXISTS
    (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=a.user_id AND c.session_id=a.session_id AND c.run_id=a.run_id))
   OR EXISTS(SELECT 1 FROM conversation_pending_queues WHERE user_id=$1 AND session_id=$2 AND CASE WHEN jsonb_typeof(items::jsonb)='array' THEN jsonb_array_length(items::jsonb)>0 ELSE TRUE END)
   OR EXISTS(SELECT 1 FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND state='staged')
   OR EXISTS(SELECT 1 FROM gugu_im_inbound_segments WHERE user_id=$1 AND session_id=$2 AND state='started')
   OR EXISTS(SELECT 1 FROM gugu_im_delivery_receipts WHERE user_id=$1 AND session_id=$2 AND state<>'accepted')
   OR EXISTS(SELECT 1 FROM gugu_im_native_deliveries WHERE user_id=$1 AND session_id=$2 AND state<>'accepted')
   OR EXISTS(SELECT 1 FROM gugu_im_file_tool_receipts WHERE user_id=$1 AND session_id=$2 AND state IN('pending','unknown'))
   OR EXISTS(SELECT 1 FROM gugu_im_reaction_receipts WHERE user_id=$1 AND session_id=$2 AND state IN('pending','unknown'))
   OR EXISTS(SELECT 1 FROM interaction_prompts WHERE user_id=$1 AND session_id=$2 AND status='active')
   OR EXISTS(SELECT 1 FROM agent_interaction_intents WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp())
   OR EXISTS(SELECT 1 FROM agent_interaction_resumes WHERE user_id=$1 AND session_id=$2 AND completed_at IS NULL)
   OR EXISTS(SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2 AND plan_payload IS NOT NULL AND state NOT IN('completed','cancelled','dead'))
   OR EXISTS(SELECT 1 FROM memory_reflection_jobs j WHERE j.owner_user_id=$1 AND j.status NOT IN('completed','dead') AND
    (EXISTS(SELECT 1 FROM conversation_messages m WHERE m.session_id=$2 AND m.id>=j.from_message_id AND m.id<=j.to_message_id)
     OR(j.from_message_id IS NULL OR j.to_message_id IS NULL) AND j.platform=$3 AND j.bot_id=$4))
   OR EXISTS(SELECT 1 FROM agent_run_events e WHERE e.user_id=$1 AND e.session_id=$2 AND CASE WHEN
    EXISTS(SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=e.user_id AND r.session_id=e.session_id AND r.run_id=e.run_id AND r.state='dispatched')
    OR EXISTS(SELECT 1 FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id)
    THEN e.sequence>coalesce((SELECT d.cursor FROM gugu_im_run_delivery d WHERE d.user_id=e.user_id AND d.session_id=e.session_id AND d.run_id=e.run_id),0)
    ELSE e.acknowledged_at IS NULL END) AS busy`,[ownerId,sessionId,session.source,session.bot_id])).rows[0]?.busy
  if(busy!==false||session.execution_state!=='idle'||session.active_run_id!=null||Number(session.pending_message_count)!==0)throw new ImSessionDeleteBusy()
  await client.query(`SELECT a.attach_id FROM chat_attachments a JOIN conversation_messages m ON m.id=a.message_id
   WHERE a.user_id=$1 AND m.session_id=$2 ORDER BY a.attach_id FOR UPDATE OF a`,[ownerId,sessionId])
  if((await client.query(quotedDependency,[ownerId,sessionId])).rows.length)throw new ImSessionDeleteBusy()
  await client.query("UPDATE gugu_im_reflection_jobs SET state='cancelled',token=NULL,lease_until=NULL WHERE user_id=$1 AND session_id=$2 AND state NOT IN('completed','cancelled','dead')",[ownerId,sessionId])
  await client.query("UPDATE gugu_im_reflection_trigger_windows SET status='cancelled',completed_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND status='pending'",[ownerId,sessionId])
  await retired.markLocked(client,ownerId,sessionId)
  const deleted=await deleteAgentSessionLocked(client,ownerId,sessionId);if(!deleted)throw new ImSessionDeleteUnavailable()
  await enqueueCleanupLocked(client,ownerId,deleted.storageKeys)
  return{kind:'deleted',node:true,keys:deleted.storageKeys}
 }
 return{async remove(rawOwner:string,sessionId:number,legacyPorts:AgentSessionDeletePorts):Promise<boolean>{
  try{
   const ownerId=normalizeOwnerId(rawOwner);if(!Number.isSafeInteger(sessionId)||sessionId<1)throw new ImSessionDeleteUnavailable()
   const deadline=Date.now()+waitMs;let requested=false
   // 旧Python会话不受其他Node会话反思锁影响。锁内判定后直接复用原删除SQL，无probe/fallback缝隙。
   const initial=await options.pool.connect();let legacy:Decision|null=null
   try{await initial.query('BEGIN');const session=await initial.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',[ownerId,sessionId])
    if(!session.rowCount)legacy={kind:'missing'}
    else if(!await isNode(initial,ownerId,sessionId)){const deleted=await deleteAgentSessionLocked(initial,ownerId,sessionId);if(!deleted)throw new ImSessionDeleteUnavailable();legacy={kind:'deleted',node:false,keys:deleted.storageKeys}}
    await initial.query('COMMIT')
   }catch(error){await initial.query('ROLLBACK');throw error}finally{initial.release()}
   if(legacy?.kind==='missing')return false
   if(legacy?.kind==='deleted'){await cleanupDeletedAgentSession(ownerId,sessionId,legacy.keys,legacyPorts);return true}
   for(;;){
    const outcome=await withImReflectionOwnerLock(options.pool,ownerId,async(client,assert)=>{
     await client.query('BEGIN');try{await assert();const result=await decide(client,ownerId,sessionId);await assert();await client.query('COMMIT');return{decision:result}}
     catch(error){await client.query('ROLLBACK');if(error instanceof ImSessionDeleteBusy||error instanceof ImSessionDeleteUnavailable)return{error};throw error}
    }).catch(error=>{if(requested&&Date.now()<deadline&&(error instanceof ImSessionDeleteBusy||error instanceof Error&&error.message==='反思任务等待会话空闲或可信快照'))return{kind:'busy' as const,cancel:[]};throw error})
    let decision:Decision
    if('error'in outcome){if(outcome.error instanceof ImSessionDeleteBusy&&requested&&Date.now()<deadline)decision={kind:'busy',cancel:[]};else throw outcome.error}
    else if('decision'in outcome)decision=outcome.decision!
    else decision=outcome
    if(decision.kind==='missing')return false
    if(decision.kind==='deleted'){
     if(decision.node){try{await options.wakeMaintenance()}catch{diagnose('session_delete_cleanup_pending')}}
     else await cleanupDeletedAgentSession(ownerId,sessionId,decision.keys,legacyPorts)
     return true
    }
    for(const identity of decision.cancel){requested=true;try{await options.cancellation.request(identity);await options.cancellation.notify(identity)}catch{diagnose('session_delete_notification_pending')}}
    try{await options.wakeDispatch();await options.wakeInteractions()}catch{diagnose('session_delete_notification_pending')}
    if(!requested||Date.now()>=deadline)throw new ImSessionDeleteBusy()
    await new Promise<void>(resolve=>setTimeout(resolve,Math.min(75,Math.max(1,deadline-Date.now()))))
   }
  }catch(error){if(error instanceof ImSessionDeleteBusy||error instanceof ImSessionDeleteUnavailable)throw error
   if(error instanceof Error&&error.message==='反思任务等待会话空闲或可信快照')throw new ImSessionDeleteBusy()
   throw new ImSessionDeleteUnavailable()}
 }}
}
