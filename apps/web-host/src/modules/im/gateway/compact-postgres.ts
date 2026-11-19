import { createHash, createHmac, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ProviderWire } from '@gugu/core/providers'
import { MessageArea, compactContext, stableJson, unwrapCompactedSummary, isCompactedSummaryMessage,
  updateBaselineSnapshot, loadSessionHistory, restoreHistoryForRequest, type CompactionPort, type RunIdentity, type SessionSnapshotState } from '@gugu/core/agent'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { resolveImAccess } from '@gugu/core/im/access'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import { canonicalBaselineHash } from '../../agent-sessions/persistence/agent-canonical-write-postgres.js'
import { enqueuePostgresAgentRagRebuild } from '../../agent-sessions/persistence/agent-rag-job-postgres.js'
import { createPostgresImAccess } from './access-postgres.js'
import { createPostgresCanonicalHistoryReader } from '../../agent-sessions/persistence/agent-canonical-history-postgres.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
export class ImCompactError extends Error { constructor() { super('IM 会话整理暂不可用'); this.name = 'ImCompactError' } }
type State = 'requesting'|'compacted'|'not_needed'|'failed'|'unknown'|'busy'|'no_session'|'denied'
export const imCompactReply = (state: State): string => state === 'compacted' ? '上下文已经整理好了，旧对话已压缩为摘要。'
  : state === 'not_needed' ? '当前历史还不够长，暂时无需整理上下文。'
    : state === 'no_session' ? '当前还没有可压缩的对话。' : state === 'busy' ? '当前会话仍在处理中，请结束后再整理上下文。'
      : state === 'denied' ? '只有绑定 Bot 的用户可以执行会读取个人数据或修改账号、会话状态的命令。' : '这次压缩没有完成，请稍后再试。'
interface HistoryRow { id: string; role: string; content: string; content_json: unknown; effective: string }
export interface ImCompactRuntime {
  modelIdentity: string
  timezone: string
  compaction: CompactionPort<ProviderWire>
  close(): Promise<void>
  /** 与摘要/baseline同事务记入实际Provider用量，不能借一次普通Run的账本。 */
  recordUsage(client: PoolClient): Promise<void>
}
interface Receipt { session_id: number|null; operation_id: string; state: State; token: string|null; fence: string|null }

