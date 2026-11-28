import {IM_REFLECTION_IDLE_SECONDS,IM_REFLECTION_PASSIVE_THRESHOLD} from '@gugu/core/agent/memory/reflection/window'
import {randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import type {RunIdentity} from '@gugu/core/agent'
import {normalizeOwnerId} from '../../../../shared/owner-context.js'
import {withPostgresTransaction} from '../../../../adapters/database/postgres-transaction.js'
import {decryptAgentDispatchInput} from '../../../agent/run/dispatch.js'
import {createImInboundEnvelope} from '../inbound/envelope.js'
import {imConversationDigest,imConversationFingerprint,imConversationScopeHash} from '../agent/identity.js'
import {imActorInputForDispatch} from '../agent/reconstruct.js'
import {createImRunSourceProof} from '../agent/scope.js'
import {reflectionScopeHash} from './codec.js'

export class ImReflectionTriggerError extends Error{constructor(){super('IM 反思触发状态暂不可用');this.name='ImReflectionTriggerError'}}
export interface ImReflectionWindow{id:string;ownerId:string;sessionId:number;throughMessageId:number;throughMessageSeq:number;runId:string|null;ownerRevision:number;
 reason:'threshold'|'idle';createdAt:string;activeGeneration:number;scopeVersions:Readonly<Record<string,number>>}
const fail=()=>new ImReflectionTriggerError(),integer=(raw:unknown)=>{const n=Number(raw);if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw fail();return n}
const revision=(raw:unknown)=>{const n=Number(raw);if(!Number.isSafeInteger(n)||n<0)throw fail();return n}
const limitValue=(raw:number)=>{if(!Number.isSafeInteger(raw)||raw<1||raw>500)throw fail();return raw}
function scopeVersions(value:unknown):Readonly<Record<string,number>>{
 if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))throw fail()
 const entries=Object.entries(value)
 if(entries.length>10000||entries.some(([key,version])=>!/^[a-f0-9]{64}$/u.test(key)||typeof version!=='number'||!Number.isSafeInteger(version)||version<0))throw fail()
 return Object.freeze(Object.fromEntries(entries))
}

/** 冻结窗口/首次Run共同使用的scope版本；只含哈希和数字，不是actor授权或正文快照。 */
export async function readImReflectionScopeVersions(client:Pick<PoolClient,'query'>,input:{
 ownerId:string;sessionId:string|number;platform:string;botId:string;chatId:string|null
},secretKey:string):Promise<Readonly<Record<string,number>>>{
 try{
  const ownerId=normalizeOwnerId(input.ownerId),sessionId=integer(input.sessionId)
  if(!secretKey||!['feishu','qq','wechat','telegram'].includes(input.platform)||!/^[1-9]\d*$/u.test(input.botId)
   ||input.chatId!==null&&(typeof input.chatId!=='string'||!input.chatId||input.chatId.length>8192||/[\u0000-\u001f\u007f]/u.test(input.chatId)))throw fail()
  const rows=(await client.query<{scope_type:'owner'|'group'|'platform-user';scope_id:string;scope_version:number}>(`WITH owned AS (
   SELECT s.id FROM conversation_sessions s JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=$4 AND b.platform=$3
   WHERE s.user_id=$1 AND s.id=$2 AND
    ($5::text IS NOT NULL AND s.source=$3 AND s.bot_id=$4 AND s.chat_type='group' AND s.chat_id=$5
     OR $5::text IS NULL AND s.chat_id IS NULL AND (s.chat_type IS NULL OR s.chat_type='c2c')
      AND (s.source IS NULL OR s.source='web' OR s.source=$3 AND s.bot_id=$4))
  ), scopes AS (
   SELECT 'owner'::text AS scope_type,$2::text AS scope_id FROM owned
   UNION SELECT 'group',$5::text FROM owned WHERE $5::text IS NOT NULL
   UNION SELECT 'platform-user',CASE WHEN $5::text IS NULL THEN m.platform_user_id ELSE $5||':'||m.platform_user_id END
    FROM owned JOIN conversation_messages m ON m.session_id=owned.id
    JOIN gugu_im_inbound_receipts r ON r.user_id=$1 AND r.session_id=m.session_id AND r.message_id=m.id AND r.platform=$3 AND r.bot_id=$4
    WHERE m.role='user' AND m.platform_user_id IS NOT NULL AND m.platform_user_id<>''
     AND m.chat_type=CASE WHEN $5::text IS NULL THEN 'c2c' ELSE 'group' END
     AND r.chat_type=m.chat_type
  ) SELECT s.scope_type,s.scope_id,COALESCE(c.scope_version,0) AS scope_version FROM scopes s
   LEFT JOIN memory_reflection_cursors c ON c.owner_user_id=$1 AND c.platform=$3 AND c.bot_id=$4
    AND c.scope_type=s.scope_type AND c.scope_id=s.scope_id`,[ownerId,sessionId,input.platform,input.botId,input.chatId])).rows
  if(!rows.length||rows.length>10000)throw fail()
  const versions:Record<string,number>={}
  for(const row of rows){
   if(!['owner','group','platform-user'].includes(row.scope_type)||typeof row.scope_id!=='string'||!row.scope_id||typeof row.scope_version!=='number')throw fail()
   // 哈希函数只读取owner/platform/Bot/scope；此投影不声称构造可信actor或Run。
   const hash=reflectionScopeHash({identity:{ownerId},actor:{platform:input.platform,botId:input.botId},
    scope:{type:row.scope_type,id:row.scope_id}} as Parameters<typeof reflectionScopeHash>[0],secretKey)
   if(hash in versions)throw fail();versions[hash]=row.scope_version
  }
  return scopeVersions(versions)
 }catch{throw fail()}
}
const enabledSql=`b.enabled IS TRUE AND u.is_active IS TRUE AND coalesce(u.account_status,'active')='active'
 AND s.chat_type='group' AND s.source IN('feishu','qq','telegram')
 AND CASE WHEN s.source='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE ELSE b.group_chat_enabled IS TRUE END`
