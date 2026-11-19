import { createHash,randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { MessageArea,ReflectionSnapshots,buildOwnerReflectionInput,createReflectionFinalizer,runContextBranch,stableJson,
  reflectionEligibility,type CanonicalRunContext,type ReflectionProjectionPort,type ReflectionSnapshot,type RunIdentity } from '@gugu/core/agent'
import type { ProviderWire } from '@gugu/core/providers'
import { imContextPolicy } from '@gugu/core/im/access'
import { normalizeOwnerId } from '../../../../shared/owner-context.js'
import { decryptAgentDispatchInput } from '../../../agent/run/dispatch.js'
import { createPostgresAgentRunStore } from '../../../agent/run/store.js'
import { recordAgentUsage } from '../../../agent/run/usage.js'
import { imActorInputForDispatch } from '../agent/reconstruct.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { createImRunScope } from '../agent/scope.js'
import { createImInboundEnvelope } from '../inbound/envelope.js'
import { createImReflectionCodec,reflectionScopeHash } from './codec.js'
import { createImReflectionFiles,type ImReflectionFilePlan } from './files.js'
import type { ImReflectionJob,ImReflectionService,ImReflectionServiceOptions,ImReflectionRuntime } from './contracts.js'
import {createImReflectionTriggers,readImReflectionScopeVersions} from './triggers.js'
import {loadImReflectionPassiveTail,ImReflectionTailError} from './tail.js'
import {parseGroupDailyEntries,shouldCompactGroupDaily} from '@gugu/core/im-group-daily-compaction'
import {prepareImGroupDailyPlan} from './daily.js'
import {parseOwnerDailyEntries,OWNER_DAILY_COMPACTION_TRIGGER} from '@gugu/core/owner-daily-compaction'
import {prepareImOwnerDailyPlan,ImOwnerDailyCompactionError} from './owner.js'
import {ownerPeriodicDue} from '@gugu/core/owner-periodic'
import {prepareImOwnerPeriodicPlan,ImOwnerPeriodicError} from './periodic.js'

interface Job extends ImReflectionJob {ownerRevision:number;throughMessageId:number;throughMessageSeq:number;triggerReason?:'threshold'|'idle';dailyDrain?:{count:number;digest:string};periodic?:{field:'profile'|'pattern';attemptAt?:number;requestStarted?:true}}
interface Row {id:string;user_id:string;session_id:number;run_id:string;scope_hash:string;scope_version:number;attempts:number;token:string;nonce:Buffer;payload:Buffer;plan_nonce:Buffer|null;plan_payload:Buffer|null}
const digest=(v:unknown)=>createHash('sha256').update(stableJson(v)).digest('hex')
const services={digest,nextId:randomUUID},invalid=()=>new Error('反思任务暂不可用')
const same=(a:RunIdentity,b:RunIdentity)=>a.ownerId===b.ownerId&&a.sessionId===b.sessionId&&a.runId===b.runId
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const frozenScopeVersion=(versions:Record<string,unknown>,hash:string):number=>{
  const value=versions[hash];return value===undefined?0:typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:NaN
}
class Deferred extends Error{constructor(){super('反思任务等待会话空闲或可信快照')}}
class SessionBusy extends Deferred{}
class OwnerPlanPending extends Deferred{}
class Stale extends Error{constructor(){super('反思任务来源或权限已变化')}}
const retryMinutes=[1,5,30,120,360]

/** 与正式clearOwner共用的owner互斥；其他本地记忆写入也应复用此边界。 */
export async function withImReflectionOwnerLock<T>(pool:ImReflectionServiceOptions['pool'],ownerId:string,work:(client:PoolClient,assert:()=>Promise<void>)=>Promise<T>):Promise<T>{
  ownerId=normalizeOwnerId(ownerId)
  const hash=createHash('sha256').update(`gugu-im-reflection-owner-v1:${ownerId}`).digest(),keys=[hash.readInt32BE(0),hash.readInt32BE(4)]
  const client=await pool.connect();let lost=false,locked=false
  const fail=()=>{lost=true};client.on('error',fail);client.on('end',fail)
  try{
    const acquired=await client.query('SELECT pg_try_advisory_lock($1,$2) AS held',keys)
    if(acquired.rows[0]?.held!==true)throw new Deferred();locked=true
    const assert=async()=>{if(lost)throw invalid()
      const held=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
        AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=2) AS held`,keys.map(k=>k>>>0))
      if(held.rows[0]?.held!==true)throw invalid()}
    return await work(client,assert)
  }catch(error){if(!(error instanceof Deferred)&&!(error instanceof Stale)&&!(error instanceof ImOwnerDailyCompactionError)&&!(error instanceof ImOwnerPeriodicError))throw invalid();throw error}
  finally{if(locked&&!lost)try{await client.query('SELECT pg_advisory_unlock($1,$2)',keys)}catch{lost=true}
    client.removeListener('error',fail);client.removeListener('end',fail);client.release(lost)}
}

/** 持久任务只保存加密业务事实/文件计划；Provider wire始终局限于本进程快照。 */
export function createImReflectionService(options:ImReflectionServiceOptions):ImReflectionService{
  if(!options.secretKey||!options.storageRoot||typeof options.memoryEnabled!=='function'||typeof options.resolveRuntime!=='function'
    ||typeof options.rebuildOwnerSnapshot!=='function'||typeof options.readRoute!=='function'||typeof options.readRouteLocked!=='function'||typeof options.diagnose!=='function')throw invalid()
  const leaseMs=options.leaseMs??120000,pollMs=options.pollMs??1000
  if(!Number.isSafeInteger(leaseMs)||leaseMs<1000||leaseMs>900000||!Number.isSafeInteger(pollMs)||pollMs<10||pollMs>60000)throw invalid()
  const codec=createImReflectionCodec(options.secretKey),files=createImReflectionFiles(options.storageRoot)
  const envelope=createImInboundEnvelope(options.secretKey)
  const access=createPostgresImAccess({query:(q,p)=>options.pool.query(q,p),supportedPlatforms:options.supportedPlatforms})
  const snapshots=new ReflectionSnapshots<unknown>(services,Date.now,900000,128)
  const store=createPostgresAgentRunStore<CanonicalRunContext>(options.pool,options.secretKey,{async writeHistory(){throw invalid()}})
  const triggers=createImReflectionTriggers({pool:options.pool,secretKey:options.secretKey})
  let active:Promise<void>|null=null,controller:AbortController|null=null,wake:(()=>void)|null=null
  const notify=()=>{wake?.();wake=null}
  async function source(identity:RunIdentity,client:Pick<PoolClient,'query'>=options.pool){
    const row=(await client.query('SELECT nonce,payload FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
    if(!row)return null
    const dispatched=decryptAgentDispatchInput(options.secretKey,identity,row.nonce,row.payload)
    if(dispatched.v!==3||dispatched.source!=='im')return null
    const route=client===options.pool?await options.readRoute(identity):await options.readRouteLocked(client as PoolClient,identity)
    if(!route)throw new Stale()
    const input=imActorInputForDispatch({identity,input:dispatched},route)
    const currentAccess=client===options.pool?access:createPostgresImAccess({query:async(q,p)=>client.query(q,p),supportedPlatforms:options.supportedPlatforms})
    if(!await currentAccess.readBot(input))throw new Stale()
    const snapshot=await currentAccess.snapshot(input),actor=snapshot.actor(input)
    if(!await currentAccess.authorizeDelivery(actor,snapshot.bot))throw new Stale()
    const messageIds=(dispatched.im.batch?.messageIds??[dispatched.userMessageId]).map(String)
    const proof=createImRunScope({pool:client,identity,actor,scope:{...actor},messageIds,payload:route.payload,secretKey:options.secretKey,
      authorize:()=>currentAccess.authorizeDelivery(actor,snapshot.bot)})
    await proof.read()
    const flags=(await client.query(`SELECT group_memory_enabled,member_memory_enabled FROM user_bots WHERE user_id=$1 AND id=$2::integer AND platform=$3 AND enabled IS TRUE`,
      [identity.ownerId,actor.botId,actor.platform])).rows[0]
    if(!flags||typeof flags.group_memory_enabled!=='boolean'||typeof flags.member_memory_enabled!=='boolean')throw invalid()
    return{dispatched,route,input,actor,snapshot,flags,messageIds}
  }
  async function cursor(client:Pick<PoolClient,'query'>,job:Pick<ImReflectionJob,'identity'|'actor'|'scope'>,create=false){
    const values=[job.identity.ownerId,job.actor.platform,job.actor.botId,job.scope.type,job.scope.id]
    if(create)await client.query(`INSERT INTO memory_reflection_cursors(owner_user_id,platform,bot_id,scope_type,scope_id,scope_version,pending_passive_count,pending_agent_count,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,0,0,0,clock_timestamp(),clock_timestamp()) ON CONFLICT(owner_user_id,platform,bot_id,scope_type,scope_id) DO NOTHING`,values)
    const result=await client.query(`SELECT c.scope_version,c.last_reflected_message_id,
      COALESCE((SELECT p.last_sequence FROM gugu_im_reflection_cursor_positions p WHERE p.user_id=c.owner_user_id AND p.session_id=$6
        AND p.scope_hash=$7 AND p.scope_version=c.scope_version),
        (SELECT m.conversation_seq FROM conversation_messages m WHERE m.session_id=$6 AND m.id=c.last_reflected_message_id),0)::text AS node_last_sequence,
      EXISTS(SELECT 1 FROM gugu_im_reflection_cursor_positions p WHERE p.user_id=c.owner_user_id AND p.session_id=$6 AND p.scope_hash=$7 AND p.scope_version=c.scope_version) AS node_position,
      EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_user_id=$1 AND t.platform=$2 AND t.bot_id=$3 AND t.scope_type=$4 AND t.scope_id=$5) AS tombstoned
      FROM memory_reflection_cursors c WHERE owner_user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_type=$4 AND scope_id=$5`,[...values,job.identity.sessionId,reflectionScopeHash(job,options.secretKey)])
    return result.rows[0] as{scope_version:number;last_reflected_message_id:number|null;tombstoned:boolean;node_last_sequence:string;node_position:boolean}|undefined
  }
  async function authorized(job:Job,row:Row,client:Pick<PoolClient,'query'>){
    if(await options.memoryEnabled(job.identity)!==true)throw new Stale()
    if(row.plan_payload===null&&(await client.query(`SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND id<>$2
      AND plan_payload IS NOT NULL AND state NOT IN('completed','cancelled','dead') LIMIT 1`,[job.identity.ownerId,row.id])).rowCount)throw new OwnerPlanPending()
    const src=await source(job.identity);if(!src||stableJson(src.actor)!==stableJson(job.actor)||stableJson(src.messageIds)!==stableJson(job.messageIds))throw new Stale()
    if(job.scope.type==='owner'&&job.scope.id!==job.identity.sessionId
      ||job.scope.type==='group'&&(src.actor.chatType!=='group'||job.scope.id!==src.actor.chatId))throw new Stale()
    if(job.scope.type==='platform-user'){
      const prefix=src.actor.chatType==='group'?`${src.actor.chatId}:`:''
      if(prefix&&!job.scope.id.startsWith(prefix))throw new Stale()
      const speaker=prefix?job.scope.id.slice(prefix.length):job.scope.id
      if(!speaker||src.actor.chatType==='c2c'&&speaker!==src.actor.platformUserId
        ||src.snapshot.resolve({...src.input,platformUserId:speaker}).role!=='member')throw new Stale()
    }
    if(job.scope.type==='owner'&&!imContextPolicy(src.actor,src.snapshot.bot,true).allowMemoryReflection
      ||job.scope.type==='group'&&!src.flags.group_memory_enabled||job.scope.type==='platform-user'&&!src.flags.member_memory_enabled)throw new Stale()
    const current=await cursor(client,job),ownerRevision=(await client.query('SELECT revision::text FROM gugu_im_reflection_owner_revisions WHERE user_id=$1',[job.identity.ownerId])).rows[0]
    if(!current||current.tombstoned||Number(ownerRevision?.revision??0)!==job.ownerRevision)throw new Stale()
    if(current.scope_version!==row.scope_version){
      // 仅本Session已提交的Node反思进度可重绑未准备计划的排队任务；外部scope生命周期变化不放行。
      if(!current.node_position||row.plan_payload!==null||!await advancedByNode(client,job,row.scope_version,current.scope_version))throw new Stale()
      const rebound=await client.query(`UPDATE gugu_im_reflection_jobs SET scope_version=$3 WHERE id=$1 AND token=$2
        AND scope_version=$4 AND plan_payload IS NULL AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[row.id,row.token,current.scope_version,row.scope_version])
      if(rebound.rowCount!==1)throw new Stale();row.scope_version=current.scope_version
    }
    const state=(await client.query(`SELECT 1 FROM conversation_sessions s JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
      WHERE s.user_id=$1 AND s.id=$2 AND d.run_id=$3 AND d.state='done'
        AND s.active_run_id IS NULL AND (s.execution_state IS NULL OR s.execution_state='idle') AND COALESCE(s.pending_message_count,0)=0
        AND NOT EXISTS(SELECT 1 FROM agent_run_dispatch n WHERE n.user_id=s.user_id AND n.session_id=s.id AND n.state IN ('selected','queued'))`,
      [job.identity.ownerId,job.identity.sessionId,job.identity.runId])).rows
    if(state.length!==1)throw new Deferred()
    const checkpoint=await store.read(job.identity)
    if(!checkpoint||checkpoint.status!=='completed'||!checkpoint.context||checkpoint.context.modelIdentity!==job.modelIdentity||checkpoint.context.accessScopeHash!==job.accessScopeHash)throw new Stale()
    return current
  }
  async function advancedByNode(client:Pick<PoolClient,'query'>,job:Pick<ImReflectionJob,'identity'|'actor'|'scope'>,from:number,to:number):Promise<boolean>{
    if(!Number.isSafeInteger(from)||from<0||!Number.isSafeInteger(to)||to<from)return false
    if(from===to)return true
    const row=(await client.query(`SELECT count(*)::text AS n FROM gugu_im_reflection_cursor_positions WHERE user_id=$1 AND session_id=$2
      AND scope_hash=$3 AND scope_version>$4 AND scope_version<=$5`,[job.identity.ownerId,job.identity.sessionId,reflectionScopeHash(job,options.secretKey),from,to])).rows[0]
    return Number(row?.n)===to-from
  }
  async function targetMessages(job:Job,after:number){
    const sender=job.scope.type==='owner'?job.actor.platformUserId:job.scope.type==='platform-user'
      ?job.actor.chatType==='group'?job.scope.id.slice(`${job.actor.chatId}:`.length):job.scope.id:null
    const rows=(await options.pool.query(`SELECT m.id::text,r.sealed_payload FROM conversation_messages m
      JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.session_id=m.session_id AND r.user_id=$1
      WHERE m.session_id=$2 AND m.role='user' AND m.conversation_seq>$3 AND m.conversation_seq<=$4 AND r.platform=$5 AND r.bot_id=$6
        AND r.chat_type=$7 AND ($8::text IS NULL OR m.platform_user_id=$8) ORDER BY m.conversation_seq,m.id LIMIT 1001`,
      [job.identity.ownerId,job.identity.sessionId,after,job.throughMessageSeq,job.actor.platform,job.actor.botId,job.actor.chatType,sender])).rows
    if(rows.length>1000)throw invalid()
    const result:{id:string;text:string;sender:string}[]=[]
    for(const row of rows){
      const payload=envelope.open({ownerId:job.identity.ownerId,botId:job.actor.botId,platform:job.actor.platform},row.sealed_payload)
      if(payload.owner_user_id!==job.identity.ownerId||payload.bot_id!==job.actor.botId||payload.platform!==job.actor.platform
        ||payload.chat_type!==job.actor.chatType||(job.actor.chatType==='group'?payload.chat_id!==job.actor.chatId:payload.platform_user_id!==job.actor.platformUserId))throw new Stale()
      const sender=String(payload.platform_user_id??'');if(!sender)throw invalid()
      if(job.scope.type==='owner'&&sender!==job.actor.platformUserId)continue
      const member=job.actor.chatType==='group'?job.scope.id.slice(`${job.actor.chatId}:`.length):job.scope.id
      if(job.scope.type==='platform-user'&&sender!==member)continue
      result.push({id:String(row.id),text:typeof payload.text==='string'?payload.text:'',sender})
    }
    return result
  }
  async function recordReports(client:PoolClient,job:Job,runtime:ImReflectionRuntime,reports:readonly unknown[]){
    for(const report of reports){
      const names=['input','output','cacheRead','cacheWrite'] as const
      if(report===null||object(report)&&names.some(name=>report[name]===null||report[name]===undefined)){
        if((!job.dailyDrain&&!job.periodic)||job.scope.type!=='owner')throw invalid()
        options.diagnose('reflection_usage_unknown');continue
      }
      if(!object(report)||names.some(name=>!Number.isSafeInteger(report[name])||Number(report[name])<0))throw invalid()
      await recordAgentUsage(client,job.identity,{input:Number(report.input),output:Number(report.output),cacheRead:Number(report.cacheRead),cacheWrite:Number(report.cacheWrite),contextInput:null},
        runtime.usageConfig,[],[],{scenario:job.dailyDrain||job.periodic?'compaction':'reflection',source:job.actor.platform})
    }
  }
  async function enqueueDaily(client:PoolClient,job:Job,scopeVersion:number,remaining?:readonly (readonly [string,string])[]){
    if(job.scope.type==='group'?!options.readGroupCompactionPrompt:job.scope.type==='owner'?!options.readOwnerCompactionPrompt:true)return
    const entries=remaining??(job.scope.type==='owner'?parseOwnerDailyEntries((await files.readDaily(job)).daily??''):parseGroupDailyEntries(String((await files.read(job)).current.daily??'')))
    if(!entries.length||remaining===undefined&&(job.scope.type==='owner'?entries.length<OWNER_DAILY_COMPACTION_TRIGGER:!shouldCompactGroupDaily(entries.length)))return
    // 独立维护只携带来源锚点；不重复封存聊天正文，模型输入仅为本群memory/daily。
    const next:Job={...job,id:randomUUID(),ownerMessage:'',assistantEvidence:'',hadTools:false,dailyDrain:{count:entries.length,digest:digest(entries)}}
    const sealed=codec.seal(next,next,'job')
    await client.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,window_key,state,nonce,payload,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,clock_timestamp()) ON CONFLICT(user_id,session_id,run_id,scope_hash,window_key) DO NOTHING`,
      [next.id,next.identity.ownerId,next.identity.sessionId,next.identity.runId,reflectionScopeHash(next,options.secretKey),scopeVersion,`daily:${job.id}`,sealed.nonce,sealed.payload])
  }
  async function enqueuePeriodic(client:PoolClient,job:Job,scopeVersion:number){
    if(!options.readOwnerPeriodicPrompt||job.scope.type!=='owner'||job.dailyDrain||job.periodic)return
    for(const field of ['pattern','profile'] as const){
      const read=await files.readPeriodic(job,field)
      if(!ownerPeriodicDue(field,read.items.length,read.state,Date.now()/1000))continue
      if((await client.query(`SELECT 1 FROM gugu_im_reflection_jobs WHERE user_id=$1 AND window_key LIKE $2
        AND state NOT IN('completed','cancelled','dead') LIMIT 1`,[job.identity.ownerId,`periodic:${field}:%`])).rowCount)continue
      const next:Job={...job,id:randomUUID(),ownerMessage:'',assistantEvidence:'',hadTools:false,periodic:{field}}
      const sealed=codec.seal(next,next,'job')
      await client.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,window_key,state,nonce,payload,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,clock_timestamp()) ON CONFLICT(user_id,session_id,run_id,scope_hash,window_key) DO NOTHING`,
        [next.id,next.identity.ownerId,next.identity.sessionId,next.identity.runId,reflectionScopeHash(next,options.secretKey),scopeVersion,`periodic:${field}:${job.id}`,sealed.nonce,sealed.payload])
    }
  }
  async function stageWindows(signal:AbortSignal){
    if(!options.passiveMemoryEnabled)return
    await options.pool.query(`UPDATE gugu_im_reflection_trigger_windows w SET status='cancelled',completed_at=clock_timestamp()
      FROM conversation_sessions s WHERE w.status='pending' AND s.id=w.session_id AND s.user_id=w.user_id AND
        (w.owner_revision<>coalesce((SELECT revision FROM gugu_im_reflection_owner_revisions r WHERE r.user_id=w.user_id),0)
         OR EXISTS(SELECT 1 FROM memory_scope_tombstones t WHERE t.owner_user_id=w.user_id AND t.platform=s.source AND t.bot_id=s.bot_id
           AND t.scope_type='group' AND t.scope_id=s.chat_id))`)
    // 提交后通知可以丢失；从真实最终passive收据补记，观察表使恢复不重复累计。
    const pending=(await options.pool.query(`SELECT r.user_id,r.session_id,array_agg(r.message_id::text ORDER BY m.conversation_seq) AS ids
      FROM (SELECT r.* FROM gugu_im_inbound_receipts r JOIN conversation_sessions s ON s.id=r.session_id AND s.user_id=r.user_id
        JOIN users u ON u.id=s.user_id JOIN user_bots b ON b.user_id=s.user_id AND b.id::text=s.bot_id AND b.platform=s.source
        WHERE r.state='passive' AND r.run_id IS NULL AND r.chat_type='group' AND s.chat_type='group' AND s.source=r.platform AND s.bot_id=r.bot_id
          AND s.source IN('feishu','qq','telegram') AND b.enabled IS TRUE AND u.is_active IS TRUE
          AND CASE WHEN b.platform='feishu' THEN b.feishu_group_chat_enabled IS DISTINCT FROM FALSE ELSE b.group_chat_enabled IS TRUE END
          AND coalesce(u.account_status,'active')='active'
          AND NOT EXISTS(SELECT 1 FROM gugu_im_reflection_trigger_states st WHERE st.user_id=r.user_id AND st.session_id=r.session_id AND st.observe_after>clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM gugu_im_reflection_trigger_observed o WHERE o.user_id=r.user_id AND o.session_id=r.session_id AND o.kind='passive' AND o.observation_key=r.message_id::text)
        ORDER BY r.message_id LIMIT 128) r JOIN conversation_messages m ON m.id=r.message_id AND m.session_id=r.session_id
      GROUP BY r.user_id,r.session_id`)).rows
    for(const row of pending){signal.throwIfAborted();const client=await options.pool.connect()
      try{await client.query('BEGIN');await service.observePassiveLocked(client,row.user_id,Number(row.session_id),row.ids);await client.query('COMMIT')}
      catch{await client.query('ROLLBACK');options.diagnose('reflection_retry')}finally{client.release()}}
    await triggers.settleIdle()
    for(const window of await triggers.pending(16)){
      signal.throwIfAborted();const runId=window.runId;if(!runId)continue
      try{await withImReflectionOwnerLock(options.pool,window.ownerId,async(client,assertLock)=>{
        await client.query('BEGIN')
        try{
          await assertLock()
          const session=await client.query(`SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 AND active_run_id IS NULL
            AND coalesce(execution_state,'idle')='idle' AND pending_message_count=0 FOR NO KEY UPDATE NOWAIT`,[window.ownerId,window.sessionId]).catch(error=>{
              if(error?.code==='55P03')throw new SessionBusy();throw error
            })
          // 成功历史早于Run释放Session；短暂收尾不能耗掉已唤醒窗口的四分钟重试。
          if(session.rowCount!==1)throw new SessionBusy()
          const state=(await client.query(`SELECT w.status,st.last_active_run_id,st.active_generation::text,st.owner_revision::text FROM gugu_im_reflection_trigger_windows w
            JOIN gugu_im_reflection_trigger_states st ON st.user_id=w.user_id AND st.session_id=w.session_id AND st.owner_revision=w.owner_revision
            WHERE w.id=$1 AND w.user_id=$2 AND w.session_id=$3 FOR UPDATE OF w,st`,[window.id,window.ownerId,window.sessionId])).rows[0]
          if(!state||state.status!=='pending'||state.last_active_run_id!==window.runId||Number(state.active_generation)!==window.activeGeneration||Number(state.owner_revision)!==window.ownerRevision){await client.query('ROLLBACK');return}
          const identity={ownerId:window.ownerId,sessionId:String(window.sessionId),runId}
          const src=await source(identity,client);if(!src||src.actor.chatType!=='group'||!src.flags.group_memory_enabled||await options.memoryEnabled(identity)!==true)throw new Deferred()
          const seed=(await client.query<Row>("SELECT * FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND window_key='run' ORDER BY created_at,id LIMIT 1",[window.ownerId,window.sessionId,window.runId])).rows[0]
          if(!seed)throw new Deferred()
          const original=codec.open(seed,seed.nonce,seed.payload,'job') as Job
          if(original.ownerRevision!==window.ownerRevision||!same(original.identity,identity)||stableJson(original.actor)!==stableJson(src.actor))throw new Stale()
          const common={...original,throughMessageId:window.throughMessageId,throughMessageSeq:window.throughMessageSeq,triggerReason:window.reason}
          const frozen=(await client.query('SELECT scope_versions FROM gugu_im_reflection_run_revisions WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]?.scope_versions
          if(!object(frozen))throw new Stale()
          const groupJob={...common,scope:{type:'group' as const,id:src.actor.chatId!}},groupCursor=await cursor(client,groupJob,true)
          const facts=await targetMessages(groupJob,Number(groupCursor?.node_last_sequence??0))
          const scopes:ImReflectionJob['scope'][]=[groupJob.scope]
          if(src.flags.member_memory_enabled)for(const speaker of new Set(facts.map(fact=>fact.sender))){
            if(src.snapshot.resolve({...src.input,platformUserId:speaker}).role==='member')scopes.push({type:'platform-user',id:`${src.actor.chatId}:${speaker}`})}
          const ownerId=src.snapshot.bot.ownerPlatformUserId
          let ownerPending=false
          if(ownerId){const ownerJob={...common,scope:{type:'owner' as const,id:identity.sessionId}},ownerCursor=await cursor(client,ownerJob,true)
            const ownerFacts=(await client.query(`SELECT 1 FROM conversation_messages m JOIN gugu_im_inbound_receipts r ON r.message_id=m.id AND r.session_id=m.session_id AND r.user_id=$1
              WHERE m.session_id=$2 AND m.role='user' AND m.platform_user_id=$3 AND m.conversation_seq>$4 AND m.conversation_seq<=$5 AND r.platform=$6 AND r.bot_id=$7 LIMIT 1`,
              [window.ownerId,window.sessionId,ownerId,Number(ownerCursor?.node_last_sequence??0),window.throughMessageSeq,src.actor.platform,src.actor.botId])).rowCount
            if(ownerFacts&&ownerCursor&&!ownerCursor.tombstoned
              &&await advancedByNode(client,ownerJob,window.scopeVersions[reflectionScopeHash(ownerJob,options.secretKey)]??0,ownerCursor.scope_version)
              &&await advancedByNode(client,ownerJob,frozenScopeVersion(frozen,reflectionScopeHash(ownerJob,options.secretKey)),ownerCursor.scope_version)){
              if(imContextPolicy(src.actor,src.snapshot.bot,true).allowMemoryReflection)scopes.push(ownerJob.scope);else ownerPending=true}}
          for(const scope of scopes){
            let job:Job={...common,id:randomUUID(),scope}
            const cur=await cursor(client,job,true);if(!cur||cur.tombstoned||Number(cur.node_last_sequence)>=job.throughMessageSeq)continue
            if(!await advancedByNode(client,job,window.scopeVersions[reflectionScopeHash(job,options.secretKey)]??0,cur.scope_version))continue
            if(!await advancedByNode(client,job,frozenScopeVersion(frozen,reflectionScopeHash(job,options.secretKey)),cur.scope_version))continue
            if(!(await targetMessages(job,Number(cur.node_last_sequence))).length)continue
            const hash=reflectionScopeHash(job,options.secretKey),due=window.reason==='threshold'&&scope.type!=='owner'?new Date(new Date(window.createdAt).getTime()+180000):new Date()
            const reusable=(await client.query<Row>(`SELECT * FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND scope_hash=$4 AND window_key='run'
              AND state IN('pending','ready') AND attempts=0 AND token IS NULL AND plan_payload IS NULL FOR UPDATE`,[window.ownerId,window.sessionId,window.runId,hash])).rows[0]
            if(reusable){job={...job,id:reusable.id};const sealed=codec.seal(job,job,'job')
              await client.query('UPDATE gugu_im_reflection_jobs SET scope_version=$2,nonce=$3,payload=$4,next_attempt_at=LEAST(next_attempt_at,$5::timestamptz) WHERE id=$1',[job.id,cur.scope_version,sealed.nonce,sealed.payload,due])}
            else{const sealed=codec.seal(job,job,'job')
              await client.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,window_key,state,nonce,payload,next_attempt_at)
                VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10) ON CONFLICT(user_id,session_id,run_id,scope_hash,window_key) DO NOTHING`,
                [job.id,window.ownerId,window.sessionId,window.runId,hash,cur.scope_version,window.id,sealed.nonce,sealed.payload,due])}
          }
          if(ownerPending)await triggers.deferLocked(client,window.id);else await triggers.completeLocked(client,window.id)
          await assertLock();await client.query('COMMIT')
        }catch(error){await client.query('ROLLBACK');throw error}
      })}catch(error){const client=await options.pool.connect();try{await client.query('BEGIN')
        // 忙会话只延期扫描元数据，不能再次等待它的行锁；清除/删除后的旧窗口不会复活。
        if(error instanceof SessionBusy)await client.query(`UPDATE gugu_im_reflection_trigger_windows SET next_attempt_at=clock_timestamp()+interval '1 second'
          WHERE id=$1 AND user_id=$2 AND session_id=$3 AND owner_revision=$4 AND status='pending'`,[window.id,window.ownerId,window.sessionId,window.ownerRevision])
        else await triggers.deferLocked(client,window.id)
        await client.query('COMMIT')
      }catch{await client.query('ROLLBACK')}finally{client.release()};options.diagnose('reflection_deferred')}
    }
  }
  const service:ImReflectionService={
    async observePassiveLocked(client,ownerId,sessionId,messageIds){
      if(!options.passiveMemoryEnabled)return
      // 反思暂不可用不能回滚已接收消息；扫描会从未观察的真实收据恢复。
      await client.query('SAVEPOINT im_reflection_observe')
      try{await triggers.observePassiveLocked(client,{ownerId,sessionId,messageIds,enabled:await options.passiveMemoryEnabled()})
        await client.query('UPDATE gugu_im_reflection_trigger_states SET observe_after=clock_timestamp() WHERE user_id=$1 AND session_id=$2',[ownerId,sessionId])
        await client.query('RELEASE SAVEPOINT im_reflection_observe')
      }catch{await client.query('ROLLBACK TO SAVEPOINT im_reflection_observe');await client.query('RELEASE SAVEPOINT im_reflection_observe')
        await client.query(`INSERT INTO gugu_im_reflection_trigger_states(user_id,session_id,owner_revision,observe_after)
          SELECT s.user_id,s.id,coalesce(r.revision,0),clock_timestamp()+interval '4 minutes' FROM conversation_sessions s
          LEFT JOIN gugu_im_reflection_owner_revisions r ON r.user_id=s.user_id WHERE s.user_id=$1 AND s.id=$2
          ON CONFLICT(user_id,session_id) DO UPDATE SET observe_after=EXCLUDED.observe_after`,[ownerId,sessionId])
        options.diagnose('reflection_retry')}
    },
    async historyHook(client,identity,history,checkpoint){
      if(history.outcome!=='success'||!history.text.trim()||await options.memoryEnabled(identity)!==true)return
      const src=await source(identity,client);if(!src)return
      const area=MessageArea.restore(services,history.context.prepared.area),facts=Array.isArray(src.route.payload._batch_messages)?src.route.payload._batch_messages:[src.route.payload]
      const ownerMessage=facts.filter(f=>object(f)&&typeof f.platform_user_id==='string'&&src.snapshot.resolve({...src.input,platformUserId:f.platform_user_id}).role==='owner')
        .map(f=>String((f as Record<string,unknown>).text??'')).join('\n')
      const ownerInput=buildOwnerReflectionInput({ownerMessage,groupChat:src.actor.chatType==='group',reply:history.text},area)
      const scopes:ImReflectionJob['scope'][]=[]
      if(imContextPolicy(src.actor,src.snapshot.bot,true).allowMemoryReflection&&ownerMessage.trim())scopes.push({type:'owner',id:identity.sessionId})
      if(src.actor.chatType==='group'&&src.flags.group_memory_enabled)scopes.push({type:'group',id:src.actor.chatId!})
      if(src.flags.member_memory_enabled){for(const speaker of src.actor.speakerRoles??[{platformUserId:src.actor.platformUserId,role:src.actor.role}])
        // speakerRoles是混批后的有效权限；记忆身份必须逐人复核，不能把降权owner当成member。
        if(src.snapshot.resolve({...src.input,platformUserId:speaker.platformUserId}).role==='member')scopes.push({type:'platform-user',id:src.actor.chatType==='group'?`${src.actor.chatId}:${speaker.platformUserId}`:speaker.platformUserId})}
      const started=(await client.query('SELECT owner_revision::text,scope_versions FROM gugu_im_reflection_run_revisions WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[identity.ownerId,identity.sessionId,identity.runId])).rows[0]
      if(!started)throw invalid()
      const revision=Number(started.owner_revision)
      // clearOwner后完成的旧Run不能以新revision重新arm被动/idle窗口。
      // 同事务SHARE保持到history提交，避免比较之后被清除流程推进revision。
      await client.query('INSERT INTO gugu_im_reflection_owner_revisions(user_id,revision) VALUES($1,0) ON CONFLICT DO NOTHING',[identity.ownerId])
      const ownerRevision=(await client.query('SELECT revision::text FROM gugu_im_reflection_owner_revisions WHERE user_id=$1 FOR SHARE',[identity.ownerId])).rows[0]
      if(Number(ownerRevision?.revision)!==revision)return
      const throughMessageId=Number(src.messageIds.at(-1)),throughMessageSeq=Number((await client.query('SELECT conversation_seq FROM conversation_messages WHERE session_id=$1 AND id=$2',[identity.sessionId,throughMessageId])).rows[0]?.conversation_seq)
      if(!Number.isSafeInteger(throughMessageSeq)||throughMessageSeq<1)throw invalid()
      const groupScope={identity,actor:src.actor,scope:{type:'group' as const,id:src.actor.chatId??''}}
      const groupCursor=src.actor.chatType==='group'&&src.flags.group_memory_enabled?await cursor(client,groupScope,true):null
      if(groupCursor&&object(started.scope_versions)&&!groupCursor.tombstoned
        &&await advancedByNode(client,groupScope,frozenScopeVersion(started.scope_versions,reflectionScopeHash(groupScope,options.secretKey)),groupCursor.scope_version)){
        await triggers.observeActiveLocked(client,identity,throughMessageId)
        // 新真实Run提供了完整前缀；未准备文件计划的旧冷快照任务可由同窗口重新绑定，
        // 原任务仍保留，待新游标覆盖后幂等完成，不能修改已准备或未知文件计划。
        await client.query(`UPDATE gugu_im_reflection_trigger_windows w SET status='pending',completed_at=NULL,next_attempt_at=clock_timestamp()
          WHERE w.user_id=$1 AND w.session_id=$2 AND w.owner_revision=$3 AND w.status='completed' AND EXISTS(
            SELECT 1 FROM gugu_im_reflection_jobs j WHERE j.user_id=w.user_id AND j.session_id=w.session_id AND j.window_key=w.id::text
              AND j.run_id<>$4 AND j.plan_payload IS NULL AND j.state IN('pending','ready','retry','deferred'))`,[identity.ownerId,identity.sessionId,revision,identity.runId])
      }
      for(const scope of scopes){
        const job:Job={id:randomUUID(),identity,actor:src.actor,scope,messageIds:src.messageIds,modelIdentity:history.context.modelIdentity,
          accessScopeHash:history.context.accessScopeHash,contextWindow:history.context.contextWindow,ownerMessage:ownerInput.userMessage,
          assistantEvidence:ownerInput.assistantEvidence,hadTools:checkpoint.replyState.anyToolCalled,ownerRevision:revision,throughMessageId,throughMessageSeq}
        const current=await cursor(client,job,true);if(!current||current.tombstoned)continue
        if(!object(started.scope_versions)||!await advancedByNode(client,job,frozenScopeVersion(started.scope_versions,reflectionScopeHash(job,options.secretKey)),current.scope_version))continue
        const sealed=codec.seal(job,job,'job'),scopeHash=reflectionScopeHash(job,options.secretKey)
        await client.query(`INSERT INTO gugu_im_reflection_jobs(id,user_id,session_id,run_id,scope_hash,scope_version,state,nonce,payload)
          VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8) ON CONFLICT(user_id,session_id,run_id,scope_hash,window_key) DO NOTHING`,
          [job.id,identity.ownerId,identity.sessionId,identity.runId,scopeHash,current.scope_version,sealed.nonce,sealed.payload])
        // Python闲置窗口为180秒；与无法取得快照/会话忙时的240秒重试分开。
        // 连续成功对话重置同scope窗口，不修改已准备的正向文件计划。
        await client.query(`UPDATE gugu_im_reflection_jobs SET next_attempt_at=clock_timestamp()+interval '3 minutes'
          WHERE user_id=$1 AND scope_hash=$2 AND window_key='run' AND state IN ('pending','ready','deferred')`,[identity.ownerId,scopeHash])
      }
    },
    async createFinalizer(input){
      // 首次Run装配时冻结清除围栏；恢复绝不把旧Run重绑定成清除后的新revision。
      if(!(await options.pool.query('SELECT 1 FROM gugu_im_reflection_run_revisions WHERE user_id=$1 AND session_id=$2 AND run_id=$3',[input.identity.ownerId,input.identity.sessionId,input.identity.runId])).rowCount){
        const src=await source(input.identity);if(!src)throw invalid()
        const client=await options.pool.connect()
        try{await client.query('BEGIN')
          const session=await client.query('SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR NO KEY UPDATE',[input.identity.ownerId,input.identity.sessionId]);if(session.rowCount!==1)throw invalid()
          await client.query('INSERT INTO gugu_im_reflection_owner_revisions(user_id,revision) VALUES($1,0) ON CONFLICT DO NOTHING',[input.identity.ownerId])
          const revision=(await client.query('SELECT revision::text FROM gugu_im_reflection_owner_revisions WHERE user_id=$1 FOR SHARE',[input.identity.ownerId])).rows[0]?.revision
          const versions=await readImReflectionScopeVersions(client,{ownerId:input.identity.ownerId,sessionId:input.identity.sessionId,platform:src.actor.platform,botId:src.actor.botId,chatId:src.actor.chatId},options.secretKey)
          await client.query(`INSERT INTO gugu_im_reflection_run_revisions(user_id,session_id,run_id,owner_revision,scope_versions)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(user_id,session_id,run_id) DO NOTHING`,[input.identity.ownerId,input.identity.sessionId,input.identity.runId,revision,JSON.stringify(versions)])
          await client.query('COMMIT')
        }catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
      }
      const projection=await input.provider.reflectionProjection(input.identity,input.modelIdentity)
      return createReflectionFinalizer({snapshots,projection:projection as ReflectionProjectionPort<unknown>,
        async policy(id){if(!same(input.identity,id))throw invalid()
          const rows=(await options.pool.query<Row>('SELECT * FROM gugu_im_reflection_jobs WHERE user_id=$1 AND session_id=$2 AND run_id=$3 LIMIT 1',[id.ownerId,id.sessionId,id.runId])).rows
          const first=rows[0],value=first?codec.open(first,first.nonce,first.payload,'job') as Job:null
          return{enabled:rows.length===1&&await options.memoryEnabled(id)===true,scope:value?.scope.type==='group'?'group':value?.scope.type==='platform-user'?'member':'owner'}},
        async notifyReady(value){
          await options.pool.query(`UPDATE gugu_im_reflection_jobs SET state='ready',next_attempt_at=CASE WHEN state='deferred' THEN LEAST(next_attempt_at,clock_timestamp()) ELSE next_attempt_at END
            WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state IN('pending','deferred')`,[value.identity.ownerId,value.identity.sessionId,value.identity.runId])
          try{await options.pool.query("SELECT pg_notify('gugu_im_reflection_ready','')");notify()}catch{options.diagnose('reflection_notification_pending')}
        },
      })
    },
    async runOnce(outerSignal){
      const signal=outerSignal??new AbortController().signal;signal.throwIfAborted()
      await stageWindows(signal)
      await options.pool.query(`UPDATE gugu_im_reflection_jobs SET state='dead',token=NULL,lease_until=NULL
        WHERE attempts>=5 AND plan_payload IS NULL AND state IN ('running','retry') AND lease_until<=clock_timestamp()`)
      const token=randomUUID(),claimed=await options.pool.query<Row>(`WITH candidate AS (
        SELECT id FROM gugu_im_reflection_jobs WHERE state IN ('pending','ready','running','prepared','retry','deferred')
          AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (attempts<5 OR plan_payload IS NOT NULL)
        ORDER BY next_attempt_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE gugu_im_reflection_jobs j SET token=$1,lease_until=clock_timestamp()+($2*interval '1 millisecond'),state=CASE WHEN plan_payload IS NOT NULL THEN 'prepared' ELSE 'running' END,attempts=LEAST(5,attempts+1)
          FROM candidate WHERE j.id=candidate.id RETURNING j.*`,[token,leaseMs])
      const row=claimed.rows[0];if(!row)return false
      let job:Job|null=null,runtime:ImReflectionRuntime|null=null,heartbeatTask:Promise<void>|null=null,hasPlan=row.plan_payload!==null,periodicStarted=false
      const execution=new AbortController(),runSignal=AbortSignal.any([signal,execution.signal])
      const heartbeat=setInterval(()=>{
        if(heartbeatTask)return
        heartbeatTask=options.pool.query(`UPDATE gugu_im_reflection_jobs SET lease_until=clock_timestamp()+($3*interval '1 millisecond')
          WHERE id=$1 AND token=$2 AND state IN ('running','prepared') AND lease_until>clock_timestamp() RETURNING id`,[row.id,token,leaseMs])
          .then(result=>{if(result.rowCount!==1)execution.abort()}).catch(()=>execution.abort()).finally(()=>{heartbeatTask=null})
      },Math.max(100,Math.floor(leaseMs/3)))
      try{
        const decoded=codec.open(row,row.nonce,row.payload,'job')
        if(!object(decoded))throw invalid();job=decoded as unknown as Job
        if(job.id!==row.id||job.identity.ownerId!==row.user_id||job.identity.sessionId!==String(row.session_id)||job.identity.runId!==row.run_id
          ||reflectionScopeHash(job,options.secretKey)!==row.scope_hash||!Array.isArray(job.messageIds)||!job.messageIds.length)throw invalid()
        if(job.dailyDrain&&((job.scope.type!=='group'&&job.scope.type!=='owner')||!object(job.dailyDrain)||!Number.isSafeInteger(job.dailyDrain.count)
          ||job.dailyDrain.count<1||!/^[a-f0-9]{64}$/.test(job.dailyDrain.digest)))throw invalid()
        if(job.periodic&&(job.scope.type!=='owner'||job.dailyDrain||!object(job.periodic)||!['profile','pattern'].includes(job.periodic.field)
          ||job.periodic.attemptAt!==undefined&&(!Number.isFinite(job.periodic.attemptAt)||job.periodic.attemptAt<0)
          ||job.periodic.requestStarted!==undefined&&job.periodic.requestStarted!==true))throw invalid()
        const currentJob=job
        await withImReflectionOwnerLock(options.pool,row.user_id,async(client,assertLock)=>{
          const assert=async()=>{runSignal.throwIfAborted();await assertLock();const lease=await client.query(`UPDATE gugu_im_reflection_jobs SET lease_until=clock_timestamp()+($3*interval '1 millisecond')
            WHERE id=$1 AND token=$2 AND state IN ('running','prepared') AND lease_until>clock_timestamp() RETURNING id`,[row.id,token,leaseMs]);if(lease.rowCount!==1)throw invalid();return authorized(currentJob,row,client)}
          const cur=await assert()
          if(!Number.isSafeInteger(currentJob.throughMessageSeq)||currentJob.throughMessageSeq<1)throw invalid()
          if(currentJob.periodic?.requestStarted&&!row.plan_payload){
            // 上个进程已进入请求阶段但未提交计划，结果和费用未知，不能据租约过期重发模型。
            await client.query(`UPDATE gugu_im_reflection_jobs SET state='dead',last_error_code='periodic_result_unknown',token=NULL,lease_until=NULL
              WHERE id=$1 AND token=$2`,[row.id,token]);options.diagnose('reflection_dead');return
          }
          if(!currentJob.dailyDrain&&!currentJob.periodic&&Number(cur.node_last_sequence)>=currentJob.throughMessageSeq){await client.query("UPDATE gugu_im_reflection_jobs SET state='completed',token=NULL,lease_until=NULL WHERE id=$1 AND token=$2",[row.id,token]);return}
          let plan:ImReflectionFilePlan
          if(row.plan_nonce&&row.plan_payload)plan=codec.open(row,row.plan_nonce,row.plan_payload,'plan') as ImReflectionFilePlan
          else{
            if(currentJob.periodic){
              if(!options.readOwnerPeriodicPrompt)throw new Stale()
              const field=currentJob.periodic.field
              if(currentJob.periodic.attemptAt===undefined){
                const read=await files.readPeriodic(currentJob,field),now=Date.now()/1000
                if(!ownerPeriodicDue(field,read.items.length,read.state,now)){
                  await client.query("UPDATE gugu_im_reflection_jobs SET state='completed',token=NULL,lease_until=NULL WHERE id=$1 AND token=$2",[row.id,token]);return
                }
                currentJob.periodic={field,attemptAt:now}
                const sealed=codec.seal(currentJob,currentJob,'job')
                const marked=await client.query(`UPDATE gugu_im_reflection_jobs SET nonce=$3,payload=$4 WHERE id=$1 AND token=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[row.id,token,sealed.nonce,sealed.payload])
                if(marked.rowCount!==1)throw invalid()
              }
              await files.beginPeriodicAttempt(currentJob,field,currentJob.periodic.attemptAt!,async()=>{await assert()})
              periodicStarted=true
            }
            runtime=await options.resolveRuntime(currentJob,runSignal,async()=>{await assert();return true})
            if(runtime.selection.modelIdentity!==currentJob.modelIdentity||runtime.selection.accessScopeHash!==currentJob.accessScopeHash
              ||runtime.selection.contextWindow!==currentJob.contextWindow)throw new Stale()
            await assert()
            let usageReports:readonly unknown[]
            if(currentJob.periodic){
              if(!options.readOwnerPeriodicPrompt)throw new Stale()
              const prompt=await options.readOwnerPeriodicPrompt(currentJob.periodic.field)
              currentJob.periodic={...currentJob.periodic,requestStarted:true}
              const started=codec.seal(currentJob,currentJob,'job')
              const marked=await client.query(`UPDATE gugu_im_reflection_jobs SET nonce=$3,payload=$4 WHERE id=$1 AND token=$2 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,[row.id,token,started.nonce,started.payload])
              if(marked.rowCount!==1)throw invalid()
              const prepared=await prepareImOwnerPeriodicPlan({job:currentJob,field:currentJob.periodic.field,runtime,files,
                prompt,authorize:async()=>{await assert()},attemptAt:currentJob.periodic.attemptAt!,signal:runSignal})
              plan=prepared.plan;usageReports=prepared.usages
            }else if(currentJob.dailyDrain){
              const entries=(currentJob.scope.type==='owner'?parseOwnerDailyEntries((await files.readDaily(currentJob)).daily??''):parseGroupDailyEntries(String((await files.read(currentJob)).current.daily??''))).slice(-currentJob.dailyDrain.count)
              if(entries.length!==currentJob.dailyDrain.count||digest(entries)!==currentJob.dailyDrain.digest)throw new Stale()
              if(currentJob.scope.type==='owner'){
                if(!options.readOwnerCompactionPrompt||!runtime.readOwnerDailyReferences)throw new Stale()
                const prepared=await prepareImOwnerDailyPlan({job:currentJob,entries,runtime,files,prompt:await options.readOwnerCompactionPrompt(),
                  readReferences:(query,currentSignal)=>runtime!.readOwnerDailyReferences!(query,currentSignal??runSignal),authorize:async()=>{await assert()},signal:runSignal})
                plan=prepared.plan;usageReports=prepared.usages
              }else{
                if(!options.readGroupCompactionPrompt)throw new Stale()
                const prepared=await prepareImGroupDailyPlan({job:currentJob,entries,runtime,files,prompt:await options.readGroupCompactionPrompt(),authorize:async()=>{await assert()},signal:runSignal})
                plan=prepared.plan;usageReports=[prepared.usage]
              }
            }else{
            let snapshot=snapshots.peek(currentJob.identity,currentJob.modelIdentity,currentJob.accessScopeHash) as ReflectionSnapshot<ProviderWire>|null
            if(snapshot?.runId!==currentJob.identity.runId)snapshot=null
            if(!snapshot&&currentJob.scope.type==='owner'&&currentJob.triggerReason!=='threshold')snapshot=await options.rebuildOwnerSnapshot(currentJob,runtime,runSignal)
            if(!snapshot&&currentJob.scope.type==='platform-user'&&options.rebuildMemberSnapshot)snapshot=await options.rebuildMemberSnapshot(currentJob,runtime,runSignal)
            if(!snapshot)throw new Deferred()
            if(snapshot.ownerId!==currentJob.identity.ownerId||snapshot.sessionId!==currentJob.identity.sessionId||snapshot.modelIdentity!==currentJob.modelIdentity
              ||snapshot.accessScopeHash!==currentJob.accessScopeHash||snapshot.projection.dynamicTailSize!==0)throw new Stale()
            const{digest:snapshotDigest,...snapshotPayload}=snapshot
            if(digest(snapshotPayload)!==snapshotDigest)throw new Stale()
            await assert()
            const targets=await targetMessages(currentJob,Number(cur.node_last_sequence))
            if(!targets.length)throw new Stale()
            // 复用真实主请求已有正文；缺少原批消息的旧/压缩快照不得靠把正文塞进delta冒充完整前缀。
            const covered=new Set(snapshot.persistedMessageIds)
            let tail:Awaited<ReturnType<typeof loadImReflectionPassiveTail>>={messages:[],persistedMessageIds:[]}
            if(targets.some(target=>!covered.has(target.id))){
              if(currentJob.actor.chatType!=='group')throw new Deferred()
              try{tail=await loadImReflectionPassiveTail({pool:options.pool,secretKey:options.secretKey,identity:currentJob.identity,actor:currentJob.actor,
                snapshotMessageIds:snapshot.persistedMessageIds,targetMessageIds:targets.map(target=>target.id),throughMessageId:String(currentJob.throughMessageId),
                authorize:async()=>{await assert();return true}},runSignal)}
              catch(error){if(error instanceof ImReflectionTailError&&error.code==='deferred')throw new Deferred();throw error}
            }
            // Python追加真实passive tail后将旧usage置空；旧用量不代表扩展后的请求，不能据此提前压缩。
            const eligibility=reflectionEligibility({...currentJob.identity,modelIdentity:currentJob.modelIdentity,accessScopeHash:currentJob.accessScopeHash,
              bufferedSessionIds:[currentJob.identity.sessionId],scope:currentJob.scope.type==='platform-user'?'member':currentJob.scope.type,
              contextWindow:currentJob.contextWindow,reason:'idle'},tail.messages.length?{...snapshot,providerContextInput:null}:snapshot)
            if(eligibility.mode!=='reuse'||eligibility.compactBeforeReflection)throw new Deferred()
            const{current}=await files.read(currentJob)
            const instruction=currentJob.scope.type==='owner'
              ?'只维护owner自己的记忆。增量JSON字段profile_add/profile_remove/pattern_add/pattern_remove/daily/summary/lens_hint/perception；稳定画像和阶段事件分开。群聊只学习owner原话及其私人工具结果，不学习群助手回复。'
              :currentJob.scope.type==='group'?'只维护本群公开记忆，禁止提取成员个人画像。JSON字段profile_add/profile_remove/daily/summary。'
                :'只维护此平台用户在此群或私聊scope的个人记忆，不能跨群或学习其他发言人。JSON字段profile/pattern/daily/summary。'
            const targetScope={user_message_count:targets.length,senders:[...new Set(targets.map(target=>target.sender))],message_ids:targets.map(target=>target.id)}
            const delta=`已有记忆:${stableJson(current)}\n${instruction}\n目标scope:${stableJson(currentJob.scope)}\n本批反思范围:${stableJson(targetScope)}\n本批正文已在追加历史末尾提供；只提取本批范围对应用户消息的新增记忆，不复制正文，不从更早历史重新学习。`
            if(Buffer.byteLength(delta)>1048576)throw invalid()
            const reflectionProjection=await runtime.provider.reflectionMediaProjection(currentJob.identity,currentJob.modelIdentity,runSignal)
            const branchProjection=reflectionProjection.append(snapshot.projection,tail.messages)
            const result=await runContextBranch({...currentJob.identity,stableSystem:snapshot.systemPrompt,projection:branchProjection,tools:snapshot.tools,
              delta,scope:currentJob.scope.type,scopeRevision:String(row.scope_version)},
              {name:'reflection',outputMode:'json',maxOutputTokens:1600,maxRetries:0},
              {...services,provider:runtime.provider.branchProvider(currentJob.modelIdentity),pauseBeforeRetry:async()=>{throw invalid()},diagnostic(){options.diagnose('reflection_retry')}},runSignal)
            await assert()
            if(!result.ok||result.output===null)throw invalid()
            plan=await files.plan(currentJob,result.output,Date.now()/1000,()=>randomUUID().replaceAll('-','').slice(0,6))
            usageReports=[result.usage]
            }
            const sealed=codec.seal(currentJob,{...plan,responseUsages:usageReports},'plan')
            await client.query('BEGIN')
            try{
              const prepared=await client.query(`UPDATE gugu_im_reflection_jobs SET state='prepared',plan_nonce=$3,plan_payload=$4 WHERE id=$1 AND token=$2 AND lease_until>clock_timestamp() RETURNING id`,[row.id,token,sealed.nonce,sealed.payload])
              if(prepared.rowCount!==1)throw invalid()
              await recordReports(client,currentJob,runtime,usageReports)
              await client.query('COMMIT')
              hasPlan=true
            }catch(error){await client.query('ROLLBACK');throw error}
          }
          await assert()
          if(currentJob.dailyDrain&&(!Array.isArray(plan.dailyRemainingEntries)||plan.dailyRemainingEntries.length>=currentJob.dailyDrain.count))throw invalid()
          // 文件写入前撤回旧投影并围栏在途重建；同owner锁保持至cursor/Job提交完成。
          await client.query('BEGIN')
          try{
            await client.query(`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
              VALUES($1,'memory','','','refresh','ready',1,1,0,NULL,NULL,NULL,clock_timestamp(),NULL,'[]'::json,clock_timestamp(),clock_timestamp())
              ON CONFLICT(user_id,source_type) DO UPDATE SET source_id='',version='',operation='refresh',status='ready',
                generation=rag_index_jobs.generation+1,completed_generation=rag_index_jobs.generation+1,next_attempt_at=NULL,lease_until=NULL,
                last_error_code=NULL,pending_source_ids='[]'::json,updated_at=clock_timestamp()`,[row.user_id])
            await client.query("UPDATE knowledge_index_entries SET deleted_at=clock_timestamp(),indexed_at=clock_timestamp() WHERE owner_user_id=$1 AND source_type='memory' AND deleted_at IS NULL",[row.user_id])
            await client.query('COMMIT')
          }catch(error){await client.query('ROLLBACK');throw error}
          await files.apply(currentJob,plan,async()=>{await assert()})
          await client.query('BEGIN')
          try{
            await assert()
            let scopeVersion=row.scope_version
            if(!currentJob.dailyDrain&&!currentJob.periodic){
            const values=[row.user_id,currentJob.actor.platform,currentJob.actor.botId,currentJob.scope.type,currentJob.scope.id]
            const advanced=await client.query(`UPDATE memory_reflection_cursors SET scope_version=scope_version+1,last_reflected_message_id=$6,updated_at=clock_timestamp()
              WHERE owner_user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_type=$4 AND scope_id=$5 AND scope_version=$7 AND scope_version<2147483647 RETURNING scope_version`,[...values,currentJob.throughMessageId,row.scope_version])
            if(advanced.rowCount!==1)throw invalid()
            await client.query(`INSERT INTO gugu_im_reflection_cursor_positions(user_id,session_id,scope_hash,scope_version,last_sequence,last_message_id)
              VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,session_id,scope_hash,scope_version) DO UPDATE
              SET last_sequence=EXCLUDED.last_sequence,last_message_id=EXCLUDED.last_message_id WHERE gugu_im_reflection_cursor_positions.last_sequence<EXCLUDED.last_sequence`,
              [row.user_id,row.session_id,row.scope_hash,advanced.rows[0].scope_version,currentJob.throughMessageSeq,currentJob.throughMessageId])
            await client.query(`UPDATE gugu_im_reflection_jobs SET scope_version=$3 WHERE user_id=$1 AND scope_hash=$2 AND scope_version=$4 AND session_id=$5 AND state IN ('pending','ready','retry','deferred')`,[row.user_id,row.scope_hash,advanced.rows[0].scope_version,row.scope_version,row.session_id])
            scopeVersion=advanced.rows[0].scope_version
            }
            await client.query(`INSERT INTO rag_index_jobs(user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,lease_until,last_started_at,last_succeeded_at,last_error_code,pending_source_ids,created_at,updated_at)
              VALUES($1,'memory','','','refresh','queued',1,0,0,clock_timestamp(),NULL,NULL,NULL,NULL,'[]'::json,clock_timestamp(),clock_timestamp())
              ON CONFLICT(user_id,source_type) DO UPDATE SET source_id='',version='',operation='refresh',pending_source_ids='[]'::json,status='queued',generation=rag_index_jobs.generation+1,next_attempt_at=clock_timestamp(),lease_until=NULL,last_error_code=NULL,updated_at=clock_timestamp()`,[row.user_id])
            if(!currentJob.periodic)await enqueueDaily(client,currentJob,scopeVersion,currentJob.dailyDrain?plan.dailyRemainingEntries:undefined)
            if(currentJob.scope.type==='owner'&&!currentJob.dailyDrain&&!currentJob.periodic){
              // 低频维护登记失败不回滚已经完成的反思文件；保留原状态并由下一次活跃链路重查。
              await client.query('SAVEPOINT im_owner_periodic')
              try{await enqueuePeriodic(client,currentJob,scopeVersion);await client.query('RELEASE SAVEPOINT im_owner_periodic')}
              catch{await client.query('ROLLBACK TO SAVEPOINT im_owner_periodic');await client.query('RELEASE SAVEPOINT im_owner_periodic');options.diagnose('reflection_retry')}
            }
            const finished=await client.query("UPDATE gugu_im_reflection_jobs SET state='completed',token=NULL,lease_until=NULL WHERE id=$1 AND token=$2 AND lease_until>clock_timestamp() RETURNING id",[row.id,token])
            if(finished.rowCount!==1)throw invalid();await client.query('COMMIT')
            if(plan.files.length&&options.memoryChanged)try{await options.memoryChanged(row.user_id)}catch{options.diagnose('reflection_notification_pending')}
          }catch(error){await client.query('ROLLBACK');throw error}
        })
      }catch(error){
        const deferred=error instanceof Deferred||signal.aborted,stale=error instanceof Stale||error instanceof ImOwnerPeriodicError&&error.cancelled,
          state=stale?'cancelled':deferred?'deferred':!hasPlan&&(periodicStarted||row.attempts>=5)?'dead':'retry'
        // 同owner文件计划恢复后及时重查，仍不消耗模型重试预算；缺快照保持四分钟。
        const delay=error instanceof OwnerPlanPending?1/12:deferred?4:retryMinutes[Math.min(4,Math.max(0,row.attempts-1))]!
        const failedUsage=error instanceof ImOwnerDailyCompactionError||error instanceof ImOwnerPeriodicError?error.usages:[]
        const retryClient=await options.pool.connect()
        let resolvedState=state
        try{await retryClient.query('BEGIN')
          // COMMIT回包丢失时，数据库中的已准备计划优先于本进程的hasPlan推断。
          const changed=await retryClient.query(`UPDATE gugu_im_reflection_jobs SET state=CASE WHEN $3::text='dead' AND plan_payload IS NOT NULL THEN 'retry' ELSE $3::text END,
            next_attempt_at=clock_timestamp()+($4*interval '1 minute'),token=NULL,lease_until=NULL,
            attempts=CASE WHEN $3::text='deferred' THEN GREATEST(attempts-1,0) ELSE attempts END WHERE id=$1 AND token=$2 RETURNING id,state`,[row.id,token,state,delay])
          if(changed.rows[0]?.state==='retry')resolvedState='retry'
          // 失败响应仍有实际成本；与本attempt退回队列同事务，旧token不能重复记账。
          if(changed.rowCount===1&&failedUsage.length&&job&&runtime)await recordReports(retryClient,job,runtime,failedUsage)
          await retryClient.query('COMMIT')
        }catch{await retryClient.query('ROLLBACK');throw invalid()}finally{retryClient.release()}
        if(!stale)options.diagnose(deferred?'reflection_deferred':resolvedState==='dead'?'reflection_dead':'reflection_retry')
      }finally{clearInterval(heartbeat);await heartbeatTask;if(runtime)await(runtime as ImReflectionRuntime).release()}
      return true
    },
    start(){if(active)return;controller=new AbortController();const signal=controller.signal
      active=(async()=>{while(!signal.aborted){try{if(await service.runOnce(signal))continue}catch{if(!signal.aborted)options.diagnose('reflection_retry')}
        if(signal.aborted)break
        await new Promise<void>(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',finish);wake=null;resolve()},timer=setTimeout(finish,pollMs);wake=finish;signal.addEventListener('abort',finish,{once:true})})}})().finally(()=>{active=null;controller=null})
    },
    async stop(){controller?.abort();notify();await active},
    async clearOwner(rawOwner,remove){const owner=normalizeOwnerId(rawOwner)
      await withImReflectionOwnerLock(options.pool,owner,async(client,assert)=>{
        await assert();await client.query(`INSERT INTO gugu_im_reflection_owner_revisions(user_id,revision) VALUES($1,1)
          ON CONFLICT(user_id) DO UPDATE SET revision=gugu_im_reflection_owner_revisions.revision+1`,[owner])
        await client.query("UPDATE gugu_im_reflection_jobs SET state='cancelled',token=NULL,lease_until=NULL WHERE user_id=$1 AND state NOT IN ('completed','cancelled','dead')",[owner])
        await client.query("UPDATE gugu_im_reflection_trigger_windows SET status='cancelled',completed_at=clock_timestamp() WHERE user_id=$1 AND status='pending'",[owner])
        const sessions=(await client.query('SELECT DISTINCT session_id::text FROM gugu_im_reflection_jobs WHERE user_id=$1',[owner])).rows
        for(const session of sessions)snapshots.discard({ownerId:owner,sessionId:String(session.session_id)})
        await remove()
      })
    },
  }
  return service
}