/** 独立控制收据复用正式session租约表；不登记startup、不产生假Run/checkpoint。 */
export function createPostgresImCompact(options: {
  pool: Pick<Pool,'query'|'connect'>; secretKey: string
  supportedPlatforms(): readonly string[]|Promise<readonly string[]>
  readOwnerSession(client: PoolClient, scope: ImPreflightScope): Promise<number|null>
  runtime(input: { identity: RunIdentity; scope: ImPreflightScope; authorize():Promise<boolean>; signal:AbortSignal }): Promise<ImCompactRuntime>
  diagnose(code:'im_compaction_failed'):void
  leaseMs?:number
}) {
  const ttl=options.leaseMs??300000
  if(!options.secretKey || !Number.isSafeInteger(ttl)||ttl<1000||ttl>900000
    ||[options.pool?.query,options.pool?.connect,options.supportedPlatforms,options.readOwnerSession,options.runtime,options.diagnose].some(value=>typeof value!=='function'))throw new ImCompactError()
  const hash=(value:unknown)=>createHmac('sha256',options.secretKey).update('gugu-im-compact-v1\0').update(stableJson(value)).digest('hex')
  const tx=<T>(work:(client:PoolClient)=>Promise<T>)=>withPostgresTransaction(options.pool,work,()=>new ImCompactError())
  async function authorize(client:PoolClient,scope:ImPreflightScope) {
    await client.query('SELECT b.id FROM user_bots b JOIN users u ON u.id=b.user_id WHERE b.id=$1 AND b.user_id=$2 AND b.platform=$3 FOR SHARE OF b,u',[scope.botId,scope.ownerId,scope.platform])
    const bot=await createPostgresImAccess({query:(q,p)=>client.query(q,p),supportedPlatforms:options.supportedPlatforms}).readBot(scope)
    // Python受限成员不能执行会话管理指令；不得以“可以在群聊天”扩大历史写权限。
    return !!bot&&resolveImAccess(scope,bot).role==='owner'
  }
  async function release(client:PoolClient,owner:string,receipt:Receipt) {
    if(receipt.session_id===null||!receipt.token||!receipt.fence)return
    const result=await client.query(`UPDATE agent_run_leases SET expires_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND token=$4 AND fence=$5 RETURNING run_id`,[owner,receipt.session_id,receipt.operation_id,receipt.token,receipt.fence])
    if(result.rowCount===1)await client.query(`UPDATE conversation_sessions SET execution_state='idle',active_run_id=NULL
      WHERE user_id=$1 AND id=$2 AND active_run_id=$3 AND execution_state='baseline_updating'`,[owner,receipt.session_id,receipt.operation_id])
  }
  return {
    async compact(scope:ImPreflightScope,signal=new AbortController().signal):Promise<string> {
      signal.throwIfAborted()
      if(normalizeOwnerId(scope.ownerId)!==scope.ownerId||!scope.admissionCutoff||!scope.eventId||!scope.platformUserId
        ||!['feishu','qq','wechat','telegram'].includes(scope.platform)||!/^\d+$/.test(scope.botId)
        ||(scope.chatType==='group'?!scope.chatId:scope.chatType!=='c2c'||scope.chatId!==null))throw new ImCompactError()
      scope=structuredClone(scope)
      const eventHash=hash([scope.ownerId,scope.platform,scope.botId,scope.chatType,scope.chatId,scope.platformUserId,scope.eventId]),operation='im-compact:'+randomUUID(),token=randomUUID()
      const claim=await tx(async client=>{
        if(!await authorize(client,scope))return{receipt:{session_id:null,operation_id:operation,state:'denied' as const,token:null,fence:null},session:null}
        // 同event准入收据由上游永久门串行，此处仍用唯一键+事务锁防直接调用重放。
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[eventHash])
        const previous=(await client.query<Receipt>('SELECT * FROM gugu_im_compact_commands WHERE user_id=$1 AND event_hash=$2 FOR UPDATE',[scope.ownerId,eventHash])).rows[0]
        if(previous){
          if(previous.state==='requesting'){
            const live=await client.query('SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND token=$4 AND fence=$5 AND expires_at>clock_timestamp()',[scope.ownerId,previous.session_id,previous.operation_id,previous.token,previous.fence])
            if(!live.rowCount){await release(client,scope.ownerId,previous);await client.query("UPDATE gugu_im_compact_commands SET state='unknown',updated_at=clock_timestamp() WHERE user_id=$1 AND event_hash=$2",[scope.ownerId,eventHash]);previous.state='unknown'}
          }
          return {receipt:previous,session:null}
        }
        const bound=scope.chatType==='c2c'?await options.readOwnerSession(client,scope):null
        const found=bound!==null?await client.query(`SELECT * FROM conversation_sessions WHERE user_id=$1 AND id=$2 AND (source='web' OR source IS NULL) FOR UPDATE`,[scope.ownerId,bound])
          :await client.query(`SELECT * FROM conversation_sessions WHERE user_id=$1 AND source=$2 AND bot_id=$3::text
            AND CASE WHEN $4::text IS NOT NULL THEN chat_type='group' AND chat_id=$4 ELSE chat_id IS NULL AND platform_user_id=$5 AND (chat_type='c2c' OR chat_type IS NULL) END
            ORDER BY updated_at DESC,id DESC LIMIT 1 FOR UPDATE`,[scope.ownerId,scope.platform,scope.botId,scope.chatId,scope.platformUserId])
        const session=found.rows[0]
        let state:State=session?'requesting':'no_session',fence:string|null=null
        if(session){
          // 崩溃只回收本服务持久证明的旧租约；普通Run/交互/未知baseline状态不能被命令夺取。
          const abandoned=(await client.query<Receipt>(`SELECT c.* FROM gugu_im_compact_commands c JOIN agent_run_leases l ON l.user_id=c.user_id AND l.session_id=c.session_id AND l.run_id=c.operation_id AND l.token=c.token AND l.fence=c.fence
            WHERE c.user_id=$1 AND c.session_id=$2 AND c.state='requesting' AND l.expires_at<=clock_timestamp() FOR UPDATE OF c`,[scope.ownerId,session.id])).rows
          for(const old of abandoned){await release(client,scope.ownerId,old);await client.query("UPDATE gugu_im_compact_commands SET state='unknown',updated_at=clock_timestamp() WHERE user_id=$1 AND operation_id=$2",[scope.ownerId,old.operation_id]);if(session.active_run_id===old.operation_id&&session.execution_state==='baseline_updating'){session.execution_state='idle';session.active_run_id=null}}
          const waiting=await client.query("SELECT 1 FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND status='waiting' LIMIT 1",[scope.ownerId,session.id])
          const dispatch=await client.query("SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state IN ('queued','selected') LIMIT 1",[scope.ownerId,session.id])
          if(!['idle',null].includes(session.execution_state)||session.active_run_id||Number(session.pending_message_count)>0||waiting.rowCount||dispatch.rowCount)state='busy'
          else {
            const lease=await client.query(`INSERT INTO agent_run_leases(user_id,session_id,run_id,token,fence,expires_at,created_at,updated_at)
              VALUES($1,$2,$3,$4,1,clock_timestamp()+($5*interval '1 millisecond'),clock_timestamp(),clock_timestamp())
              ON CONFLICT(user_id,session_id) DO UPDATE SET run_id=EXCLUDED.run_id,token=EXCLUDED.token,fence=agent_run_leases.fence+1,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()
              WHERE agent_run_leases.expires_at<=clock_timestamp() RETURNING fence::text`,[scope.ownerId,session.id,operation,token,ttl])
            fence=lease.rows[0]?.fence??null
            if(!fence)state='busy'
            else await client.query("UPDATE conversation_sessions SET execution_state='baseline_updating',active_run_id=$3 WHERE user_id=$1 AND id=$2",[scope.ownerId,session.id,operation])
          }
        }
        await client.query(`INSERT INTO gugu_im_compact_commands(user_id,event_hash,session_id,operation_id,state,token,fence) VALUES($1,$2,$3,$4,$5,$6,$7)`,[scope.ownerId,eventHash,session?.id??null,operation,state,fence?token:null,fence])
        return {receipt:{session_id:session?.id??null,operation_id:operation,state,token:fence?token:null,fence},session:state==='requesting'?session:null}
      })
      if(!claim.session)return imCompactReply(claim.receipt.state)
      const receipt=claim.receipt,identity={ownerId:scope.ownerId,sessionId:String(receipt.session_id),runId:operation}
      const controller=new AbortController(),abort=()=>controller.abort(signal.reason)
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
      let renewal=Promise.resolve(),runtime:ImCompactRuntime|undefined
      const args=[scope.ownerId,receipt.session_id,operation,token,receipt.fence]
      async function current(){controller.signal.throwIfAborted();return tx(async client=>await authorize(client,scope)&&(await client.query(`SELECT 1 FROM agent_run_leases l JOIN conversation_sessions s ON s.user_id=l.user_id AND s.id=l.session_id
        WHERE l.user_id=$1 AND l.session_id=$2 AND l.run_id=$3 AND l.token=$4 AND l.fence=$5 AND l.expires_at>clock_timestamp() AND s.active_run_id=l.run_id AND s.execution_state='baseline_updating'`,args)).rowCount===1)}
      const timer=setInterval(()=>{renewal=renewal.then(async()=>{const result=await options.pool.query(`UPDATE agent_run_leases SET expires_at=clock_timestamp()+($6*interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND token=$4 AND fence=$5 AND expires_at>clock_timestamp() RETURNING fence`,[...args,ttl]);if(result.rowCount!==1)throw new ImCompactError()}).catch(()=>{controller.abort(new ImCompactError())})},Math.max(100,Math.floor(ttl/3)));timer.unref?.()
      try{
        const session=claim.session
        const rows=(await options.pool.query<HistoryRow>(`SELECT id::text,role,content,content_json,coalesce(history_anchor_seq,conversation_seq)::text AS effective FROM conversation_messages
          WHERE session_id=$1 AND (role='summary' OR coalesce(history_anchor_seq,conversation_seq)>$2)
          AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%') ORDER BY CASE WHEN role='summary' THEN 0 ELSE 1 END,coalesce(history_anchor_seq,conversation_seq),(history_anchor_seq IS NULL),conversation_seq`,[receipt.session_id,session.baseline_message_seq])).rows
        if(!await current())throw new ImCompactError()
        runtime=await options.runtime({identity,scope,authorize:current,signal:controller.signal})
        const history=await loadSessionHistory(identity,createPostgresCanonicalHistoryReader(options.pool),controller.signal,{loadImages:false})
        if(history.effectiveBaselineSeq!==Number(session.baseline_message_seq))throw new ImCompactError()
        const timezone=runtime.timezone
        const messages=history.rows.flatMap(row=>{
          const value=restoreHistoryForRequest(row,{groupChat:scope.chatType==='group',userTimezone:timezone,
            formatMessageTime:(value,zone)=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short'}).format(new Date(value))})
          return value?[value]:[]
        })
        const area=new MessageArea({digest,nextId:randomUUID},messages)
        const result=await compactContext(area,runtime.compaction,{modelIdentity:runtime.modelIdentity,signal:controller.signal})
        if(!await current())throw new ImCompactError()
        const state=await tx(async client=>{
          const fresh=(await client.query('SELECT * FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE',[scope.ownerId,receipt.session_id])).rows[0]
          const lease=await client.query('SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND token=$4 AND fence=$5 AND expires_at>clock_timestamp() FOR UPDATE',args)
          if(!fresh||!lease.rowCount||fresh.active_run_id!==operation||fresh.execution_state!=='baseline_updating'||!await authorize(client,scope)
            ||fresh.baseline_message_seq!==session.baseline_message_seq||fresh.baseline_message_hash!==session.baseline_message_hash||fresh.snapshot_hash!==session.snapshot_hash||fresh.context_epoch!==session.context_epoch
            ||stableJson([fresh.source,fresh.bot_id,fresh.chat_type,fresh.chat_id,fresh.platform_user_id])!==stableJson([session.source,session.bot_id,session.chat_type,session.chat_id,session.platform_user_id])
            ||!Number.isSafeInteger(Number(fresh.last_message_seq)+1))throw new ImCompactError()
          let state:State='not_needed'
          if(result.changed){
            const ids=result.coversUntilMessageIds,covered=rows.filter(row=>row.role!=='summary').slice(0,ids.length)
            const actual=(await client.query<HistoryRow>(`SELECT id::text,role,content,content_json,coalesce(history_anchor_seq,conversation_seq)::text AS effective FROM conversation_messages WHERE session_id=$1 AND role<>'summary' AND coalesce(history_anchor_seq,conversation_seq)>$2 AND (run_id IS NULL OR run_id NOT LIKE 'im-pending:%') ORDER BY coalesce(history_anchor_seq,conversation_seq),(history_anchor_seq IS NULL),conversation_seq`,[receipt.session_id,session.baseline_message_seq])).rows
            const baseline=Number(covered.at(-1)?.effective),summary=result.messages.filter(isCompactedSummaryMessage)
            if(!ids.length||result.coversUnpersisted||ids.some((id,i)=>covered[i]?.id!==id)||stableJson(actual.slice(0,ids.length))!==stableJson(covered)
              ||!Number.isSafeInteger(baseline)||baseline<=Number(session.baseline_message_seq)||Number(actual[ids.length]?.effective??Infinity)<=baseline||summary.length!==1||typeof summary[0]!.content!=='string')throw new ImCompactError()
            const text=unwrapCompactedSummary(summary[0]!.content)
            if(!Number.isSafeInteger(Number(fresh.last_message_seq))||Number(fresh.last_message_seq)<0||!Number.isSafeInteger(Number(fresh.last_message_seq)+1))throw new ImCompactError()
            // 旧Web/IM会话可以没有snapshot；有snapshot时沿正式更新契约，无snapshot仍保持待真实重建。
            const original:SessionSnapshotState={ownerId:scope.ownerId,sessionId:identity.sessionId,context:session.session_context,contextEpoch:session.context_epoch,snapshotHash:session.snapshot_hash,sessionInfoHash:session.session_info_hash,snapshotExpiresAt:session.snapshot_expires_at?new Date(session.snapshot_expires_at).getTime():null,baselineMessageSeq:Number(session.baseline_message_seq)}
            const snapshot=session.session_context?updateBaselineSnapshot(original,[{role:'summary',content:text}],{digest,nextId:randomUUID,now:Date.now},{baselineMessageSeq:baseline}):null
            await client.query("DELETE FROM conversation_messages WHERE session_id=$1 AND role='summary'",[receipt.session_id])
            await client.query(`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,covers_until_seq,created_at) VALUES($1,$2,'summary',$3,$4,clock_timestamp())`,[receipt.session_id,Number(fresh.last_message_seq)+1,text,baseline])
            await client.query(`UPDATE conversation_sessions SET last_message_seq=last_message_seq+1,baseline_message_seq=$3,baseline_message_hash=$4,session_context=$5::jsonb,context_epoch=$6,snapshot_hash=$7,snapshot_expires_at=$8 WHERE user_id=$1 AND id=$2`,[scope.ownerId,receipt.session_id,baseline,canonicalBaselineHash(covered),snapshot?JSON.stringify(snapshot.context):null,snapshot?.contextEpoch??session.context_epoch,snapshot?.snapshotHash??null,snapshot?.snapshotExpiresAt?new Date(snapshot.snapshotExpiresAt):null])
            await enqueuePostgresAgentRagRebuild(client, scope.ownerId, 'conversation');state='compacted'
          }
          await runtime!.recordUsage(client)
          await client.query('UPDATE gugu_im_compact_commands SET state=$3,updated_at=clock_timestamp() WHERE user_id=$1 AND event_hash=$2',[scope.ownerId,eventHash,state]);await release(client,scope.ownerId,receipt)
          return state
        })
        return imCompactReply(state)
      }catch{
        try{await tx(async client=>{await client.query("SELECT id FROM conversation_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE",[scope.ownerId,receipt.session_id]);await client.query("UPDATE gugu_im_compact_commands SET state='unknown',updated_at=clock_timestamp() WHERE user_id=$1 AND event_hash=$2 AND state='requesting'",[scope.ownerId,eventHash]);await release(client,scope.ownerId,receipt)})}catch{/* 未知收据保留；后续显式命令只按过期精确租约回收。 */}
        try{options.diagnose('im_compaction_failed')}catch{/* 固定诊断不能改变控制收据。 */}
        signal.throwIfAborted();return imCompactReply('unknown')
      }finally{clearInterval(timer);signal.removeEventListener('abort',abort);await renewal;try{await runtime?.close()}catch{throw new ImCompactError()}}
    },
  }
}
