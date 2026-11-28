import type { Pool, PoolClient } from 'pg'
import { stableJson, type RunIdentity } from '@gugu/core/agent'
import { attentionSourceKind, parseImAttentionRecord, type ImAttentionRecord } from '@gugu/core/im/attention/directive'
import { withPostgresTransaction } from '../../../../adapters/database/postgres-transaction.js'
import { createPostgresImAccess } from '../inbound/access.js'
import { imActorInputFromPayload } from '@gugu/core/im/access'
import { imConversationDigest, imConversationFingerprint, imConversationScopeHash } from '../agent/identity.js'
import { createImInboundEnvelope } from '../inbound/envelope.js'
import type { NodeImBotBinding } from '../inbound/inbox.js'
import type { ImConversationAnchor } from '../agent/conversations.js'
import type { createPostgresImAttentionRuntime } from '../attention/runtime.js'
import type { ImPendingAskResume } from '@gugu/gateway'
import type { createRedisImPendingAskStore } from './ask.js'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const failure = () => new Error('群延迟回复派发不可用')

/** 内部唤醒专用入口；不进入普通Gateway/秘密预检，不以平台payload布尔值授予升级权。 */
export function createPostgresImPendingAskDispatcher(options: {
  pool: Pick<Pool, 'connect' | 'query'>; secretKey: string
  pending: ReturnType<typeof createRedisImPendingAskStore>; attention: ReturnType<typeof createPostgresImAttentionRuntime>
  supportedPlatforms(): readonly string[] | Promise<readonly string[]>
  /** 必须装配Ingress正式startup/enqueue；同事务登记真实Run，不能自行COMMIT或运行Provider。 */
  enqueue(client: PoolClient, input: { binding: NodeImBotBinding; payload: Record<string, unknown>; anchor: ImConversationAnchor; attention: ImAttentionRecord }, signal: AbortSignal): Promise<string>
  /** 最终消息/收据改为dispatched后在同一事务绑定可信转写收据，不执行ASR。 */
  afterDispatch?(client: PoolClient, binding: NodeImBotBinding, payload: Readonly<Record<string, unknown>>, identity: RunIdentity, messageIds: readonly string[], signal: AbortSignal): Promise<void>
  notify(): Promise<void>
  diagnose(code: 'pending_ask_notify_pending'): void
}) {
  const envelope = createImInboundEnvelope(options.secretKey)
  const hash = (v: unknown) => imConversationDigest(options.secretKey, v)
  return {
    async dispatch(resume: ImPendingAskResume, signal: AbortSignal): Promise<{ state: 'dispatched' | 'consumed'; runId: string | null }> {
      signal.throwIfAborted()
      const { scope, trigger } = resume
      const binding = { ownerId: scope.ownerId, botId: scope.botId, platform: scope.platform }
      const p = trigger.payload
      if (!/^\d+-\d+$/u.test(trigger.eventId) || Number(trigger.eventId.split('-')[0]) !== trigger.eventMs
        || trigger.eventMs !== resume.latestAskMs || !resume.resumeId || resume.resumeId.length > 512
        || p.owner_user_id !== scope.ownerId || p.bot_id !== scope.botId || p.platform !== scope.platform || p.chat_type !== 'group'
        || p.chat_id !== scope.groupId || p.platform_user_id !== trigger.senderId || (p.platform_message_id || p.message_id) !== trigger.platformMessageId
        || !Number.isSafeInteger(p.session_id) || Number(p.session_id) < 1 || typeof p.text !== 'string') throw failure()
      const scopeHash = imConversationScopeHash(options.secretKey, binding, p)
      const eventHash = hash([scopeHash, trigger.senderId, p._pending_ask_resume_id || p.platform_message_id || p.message_id])
      const resumeHash = hash(['pending-ask-resume-v1', resume.resumeId])
      const key = [scope.ownerId, scope.platform, scope.botId, scopeHash, resumeHash]
      const freshAccess = createPostgresImAccess({ query: (sql, values) => options.pool.query(sql, values), supportedPlatforms: options.supportedPlatforms })
      const actorInput = imActorInputFromPayload(binding, p)
      ;(await freshAccess.snapshot(actorInput)).actor(actorInput)
      // 幂等结果优先于Redis状态；commit成功但complete/响应丢失时不能再创建Run。
      const prior = await options.pool.query<{ state: 'dispatched' | 'consumed'; run_id: string | null; event_hash: string; session_id: number }>(`SELECT state,run_id,event_hash,session_id FROM gugu_im_pending_ask_runs
        WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_hash=$4 AND resume_hash=$5`, key)
      if (prior.rows.length) {
        const row = prior.rows[0]!
        if (row.event_hash !== eventHash || row.session_id !== p.session_id) throw failure()
        return { state: row.state, runId: row.run_id }
      }
      if (!await options.pending.isIssued(resume,signal) || !await options.pending.isCurrent(resume, signal) || await options.pending.isCancelled(resume, signal)) return { state: 'consumed', runId: null }
      const evaluation = await options.attention.evaluate({ scope, sessionId: Number(p.session_id), candidates: [{ eventId: trigger.eventId, payload: p }], resume }, signal)
      const decision = parseImAttentionRecord({ v: 1, disposition: evaluation.disposition === 'run' ? 'run' : 'passive',
        mode: evaluation.mode, configVersion: evaluation.configVersion, subjectEventId: evaluation.subject?.eventId ?? null,
        sourceAttentionKind: attentionSourceKind(evaluation.decision?.kind), proactive: evaluation.decision?.kind === 'PROACTIVE',
        replyChoice: evaluation.disposition === 'run' ? 'pending' : 'reply' })
      const result = await withPostgresTransaction(options.pool, async client => {
        const lock = Buffer.from(scopeHash, 'hex')
        await client.query('SELECT pg_advisory_xact_lock($1,$2)', [lock.readInt32BE(0), lock.readInt32BE(4)])
        const again = await client.query<{state:'dispatched'|'consumed';run_id:string|null;event_hash:string}>(`SELECT state,run_id,event_hash FROM gugu_im_pending_ask_runs
          WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_hash=$4 AND resume_hash=$5`, key)
        if (again.rows.length) {
          if (again.rows[0]!.event_hash !== eventHash) throw failure()
          return { state: again.rows[0]!.state, runId: again.rows[0]!.run_id }
        }
        const access = createPostgresImAccess({ query: (sql, values) => client.query(sql, values), supportedPlatforms: options.supportedPlatforms })
        const input = imActorInputFromPayload(binding, p)
        const current = await access.snapshot(input); current.actor(input)
        const config = await client.query(`SELECT group_attention_mode,group_attention_config_version,group_requires_at,group_read_enabled FROM user_bots
          WHERE user_id=$1 AND id=$2::integer AND platform=$3 AND enabled IS TRUE FOR SHARE`, [scope.ownerId, scope.botId, scope.platform])
        const c = config.rows[0]
        if (!c || c.group_attention_config_version !== decision.configVersion || c.group_attention_mode !== decision.mode) throw failure()
        const row = (await client.query<Record<string, unknown>>(`SELECT r.fingerprint,r.sealed_payload,r.state,r.run_id,r.session_id,r.message_id,
          m.platform_user_id,m.im_platform_message_id,m.im_event_received_ms::text,m.conversation_seq::text,m.run_id AS message_run_id,s.source,s.bot_id,s.chat_type,s.chat_id,
          b.sealed_payload AS segment_payload,b.mode AS segment_mode,b.state AS segment_state
          FROM gugu_im_inbound_receipts r JOIN conversation_sessions s ON s.user_id=r.user_id AND s.id=r.session_id
          JOIN conversation_messages m ON m.id=r.message_id AND m.session_id=s.id
          JOIN gugu_im_inbound_batch_members bm ON bm.user_id=r.user_id AND bm.platform=r.platform AND bm.bot_id=r.bot_id AND bm.chat_type=r.chat_type AND bm.scope_hash=r.scope_hash AND bm.event_hash=r.event_hash
          JOIN gugu_im_inbound_segments b ON b.user_id=bm.user_id AND b.platform=bm.platform AND b.bot_id=bm.bot_id AND b.chat_type=bm.chat_type AND b.scope_hash=bm.scope_hash AND b.segment_key=bm.segment_key
          WHERE r.user_id=$1 AND r.platform=$2 AND r.bot_id=$3 AND r.scope_hash=$4 AND r.event_hash=$5 AND r.chat_type='group' AND m.role='user' AND m.chat_type='group'
          FOR UPDATE OF r,m,s`, [scope.ownerId, scope.platform, scope.botId, scopeHash, eventHash])).rows[0]
        if (!row || row.state !== 'passive' || row.run_id !== null || row.message_run_id !== null || row.session_id !== p.session_id || row.source !== scope.platform || row.bot_id !== scope.botId
          || row.chat_type !== 'group' || row.chat_id !== scope.groupId || row.platform_user_id !== trigger.senderId
          || row.im_platform_message_id !== trigger.platformMessageId || Number(row.im_event_received_ms) !== trigger.eventMs
          || row.segment_mode !== 'passive' || row.segment_state !== 'completed' || !object(row.sealed_payload) || !object(row.segment_payload)) throw failure()
        const stored = envelope.open(binding, row.sealed_payload), segment = envelope.open(binding, row.segment_payload)
        const original = parseImAttentionRecord(segment._node_attention)
        if (original.disposition !== 'pending' || original.subjectEventId !== trigger.eventId || stored._node_stream_event_id !== trigger.eventId
          || stored.platform_user_id !== trigger.senderId || (stored.platform_message_id || stored.message_id) !== trigger.platformMessageId) throw failure()
        const ids = (Array.isArray(stored.attachments) ? stored.attachments : []).map(a => typeof a === 'string' ? a : object(a) ? a.attach_id : null)
        const pendingIds = (Array.isArray(p.attachments) ? p.attachments : []).map(a => typeof a === 'string' ? a : object(a) ? a.attach_id : null)
        if (ids.some(id => typeof id !== 'string') || pendingIds.some(id => typeof id !== 'string')
          || imConversationScopeHash(options.secretKey,binding,stored) !== scopeHash
          || hash([scopeHash,stored.platform_user_id,stored._pending_ask_resume_id || stored.platform_message_id || stored.message_id]) !== eventHash
          || imConversationFingerprint(options.secretKey,scopeHash,stored,ids as string[]) !== row.fingerprint
          || imConversationFingerprint(options.secretKey,scopeHash,p,pendingIds as string[]) !== row.fingerprint) throw failure()
        const canDispatch = decision.disposition === 'run' && original.configVersion === decision.configVersion && original.mode === decision.mode
          && c.group_requires_at === false && c.group_read_enabled === false
          && await options.pending.isCurrent(resume, signal) && !await options.pending.isCancelled(resume, signal)
        let runId: string | null = null
        if (canDispatch) {
          const anchor: ImConversationAnchor = { sessionId: Number(row.session_id), messageId: Number(row.message_id), conversationSeq: Number(row.conversation_seq), runId: null, duplicate: false, isNewSession: false }
          const payload = { ...stored, _node_attention: decision, _node_pending_ask_resume_id: resume.resumeId }
          runId = await options.enqueue(client, { binding, payload, anchor, attention: decision }, signal)
          if (!runId || runId.length > 128) throw failure()
          await client.query('UPDATE conversation_messages SET run_id=$3 WHERE id=$1 AND session_id=$2', [anchor.messageId, anchor.sessionId, runId])
          await client.query(`UPDATE gugu_im_inbound_receipts SET state='dispatched',run_id=$6,sealed_payload=$7::jsonb WHERE user_id=$1 AND platform=$2 AND bot_id=$3 AND scope_hash=$4 AND event_hash=$5`,
            [scope.ownerId, scope.platform, scope.botId, scopeHash, eventHash, runId, JSON.stringify(envelope.seal(binding,payload))])
          await options.afterDispatch?.(client, binding, payload,
            { ownerId: scope.ownerId, sessionId: String(anchor.sessionId), runId }, [String(anchor.messageId)], signal)
        }
        const state = runId ? 'dispatched' as const : 'consumed' as const
        await client.query(`INSERT INTO gugu_im_pending_ask_runs(user_id,platform,bot_id,scope_hash,resume_hash,event_hash,session_id,message_id,state,run_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...key,eventHash,row.session_id,row.message_id,state,runId])
        signal.throwIfAborted()
        return { state, runId }
      }, () => failure())
      if (result.state === 'dispatched') try { await options.notify() } catch { options.diagnose('pending_ask_notify_pending') }
      return result
    },
    async verifyRun(identity: RunIdentity, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<'ready' | 'cancelled'> {
      signal.throwIfAborted()
      if (payload._node_pending_ask_resume_id === undefined) return 'ready'
      const resumeId = payload._node_pending_ask_resume_id
      if (typeof resumeId !== 'string' || !resumeId || resumeId.length > 512 || payload.owner_user_id !== identity.ownerId
        || !['qq','feishu','telegram'].includes(String(payload.platform)) || typeof payload.bot_id !== 'string'
        || payload.chat_type !== 'group' || typeof payload.chat_id !== 'string' || typeof payload.platform_user_id !== 'string'
        || typeof payload._node_stream_event_id !== 'string' || !/^\d+-\d+$/u.test(payload._node_stream_event_id)) throw failure()
      const binding: NodeImBotBinding = {ownerId:identity.ownerId,botId:payload.bot_id,platform:payload.platform as NodeImBotBinding['platform']}
      const scopeHash = imConversationScopeHash(options.secretKey,binding,payload)
      const resumeHash = hash(['pending-ask-resume-v1',resumeId])
      const rows = await options.pool.query<{sealed_payload:unknown;message_id:number}>(`SELECT r.sealed_payload,p.message_id
        FROM gugu_im_pending_ask_runs p JOIN gugu_im_inbound_receipts r ON r.user_id=p.user_id AND r.platform=p.platform AND r.bot_id=p.bot_id AND r.scope_hash=p.scope_hash AND r.event_hash=p.event_hash
        JOIN conversation_messages m ON m.id=p.message_id AND m.session_id=p.session_id
        JOIN conversation_sessions s ON s.id=p.session_id AND s.user_id=p.user_id
        WHERE p.user_id=$1 AND p.platform=$2 AND p.bot_id=$3 AND p.scope_hash=$4 AND p.resume_hash=$5 AND p.session_id=$6 AND p.run_id=$7
          AND p.state='dispatched' AND r.state='dispatched' AND r.run_id=p.run_id AND r.message_id=p.message_id
          AND m.run_id=p.run_id AND m.role='user' AND s.source=p.platform AND s.bot_id=p.bot_id AND s.chat_type='group' AND s.chat_id=$8`,
        [identity.ownerId,binding.platform,binding.botId,scopeHash,resumeHash,identity.sessionId,identity.runId,payload.chat_id])
      const row = rows.rows[0]
      if (rows.rows.length !== 1 || !row || !object(row.sealed_payload)) throw failure()
      const stored = envelope.open(binding,row.sealed_payload)
      if (stored._node_pending_ask_resume_id !== resumeId || stored._node_stream_event_id !== payload._node_stream_event_id
        || stored.platform_user_id !== payload.platform_user_id || (stored.platform_message_id || stored.message_id) !== (payload.platform_message_id || payload.message_id)
        || stableJson(parseImAttentionRecord(stored._node_attention)) !== stableJson(parseImAttentionRecord(payload._node_attention))) throw failure()
      const ms = Number(payload._node_stream_event_id.split('-')[0])
      const resume: ImPendingAskResume = {scope:{ownerId:identity.ownerId,botId:binding.botId,platform:binding.platform as 'qq'|'feishu'|'telegram',groupId:payload.chat_id},resumeId,latestAskMs:ms,
        trigger:{eventId:payload._node_stream_event_id,eventMs:ms,platformMessageId:String(payload.platform_message_id||payload.message_id),senderId:payload.platform_user_id,payload}}
      return !await options.pending.isIssued(resume,signal) || await options.pending.isCancelled(resume,signal) ? 'cancelled' : 'ready'
    },
  }
}