const tombstonedSql=`EXISTS(SELECT 1 FROM memory_scope_tombstones tomb WHERE tomb.owner_user_id=s.user_id
 AND tomb.platform=s.source AND tomb.bot_id=s.bot_id AND tomb.scope_type='group' AND tomb.scope_id=s.chat_id)`
type State={owner_revision:string;passive_count:number;through_message_id:number;through_message_seq:string;last_active_run_id:string|null;active_generation:string}

/** 只登记真实Node触发窗口；不取模型、不制造Run、不消费pending窗口。 */
export function createImReflectionTriggers(options:{pool:Pick<Pool,'query'|'connect'>;secretKey:string}){
 if(!options.secretKey)throw fail()
 const envelope=createImInboundEnvelope(options.secretKey)
 async function session(client:PoolClient,ownerId:string,sessionId:number,skip=false){
  const row=(await client.query(`SELECT s.id,s.source,s.bot_id,s.chat_id,b.group_memory_enabled FROM conversation_sessions s
   JOIN users u ON u.id=s.user_id JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
   WHERE s.user_id=$1 AND s.id=$2 AND ${enabledSql} FOR NO KEY UPDATE OF s ${skip?'SKIP LOCKED':''}`,[ownerId,sessionId])).rows[0]
  if(!row)throw fail()
  // Session先锁；用户/Bot再NOWAIT共享锁，防撤权竞态及owner→Session维护的反向等待。
  const current=(await client.query(`SELECT s.id,s.source,s.bot_id,s.chat_id,b.group_memory_enabled,${tombstonedSql} AS tombstoned FROM conversation_sessions s
   JOIN users u ON u.id=s.user_id JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
   WHERE s.user_id=$1 AND s.id=$2 AND ${enabledSql} FOR SHARE OF b,u NOWAIT`,[ownerId,sessionId])).rows[0]
  if(!current||typeof current.group_memory_enabled!=='boolean'||typeof current.tombstoned!=='boolean'||typeof current.chat_id!=='string'||!current.chat_id)throw fail()
  return current as {id:number;source:'feishu'|'qq'|'telegram';bot_id:string;chat_id:string;group_memory_enabled:boolean;tombstoned:boolean}
 }
 async function state(client:PoolClient,ownerId:string,sessionId:number){
  await client.query('INSERT INTO gugu_im_reflection_owner_revisions(user_id,revision) VALUES($1,0) ON CONFLICT DO NOTHING',[ownerId])
  const current=revision((await client.query('SELECT revision::text FROM gugu_im_reflection_owner_revisions WHERE user_id=$1 FOR SHARE NOWAIT',[ownerId])).rows[0]?.revision)
  await client.query('INSERT INTO gugu_im_reflection_trigger_states(user_id,session_id,owner_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ownerId,sessionId,current])
  let row=(await client.query<State>('SELECT *,owner_revision::text,active_generation::text FROM gugu_im_reflection_trigger_states WHERE user_id=$1 AND session_id=$2 FOR UPDATE',[ownerId,sessionId])).rows[0]!
  if(revision(row.owner_revision)!==current){
   await client.query(`UPDATE gugu_im_reflection_trigger_windows SET status='cancelled',completed_at=clock_timestamp()
    WHERE user_id=$1 AND session_id=$2 AND status='pending' AND owner_revision<>$3`,[ownerId,sessionId,current])
   row=(await client.query<State>(`UPDATE gugu_im_reflection_trigger_states SET owner_revision=$3,passive_count=0,through_message_id=0,through_message_seq=0,
    last_active_run_id=NULL,active_at=NULL,idle_due_at=NULL,active_generation=active_generation+1
    WHERE user_id=$1 AND session_id=$2 RETURNING *,owner_revision::text,active_generation::text`,[ownerId,sessionId,current])).rows[0]!
  }
  return row
 }
 async function window(client:PoolClient,ownerId:string,sessionId:number,s:State,through:number,reason:'threshold'|'idle'){
  const current=await session(client,ownerId,sessionId)
  const versions=await readImReflectionScopeVersions(client,{ownerId,sessionId,platform:current.source,botId:current.bot_id,chatId:current.chat_id},options.secretKey)
  const id=randomUUID(),row=(await client.query(`INSERT INTO gugu_im_reflection_trigger_windows(id,user_id,session_id,owner_revision,through_message_id,through_message_seq,run_id,reason,scope_versions)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING created_at::text`,[id,ownerId,sessionId,s.owner_revision,through,s.through_message_seq,s.last_active_run_id,reason,JSON.stringify(versions)])).rows[0]!
  return{id,ownerId,sessionId,throughMessageId:through,throughMessageSeq:revision(s.through_message_seq),runId:s.last_active_run_id,ownerRevision:revision(s.owner_revision),reason,createdAt:row.created_at,activeGeneration:revision(s.active_generation),scopeVersions:versions} satisfies ImReflectionWindow
 }
 return{
  async observePassiveLocked(client:PoolClient,input:{ownerId:string;sessionId:string|number;messageIds:readonly (string|number)[];enabled?:boolean}):Promise<ImReflectionWindow[]>{
   try{
    const ownerId=normalizeOwnerId(input.ownerId),sessionId=integer(input.sessionId),ids=[...new Set(input.messageIds.map(integer))]
    if(!ids.length||ids.length>500||input.enabled!==undefined&&typeof input.enabled!=='boolean')throw fail()
    const scope=await session(client,ownerId,sessionId),s=await state(client,ownerId,sessionId),countable=input.enabled!==false&&scope.group_memory_enabled&&!scope.tombstoned
    const rows=(await client.query(`SELECT m.id,m.conversation_seq::text,m.platform_user_id,m.im_platform_message_id,r.* FROM conversation_messages m
     JOIN gugu_im_inbound_receipts r ON r.user_id=$1 AND r.session_id=m.session_id AND r.message_id=m.id
     WHERE m.session_id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND m.chat_type='group'
      AND r.state='passive' AND r.run_id IS NULL AND r.chat_type='group' AND r.platform=$4 AND r.bot_id=$5
     ORDER BY m.conversation_seq,m.id`,[ownerId,sessionId,ids,scope.source,scope.bot_id])).rows
    if(rows.length!==ids.length||new Set(rows.map(r=>r.id)).size!==ids.length)throw fail()
    const result:ImReflectionWindow[]=[]
    for(const row of rows){
     const binding={ownerId,botId:scope.bot_id,platform:scope.source},payload=envelope.open(binding,row.sealed_payload),hash=imConversationScopeHash(options.secretKey,binding,payload)
     const attachments=Array.isArray(payload.attachments)?payload.attachments.map(a=>typeof a==='string'?a:a&&typeof a==='object'?(a as Record<string,unknown>).attach_id:null):[]
     const native=payload.platform_message_id??payload.message_id
     if(revision(row.conversation_seq)===0||payload.owner_user_id!==ownerId||payload.platform!==scope.source||(payload.bot_id??payload.channel_id)!==scope.bot_id
      ||payload.bot_id!==undefined&&payload.bot_id!==scope.bot_id||payload.channel_id!==undefined&&payload.channel_id!==scope.bot_id
      ||payload.chat_type!=='group'||payload.chat_id!==scope.chat_id||payload.platform_user_id!==row.platform_user_id
      ||typeof payload.platform_user_id!=='string'||!payload.platform_user_id||typeof native!=='string'||!native||native!==row.im_platform_message_id
      ||scope.source==='telegram'&&!/^[1-9]\d*$/.test(native)||attachments.some(a=>typeof a!=='string')||row.scope_hash!==hash
      ||row.event_hash!==imConversationDigest(options.secretKey,[hash,payload.platform_user_id,payload._pending_ask_resume_id||native])
      ||row.fingerprint!==imConversationFingerprint(options.secretKey,hash,payload,attachments as string[]))throw fail()
     const observed=await client.query(`INSERT INTO gugu_im_reflection_trigger_observed(user_id,session_id,kind,observation_key,owner_revision,ignored)
      VALUES($1,$2,'passive',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING observation_key`,[ownerId,sessionId,String(row.id),s.owner_revision,!countable])
     if(!observed.rowCount||!countable)continue
     if(revision(row.conversation_seq)>revision(s.through_message_seq)){s.through_message_id=row.id;s.through_message_seq=row.conversation_seq}
     s.passive_count++
     if(s.passive_count===IM_REFLECTION_PASSIVE_THRESHOLD){result.push(await window(client,ownerId,sessionId,s,s.through_message_id,'threshold'));s.passive_count-=IM_REFLECTION_PASSIVE_THRESHOLD}
    }
    await client.query('UPDATE gugu_im_reflection_trigger_states SET passive_count=$3,through_message_id=$4,through_message_seq=$5 WHERE user_id=$1 AND session_id=$2',[ownerId,sessionId,s.passive_count,s.through_message_id,s.through_message_seq])
    return result
   }catch{throw fail()}
  },
  async observeActiveLocked(client:PoolClient,identity:RunIdentity,throughMessageId:number):Promise<void>{
   try{
    const ownerId=normalizeOwnerId(identity.ownerId),sessionId=integer(identity.sessionId),through=integer(throughMessageId)
    const scope=await session(client,ownerId,sessionId),s=await state(client,ownerId,sessionId)
    const dispatch=(await client.query(`SELECT d.nonce,d.payload,m.conversation_seq::text AS through_seq FROM agent_run_dispatch d JOIN agent_run_checkpoints c
     ON c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id
     JOIN conversation_messages m ON m.session_id=d.session_id AND m.id=$4 AND m.run_id=d.run_id
     WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND c.status='completed'`,[ownerId,sessionId,identity.runId,through])).rows[0]
    if(!dispatch)throw fail()
    const input=decryptAgentDispatchInput(options.secretKey,identity,dispatch.nonce,dispatch.payload)
    if(input.v!==3||input.source!=='im'||input.im.chatType!=='group'||input.im.platform!==scope.source||input.im.botId!==scope.bot_id||input.im.chatId!==scope.chat_id)throw fail()
    const binding={ownerId,botId:scope.bot_id,platform:scope.source},ids=input.im.batch?.messageIds??[input.userMessageId]
    const receipts=(await client.query('SELECT message_id,sealed_payload FROM gugu_im_inbound_receipts WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state=\'dispatched\'',[ownerId,sessionId,identity.runId])).rows
    if(receipts.length!==ids.length||receipts.some(r=>!ids.includes(r.message_id)))throw fail()
    let payload:Record<string,unknown>
    if(input.im.batch){const segments=(await client.query('SELECT sealed_payload FROM gugu_im_inbound_segments WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state=\'completed\'',[ownerId,sessionId,identity.runId])).rows
     if(segments.length!==1)throw fail();payload=envelope.open(binding,segments[0]!.sealed_payload)
    }else payload=envelope.open(binding,receipts[0]!.sealed_payload)
    const source=imActorInputForDispatch({identity,input},{binding,payload})
    await createImRunSourceProof({pool:client,secretKey:options.secretKey,identity,scope:source,messageIds:ids.map(String),payload}).read()
    const observed=await client.query(`INSERT INTO gugu_im_reflection_trigger_observed(user_id,session_id,kind,observation_key,owner_revision,ignored)
     VALUES($1,$2,'active',$3,$4,$5) ON CONFLICT DO NOTHING RETURNING observation_key`,[ownerId,sessionId,identity.runId,s.owner_revision,!scope.group_memory_enabled||scope.tombstoned])
    if(!observed.rowCount||!scope.group_memory_enabled||scope.tombstoned)return
    const throughSeq=revision(dispatch.through_seq);if(!throughSeq)throw fail()
    await client.query(`UPDATE gugu_im_reflection_trigger_states SET last_active_run_id=$3,
     through_message_id=CASE WHEN $5::bigint>through_message_seq THEN $4 ELSE through_message_id END,through_message_seq=greatest(through_message_seq,$5::bigint),
     active_at=clock_timestamp(),idle_due_at=clock_timestamp()+($6*interval '1 second'),active_generation=active_generation+1 WHERE user_id=$1 AND session_id=$2`,[ownerId,sessionId,identity.runId,through,throughSeq,IM_REFLECTION_IDLE_SECONDS])
    await client.query(`UPDATE gugu_im_reflection_trigger_windows SET next_attempt_at=clock_timestamp()
     WHERE user_id=$1 AND session_id=$2 AND owner_revision=$3 AND status='pending'`,[ownerId,sessionId,s.owner_revision])
   }catch{throw fail()}
  },
  async stageCompactionLocked(client:PoolClient,identity:RunIdentity,coveredUserIds:readonly string[]){
   if(!coveredUserIds.length)return
   const ownerId=normalizeOwnerId(identity.ownerId),sessionId=integer(identity.sessionId)
   const scope=await session(client,ownerId,sessionId)
   if(!scope.group_memory_enabled||scope.tombstoned)return
   const s=await state(client,ownerId,sessionId)
   const through=(await client.query(`SELECT m.id,m.conversation_seq::text FROM conversation_messages m
    JOIN gugu_im_inbound_receipts r ON r.user_id=$1 AND r.session_id=m.session_id AND r.message_id=m.id
    WHERE m.session_id=$2 AND m.id=ANY($3::integer[]) AND m.role='user' AND m.conversation_seq>0
      AND r.bot_id=$4 AND r.platform=$5 AND r.chat_type='group'
    ORDER BY m.conversation_seq DESC LIMIT 1`,[ownerId,sessionId,coveredUserIds,scope.bot_id,scope.source])).rows[0]
   if(!through)return
   const existing=await client.query(`SELECT 1 FROM gugu_im_reflection_trigger_windows
    WHERE user_id=$1 AND session_id=$2 AND owner_revision=$3 AND through_message_seq=$4
      AND reason='idle' AND status='pending'`,[ownerId,sessionId,s.owner_revision,through.conversation_seq])
   if(!existing.rowCount){
    // 压缩与闲置使用同一个可立即处理的窗口，保留各范围自己的已完成水位。
    await window(client,ownerId,sessionId,{...s,through_message_seq:through.conversation_seq},integer(through.id),'idle')
   }
  },
  async settleIdle(limit=100):Promise<ImReflectionWindow[]>{
   try{
    const rows=(await options.pool.query(`SELECT state.user_id,state.session_id FROM gugu_im_reflection_trigger_states state
     JOIN conversation_sessions s ON s.id=state.session_id AND s.user_id=state.user_id JOIN users u ON u.id=s.user_id
     JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
     WHERE state.idle_due_at<=clock_timestamp() AND ${enabledSql} AND b.group_memory_enabled IS TRUE AND NOT ${tombstonedSql}
     ORDER BY state.idle_due_at,state.session_id LIMIT $1`,[limitValue(limit)])).rows
    const result:ImReflectionWindow[]=[]
    for(const row of rows)await withPostgresTransaction(options.pool,async client=>{
     await session(client,row.user_id,row.session_id)
     const s=await state(client,row.user_id,row.session_id)
     const due=(await client.query(`SELECT 1 FROM gugu_im_reflection_trigger_states WHERE user_id=$1 AND session_id=$2 AND idle_due_at<=clock_timestamp()
      AND last_active_run_id IS NOT NULL AND through_message_id>0`,[row.user_id,row.session_id])).rowCount
     if(!due)return
     result.push(await window(client,row.user_id,row.session_id,s,s.through_message_id,'idle'))
     await client.query('UPDATE gugu_im_reflection_trigger_states SET idle_due_at=NULL,passive_count=0 WHERE user_id=$1 AND session_id=$2',[row.user_id,row.session_id])
    })
    return result
   }catch{throw fail()}
  },
  async pending(limit=100):Promise<ImReflectionWindow[]>{
   try{return(await options.pool.query(`SELECT w.*,w.created_at::text,st.last_active_run_id AS current_run_id,st.active_generation::text FROM gugu_im_reflection_trigger_windows w
    JOIN gugu_im_reflection_trigger_states st ON st.user_id=w.user_id AND st.session_id=w.session_id AND st.owner_revision=w.owner_revision
    LEFT JOIN gugu_im_reflection_owner_revisions rev ON rev.user_id=w.user_id
    JOIN conversation_sessions s ON s.id=w.session_id AND s.user_id=w.user_id JOIN users u ON u.id=s.user_id
    JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
    WHERE w.status='pending' AND w.next_attempt_at<=clock_timestamp() AND st.last_active_run_id IS NOT NULL AND coalesce(rev.revision,0)=w.owner_revision AND ${enabledSql} AND b.group_memory_enabled IS TRUE AND NOT ${tombstonedSql}
    ORDER BY w.created_at,w.id LIMIT $1`,[limitValue(limit)])).rows.map(row=>({id:row.id,ownerId:row.user_id,sessionId:integer(row.session_id),throughMessageId:integer(row.through_message_id),throughMessageSeq:revision(row.through_message_seq),runId:row.current_run_id,
     ownerRevision:revision(row.owner_revision),reason:row.reason,createdAt:row.created_at,activeGeneration:revision(row.active_generation),scopeVersions:scopeVersions(row.scope_versions)}))}catch{throw fail()}
  },
  async deferLocked(client:PoolClient,windowId:string,seconds=240):Promise<boolean>{
   try{
    if(!/^[a-f0-9-]{36}$/.test(windowId)||!Number.isSafeInteger(seconds)||seconds<0||seconds>240)throw fail()
    const w=(await client.query('SELECT user_id,session_id FROM gugu_im_reflection_trigger_windows WHERE id=$1',[windowId])).rows[0]
    if(!w)return false
    const owned=await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',[w.user_id,w.session_id]);if(!owned.rowCount)return false
    const s=await state(client,w.user_id,w.session_id)
    return(await client.query(`UPDATE gugu_im_reflection_trigger_windows SET next_attempt_at=clock_timestamp()+$3*interval '1 second'
     WHERE id=$1 AND status='pending' AND owner_revision=$2`,[windowId,s.owner_revision,seconds])).rowCount===1
   }catch{throw fail()}
  },
  async completeLocked(client:PoolClient,windowId:string):Promise<boolean>{
   try{
    if(!/^[a-f0-9-]{36}$/.test(windowId))throw fail()
    const w=(await client.query('SELECT user_id,session_id FROM gugu_im_reflection_trigger_windows WHERE id=$1',[windowId])).rows[0]
    if(!w)return false
    const owned=await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',[w.user_id,w.session_id]);if(!owned.rowCount)return false
    const s=await state(client,w.user_id,w.session_id)
    return(await client.query(`UPDATE gugu_im_reflection_trigger_windows SET status='completed',completed_at=clock_timestamp()
     WHERE id=$1 AND status='pending' AND owner_revision=$2`,[windowId,s.owner_revision])).rowCount===1
   }catch{throw fail()}
  },
 }
}
