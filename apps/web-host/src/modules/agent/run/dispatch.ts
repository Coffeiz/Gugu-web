import { stableJson } from '@gugu/core/agent'
import type { ImPlatform, ImChatType } from '@gugu/core/im/access'
import { parseImAttentionRecord, type ImAttentionRecord } from '@gugu/core/im/attention/directive'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { InteractionResolution, RunIdentity } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { lockAgentRunSession } from './start.js'
import { claimInteractionResumeLocked } from '../interactions/resume.js'
import { sealUnrecoverableInteraction } from './store.js'

const expiredInteractionResume = `EXISTS (SELECT 1 FROM agent_interaction_resumes r
  JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
  WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id
    AND p.status='resolved' AND r.completed_at IS NULL AND r.created_at<=clock_timestamp()-interval '2 minutes'
    AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=clock_timestamp()))`

export const hasReadySubagentWait = (owner: string, session: string, run: string) => `EXISTS (
  SELECT 1 FROM agent_subagent_waits w
  JOIN agent_subagent_deliveries f USING (owner_id,parent_session_id,parent_run_id,child_id)
  WHERE w.owner_id=${owner} AND w.parent_session_id=${session} AND w.parent_run_id=${run}
    AND f.payload IS NOT NULL)`

export const hasReadyAgentInbox = (owner: string, session: string, run: string) => `EXISTS (
  SELECT 1 FROM agent_inbox_waits w WHERE w.owner_id=${owner} AND w.session_id=${session} AND w.run_id=${run}
    AND (EXISTS (SELECT 1 FROM agent_inbox_messages m
      WHERE m.owner_id=w.owner_id AND m.recipient_session_id=w.session_id AND m.recipient_run_id=w.run_id
        AND m.consumed_checkpoint_version IS NULL)
      OR EXISTS (SELECT 1 FROM agent_subagent_deliveries f
        WHERE f.owner_id=w.owner_id AND f.parent_session_id=w.session_id AND f.parent_run_id=w.run_id
          AND f.payload IS NOT NULL AND f.consumed_checkpoint_version IS NULL)))`

/** 只保存重建必要的非凭据元数据；正文、附件及引用以用户消息为真源。 */
interface AgentDispatchBase { userMessageId: number; locale: 'zh-CN' | 'ja-JP' | 'en-US' | null; origin: string | null; accessVersion: string }
export interface ImAgentDispatchInput extends AgentDispatchBase {
  v: 3; source: 'im'; origin: null
  /** 仅含可信路由身份；context token和媒体凭据留在独立加密入站收据中。 */
  im: { platform: ImPlatform; botId: string; chatType: ImChatType; chatId: string | null; platformUserId: string;
    batch?: { batchKey: string; segmentKey: string; messageIds: number[] }; attention?: ImAttentionRecord }
}
export interface RunModelPin { modelIdentity: string; accessScopeHash: string }
export type AgentDispatchInput = (AgentDispatchBase & { v?: 2; source?: 'web'; model?: RunModelPin }) | ImAgentDispatchInput
export type AgentDispatchSource = 'web' | 'im'
export interface AgentDispatchLease {
  identity: RunIdentity
  token: string
  fence: number
  input: AgentDispatchInput
  mode: 'start' | 'resume'
  cancelRequested: boolean
  replyChoice?: 'pending' | 'reply'
  resolution?: InteractionResolution
  interactionResume?: { promptId: number; claimToken: string; receipt: string }
}
/** 旧载荷保留用于诊断和恢复，不按当前 Web 来源执行。 */
export function acceptsWebAgentDispatchInput(input: AgentDispatchInput): boolean {
  return input.v === 2 && input.source === 'web'
}

function aad(identity: RunIdentity): Buffer { return Buffer.from(JSON.stringify([identity.ownerId, identity.sessionId, identity.runId])) }
function key(secret: string): Buffer { if (!secret) throw new TypeError('调度密钥不能为空'); return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), Buffer.from('gugu-agent-dispatch-v1'), 32)) }
function validateInput(input: AgentDispatchInput): void {
  const im = input.v === 3 && input.source === 'im'
  if (!Number.isSafeInteger(input.userMessageId) || input.userMessageId < 1 || ![null, 'zh-CN', 'ja-JP', 'en-US'].includes(input.locale) || (input.origin !== null && (typeof input.origin !== 'string' || input.origin.length > 128)) || !/^[a-f0-9]{64}$/.test(input.accessVersion) || !((input.v === undefined && input.source === undefined) || (input.v === 2 && input.source === 'web') || im) || Object.keys(input).some(k => !['userMessageId', 'locale', 'origin', 'accessVersion', 'v', 'source', ...(im ? ['im'] : input.v === 2 ? ['model'] : [])].includes(k))) throw new TypeError('调度输入无效')
  if (input.source === 'web' && input.model !== undefined) {
    const model = input.model
    if (!model || typeof model !== 'object' || Object.keys(model).length !== 2
      || typeof model.modelIdentity !== 'string' || model.modelIdentity.length > 8192
      || !/^gugu-model-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(model.modelIdentity)
      || typeof model.accessScopeHash !== 'string' || !/^[a-f0-9]{64}$/.test(model.accessScopeHash))
      throw new TypeError('调度模型绑定无效')
  }
  if (im) {
    const route = input.im
    const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value)
    if (input.origin !== null || !route || typeof route !== 'object' || Array.isArray(route)
      || Object.keys(route).some(k => !['platform', 'botId', 'chatType', 'chatId', 'platformUserId', 'batch', 'attention'].includes(k))
      || !['feishu', 'qq', 'wechat', 'telegram'].includes(route.platform) || !/^[1-9]\d*$/.test(route.botId)
      || !id(route.platformUserId) || !['group', 'c2c'].includes(route.chatType)
      || (route.chatType === 'group' ? !id(route.chatId) : route.chatId !== null)) throw new TypeError('IM 调度作用域无效')
    if (route.attention !== undefined && (parseImAttentionRecord(route.attention).disposition !== 'run'
      || route.chatType !== 'group' || route.platform === 'wechat')) throw new TypeError('IM 调度注意力事实无效')
    if (route.batch !== undefined) {
      const batch = route.batch
      if (!batch || typeof batch !== 'object' || Array.isArray(batch)
        || Object.keys(batch).some(k => !['batchKey', 'segmentKey', 'messageIds'].includes(k))
        || !/^[a-f0-9]{64}$/.test(batch.batchKey) || !/^[a-f0-9]{64}$/.test(batch.segmentKey)
        || !Array.isArray(batch.messageIds) || !batch.messageIds.length || batch.messageIds.length > 128
        || batch.messageIds.some(value => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        || new Set(batch.messageIds).size !== batch.messageIds.length || batch.messageIds.at(-1) !== input.userMessageId)
        throw new TypeError('IM 调度批次无效')
    }
  }
}
/** 版本与完整载荷一起验证，不能仅凭source字符串放行恢复。 */
export function agentDispatchSource(input: AgentDispatchInput): AgentDispatchSource | null {
  try { validateInput(input) } catch { return null }
  return input.v === 2 && input.source === 'web' ? 'web' : input.v === 3 && input.source === 'im' ? 'im' : null
}
function encrypt(secret: string, identity: RunIdentity, input: AgentDispatchInput) {
  validateInput(input)
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret), nonce)
  cipher.setAAD(aad(identity))
  return { nonce, payload: Buffer.concat([cipher.update(JSON.stringify(input), 'utf8'), cipher.final(), cipher.getAuthTag()]) }
}
function decrypt(secret: string, identity: RunIdentity, nonce: Buffer, payload: Buffer): AgentDispatchInput {
  try {
    if (nonce.length !== 12 || payload.length < 16) throw new Error()
    const cipher = createDecipheriv('aes-256-gcm', key(secret), nonce); cipher.setAAD(aad(identity)); cipher.setAuthTag(payload.subarray(-16))
    const input = JSON.parse(Buffer.concat([cipher.update(payload.subarray(0, -16)), cipher.final()]).toString('utf8')) as AgentDispatchInput
    validateInput(input); return input
  } catch { throw new Error('调度输入无法安全解密') }
}
interface AgentDispatchQuery {
  query<T extends Record<string, unknown> = Record<string, unknown>>(statement: string, parameters: unknown[]):
    Promise<{ rowCount: number | null; rows: T[] }>
}

async function updatePending(client: AgentDispatchQuery, identity: RunIdentity) {
  await client.query(`UPDATE conversation_sessions SET pending_message_count=(SELECT count(*) FROM agent_run_dispatch d WHERE d.user_id=$1 AND d.session_id=$2 AND d.state='queued') WHERE user_id=$1 AND id=$2`, [identity.ownerId, identity.sessionId])
}
async function promoteNext(client: PoolClient, identity: RunIdentity) {
  await client.query(`UPDATE agent_run_dispatch SET state='selected' WHERE sequence=(SELECT sequence FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state='queued' ORDER BY sequence LIMIT 1)`, [identity.ownerId, identity.sessionId])
  await updatePending(client, identity)
}

/** 入队应由消息创建事务调用；必须已经持有同一 owner/session 行锁。 */
export { decrypt as decryptAgentDispatchInput }

export async function enqueueAgentRunLocked(client: AgentDispatchQuery, secret: string, identity: RunIdentity, input: AgentDispatchInput, ttlSeconds: number): Promise<void> {
  if (!identity.ownerId || !identity.runId || identity.runId.length > 128 || !/^[1-9]\d*$/.test(identity.sessionId)) throw new TypeError('运行身份无效')
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 604800) throw new RangeError('调度保存期限无效')
  const owned = await client.query("SELECT 1 FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'", [identity.ownerId, identity.sessionId, input.userMessageId])
  if (owned.rowCount !== 1) throw new Error('调度消息不存在')
  const encrypted = encrypt(secret, identity, input)
  const inserted = await client.query(`INSERT INTO agent_run_dispatch(user_id,session_id,run_id,state,nonce,payload,request_expires_at,message_id)
    VALUES ($1,$2,$3,CASE WHEN EXISTS (SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state='selected')
      OR EXISTS (SELECT 1 FROM conversation_sessions WHERE user_id=$1 AND id=$2 AND execution_state IN ('running','baseline_updating'))
      THEN 'queued' ELSE 'selected' END,$4,$5,clock_timestamp()+($6*interval '1 second'),$7) ON CONFLICT (user_id,session_id,run_id) DO NOTHING`, [identity.ownerId, identity.sessionId, identity.runId, encrypted.nonce, encrypted.payload, ttlSeconds, input.userMessageId])
  if (inserted.rowCount !== 1) {
    const existing = await client.query<{ nonce: Buffer; payload: Buffer; expired: boolean }>(`SELECT nonce,payload,request_expires_at<=clock_timestamp() AS expired FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])
    const row = existing.rows[0]
    if (!row || row.expired) throw new Error('调度登记已过期')
    const previous = decrypt(secret, identity, row.nonce, row.payload)
    if (stableJson(previous) !== stableJson(input)) throw new Error('调度身份冲突')
  }
  await updatePending(client, identity)
}

// 终态提交早于租约释放和调度清理。状态读取与默认 SSE 续接都以 checkpoint 为准。
const terminalCheckpoint = (runId: 's.active_run_id' | 'd.run_id') => `EXISTS (
          SELECT 1 FROM agent_run_checkpoints c
          WHERE c.user_id=s.user_id AND c.session_id=s.id AND c.run_id=${runId}
            AND c.status IN ('completed','cancelled','failed','unknown'))`
const currentRunId = `coalesce(
        CASE WHEN NOT ${terminalCheckpoint('s.active_run_id')} THEN s.active_run_id END,
        (SELECT d.run_id FROM agent_run_dispatch d WHERE d.user_id=s.user_id AND d.session_id=s.id
          AND d.state='selected' AND NOT ${terminalCheckpoint('d.run_id')} LIMIT 1),
        (SELECT c.run_id FROM agent_run_checkpoints c WHERE c.user_id=s.user_id AND c.session_id=s.id AND c.status='waiting' ORDER BY c.updated_at DESC,c.run_id DESC LIMIT 1))`

export function createPostgresAgentActiveStatusReader(pool: Pick<Pool, 'query'>, mode: 'active' | 'generating' = 'active') {
  const waiting = mode === 'generating' ? `AND NOT EXISTS (
    SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=s.user_id AND c.session_id=s.id
    AND c.run_id=selected.run_id AND c.status='waiting')` : ''
  return async (sessionIds: number[], ownerId: string): Promise<Map<number, boolean>> => {
    if (!sessionIds.length) return new Map()
    const { rows } = await pool.query<{ id: number; active: boolean }>(
      `SELECT s.id, (selected.run_id IS NOT NULL ${waiting}) AS active
       FROM conversation_sessions s CROSS JOIN LATERAL (SELECT ${currentRunId} AS run_id) selected
       WHERE s.user_id=$1 AND s.id=ANY($2::integer[])`,
      [ownerId, sessionIds],
    )
    return new Map(rows.map(({ id, active }) => [id, active]))
  }
}

/** 选中项只可在自身租约过期后被接管；无法重建时调用方不得完成或丢弃。 */
export function createPostgresAgentDispatch(pool: Pick<Pool, 'connect' | 'query'>, secret: string, leaseMs = 30000,
  sources: readonly AgentDispatchSource[] = ['web'],
  options: { subagentWaits?: boolean; beforeClaim?(client: PoolClient, identity: RunIdentity, input: AgentDispatchInput): Promise<boolean> } = {},
) {
  const readySubagentWait = (owner: string, session: string, run: string) => options.subagentWaits
    ? `(${hasReadySubagentWait(owner, session, run)} OR ${hasReadyAgentInbox(owner, session, run)})`
    : 'FALSE'
  const internalWait = options.subagentWaits ? `(
    EXISTS (SELECT 1 FROM agent_subagent_waits w
      WHERE w.owner_id=c.user_id::text AND w.parent_session_id=c.session_id::text AND w.parent_run_id=c.run_id)
    OR EXISTS (SELECT 1 FROM agent_inbox_waits w
      WHERE w.owner_id=c.user_id::text AND w.session_id=c.session_id::text AND w.run_id=c.run_id)
  )` : 'FALSE'
  const supports = (input: AgentDispatchInput) => {
    const source = agentDispatchSource(input)
    return source !== null && sources.includes(source)
  }
  key(secret)
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new RangeError('调度租约无效')
  return {
    acceptsInput: supports,
    /** 等待其他 Agent 或已提交的确认回执时，保持原 Run 的事件流。 */
    async readStreamCheckpoint(identity: RunIdentity): Promise<{ status: string; sequence: number } | null> {
      const result = await pool.query<{ status: string; sequence: string }>(`
        SELECT c.sequence::text,
          CASE WHEN c.status='waiting' AND (EXISTS (
            SELECT 1 FROM agent_interaction_resumes r
            WHERE r.user_id=c.user_id AND r.session_id=c.session_id AND r.run_id=c.run_id AND r.completed_at IS NULL
          ) OR ${internalWait}) THEN 'running' ELSE c.status END AS status
        FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3`,
      [identity.ownerId, Number(identity.sessionId), identity.runId])
      const row = result.rows[0]
      return row ? { status: row.status, sequence: Number(row.sequence) } : null
    },
    /** 查询认证 owner 的当前运行；没有选中项时保留等待交互的最近运行。 */
    async active(ownerId: string, sessionId: number, requestedRunId?: string): Promise<{ identity: RunIdentity | null } | null> {
      if (!ownerId || !Number.isSafeInteger(sessionId) || sessionId < 1) throw new TypeError('Agent 会话身份无效')
      if (requestedRunId !== undefined) {
        // 确认后可按原 Run 重放 outbox，即使该 Run 已在浏览器重连前结束。
        const result = await pool.query(`SELECT 1 FROM agent_run_checkpoints c
          JOIN conversation_sessions s ON s.id=c.session_id AND s.user_id=c.user_id
          WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3`, [ownerId, sessionId, requestedRunId])
        return result.rowCount === 1 ? { identity: { ownerId, sessionId: String(sessionId), runId: requestedRunId } } : null
      }
      const result = await pool.query<{ run_id: string | null }>(`SELECT ${currentRunId} AS run_id
        FROM conversation_sessions s WHERE s.user_id=$1 AND s.id=$2`, [ownerId, sessionId])
      if (!result.rows.length) return null
      const runId = result.rows[0]!.run_id
      if (runId !== null && (typeof runId !== 'string' || !runId || runId.length > 128)) throw new Error('Agent 运行身份无效')
      return { identity: runId === null ? null : { ownerId, sessionId: String(sessionId), runId } }
    },
    /** 仅供可信 Host 扫描可恢复会话；密文和用户内容不进入唤醒通知。 */
    async listReady(limit = 100): Promise<Array<{ ownerId: string; sessionId: string }>> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('调度扫描数量无效')
      const result = await pool.query<{ user_id: string; session_id: string }>(`SELECT d.user_id::text,d.session_id::text,min(d.sequence) AS first_sequence
        FROM agent_run_dispatch d JOIN conversation_sessions s ON s.user_id=d.user_id AND s.id=d.session_id
        WHERE s.execution_state <> 'baseline_updating'
          AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id=d.user_id AND l.session_id=d.session_id AND l.expires_at>clock_timestamp())
          AND ((d.state='selected' AND d.blocked_reason IS DISTINCT FROM 'version_conflict' AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp())
              AND (d.cancel_requested
                OR ${readySubagentWait('d.user_id::text', 'd.session_id::text', 'd.run_id')}
                OR EXISTS (SELECT 1 FROM agent_interaction_bindings b JOIN interaction_prompts p
                  ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
                  WHERE b.user_id=d.user_id AND b.session_id=d.session_id AND b.run_id=d.run_id
                    AND p.status IN ('active','expired') AND p.expires_at<=clock_timestamp())
                OR NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id AND c.status='waiting')
                OR EXISTS (SELECT 1 FROM agent_interaction_resumes r JOIN interaction_prompts p ON p.id=r.prompt_id AND p.user_id=r.user_id AND p.session_id=r.session_id
                  WHERE r.user_id=d.user_id AND r.session_id=d.session_id AND r.run_id=d.run_id AND r.completed_at IS NULL AND p.status='resolved'
                    AND (r.claim_expires_at IS NULL OR r.claim_expires_at<=clock_timestamp())
                    AND NOT EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=r.user_id AND x.session_id=r.session_id AND x.run_id=r.run_id AND x.receipt=r.receipt))))
            OR (d.state='selected' AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp()) AND ${expiredInteractionResume})
            OR (d.state='queued' AND NOT EXISTS (SELECT 1 FROM agent_run_dispatch selected WHERE selected.user_id=d.user_id AND selected.session_id=d.session_id AND selected.state='selected'))
            OR (d.state='done' AND d.request_expires_at<=clock_timestamp() AND octet_length(d.payload)>0
              AND (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id AND c.status IN ('completed','cancelled','failed'))
                OR (NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id) AND EXISTS (SELECT 1 FROM agent_run_startups a WHERE a.user_id=d.user_id AND a.session_id=d.session_id AND a.run_id=d.run_id AND a.status='failed')))))
        GROUP BY d.user_id,d.session_id ORDER BY first_sequence LIMIT $1`, [limit])
      return result.rows.map(row => ({ ownerId: row.user_id, sessionId: row.session_id }))
    },
    async claim(ownerId: string, sessionId: string): Promise<AgentDispatchLease | null> {
      const scope = { ownerId, sessionId, runId: 'scope' }
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, scope)) return null
        const state = await client.query<{ execution_state: string }>('SELECT execution_state FROM conversation_sessions WHERE user_id=$1 AND id=$2', [ownerId, sessionId])
        if (state.rows[0]?.execution_state === 'baseline_updating') return null
        const selected = await client.query<{ run_id: string; nonce: Buffer; payload: Buffer; expired: boolean; leased: boolean; cancel_requested: boolean; blocked_reason: string | null }>(`SELECT run_id,nonce,payload,cancel_requested,blocked_reason,request_expires_at<=clock_timestamp() AS expired,lease_expires_at>clock_timestamp() AS leased
          FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state='selected' FOR UPDATE`, [ownerId, sessionId])
        let row = selected.rows[0]
        if (row?.blocked_reason === 'version_conflict') return null
        if (row?.leased) return null
        if (!row) {
          const pending = await client.query<typeof row>(`SELECT run_id,nonce,payload,cancel_requested,blocked_reason,request_expires_at<=clock_timestamp() AS expired,false AS leased FROM agent_run_dispatch
            WHERE user_id=$1 AND session_id=$2 AND state='queued' ORDER BY sequence LIMIT 1 FOR UPDATE`, [ownerId, sessionId])
          row = pending.rows[0]
        }
        if (!row) return null
        const identity = { ownerId, sessionId, runId: row.run_id }
        const checkpoint = await client.query<{ status: string }>('SELECT status FROM agent_run_checkpoints WHERE user_id=$1 AND session_id=$2 AND run_id=$3', [ownerId, sessionId, row.run_id])
        const status = checkpoint.rows[0]?.status
        if (status && !['preparing', 'running', 'waiting'].includes(status)) return null
        const active = await client.query('SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp()', [ownerId, sessionId])
        if (active.rowCount) return null
        const input = decrypt(secret, identity, row.nonce, row.payload)
        const source = agentDispatchSource(input)
        if (source && !supports(input)) return null
        // 原生交互继续由 IM 恢复器认领，派单交付只唤醒内部等待。
        if (source === 'im' && status === 'waiting') {
          const { rows: [ready] } = await client.query<{ ready: boolean }>(
            `SELECT ${readySubagentWait('$1', '$2', '$3')} AS ready`, [ownerId, sessionId, row.run_id])
          if (!ready?.ready) return null
        }
        if (!supports(input)) {
          await client.query("UPDATE agent_run_dispatch SET state='selected',blocked_reason='version_conflict',token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND run_id=$3", [ownerId, sessionId, row.run_id])
          await updatePending(client, identity)
          return null
        }
        if (options.beforeClaim && !await options.beforeClaim(client, identity, input)) return null
        if (row.expired && !status) throw new Error('调度材料已过期，需要人工恢复')
        if (status === 'waiting' && !row.cancel_requested) {
          const expiredPrompt = await client.query(`SELECT 1 FROM agent_interaction_bindings b JOIN interaction_prompts p
            ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
            WHERE b.user_id=$1 AND b.session_id=$2 AND b.run_id=$3
              AND p.status IN ('active','expired') AND p.expires_at<=clock_timestamp()
            LIMIT 1 FOR UPDATE OF p SKIP LOCKED`, [ownerId, sessionId, row.run_id])
          if (expiredPrompt.rowCount) {
            await client.query('UPDATE agent_run_dispatch SET cancel_requested=true WHERE user_id=$1 AND session_id=$2 AND run_id=$3',
              [ownerId, sessionId, row.run_id])
            row.cancel_requested = true
          }
        }
        const interactionResume = status === 'waiting' && !row.cancel_requested
          ? await claimInteractionResumeLocked(client, identity) : null
        if (status === 'waiting' && !row.cancel_requested && !interactionResume) {
          if (!options.subagentWaits) return null
          const { rows: [ready] } = await client.query<{ ready: boolean }>(
            `SELECT ${readySubagentWait('$1', '$2', '$3')} AS ready`, [ownerId, sessionId, row.run_id])
          if (!ready?.ready) return null
        }
        const token = randomUUID()
        const result = await client.query<{ fence: string | number }>(`UPDATE agent_run_dispatch SET state='selected',token=$4,fence=fence+1,lease_expires_at=clock_timestamp()+($5*interval '1 millisecond')
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 RETURNING fence`, [ownerId, sessionId, row.run_id, token, leaseMs])
        await updatePending(client, identity)
        const fence = Number(result.rows[0]?.fence)
        if (!Number.isSafeInteger(fence) || fence < 1) throw new Error('调度 fencing 无效')
        return { identity, token, fence, input, mode: status ? 'resume' as const : 'start' as const,
          cancelRequested: row.cancel_requested,
          ...(input.v === 3 && input.im.attention ? { replyChoice: input.im.attention.replyChoice } : {}),
          ...(interactionResume ? { resolution: interactionResume.resolution,
            interactionResume: { promptId: interactionResume.promptId, claimToken: interactionResume.claimToken, receipt: interactionResume.receipt } } : {}) }
      })
    },
    async renew(lease: AgentDispatchLease): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, lease.identity)) return false
        if (lease.interactionResume) {
          const claim = await client.query(`UPDATE agent_interaction_resumes SET claim_expires_at=clock_timestamp()+interval '30 seconds'
            WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4 AND claim_token=$5 AND completed_at IS NULL
              AND claim_expires_at>clock_timestamp()`, [lease.identity.ownerId, lease.identity.sessionId, lease.identity.runId,
            lease.interactionResume.promptId, lease.interactionResume.claimToken])
          if (claim.rowCount !== 1) return false
        }
        const result = await client.query(`UPDATE agent_run_dispatch SET lease_expires_at=clock_timestamp()+($6*interval '1 millisecond')
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected' AND token=$4 AND fence=$5 AND lease_expires_at>clock_timestamp()`, [lease.identity.ownerId, lease.identity.sessionId, lease.identity.runId, lease.token, lease.fence, leaseMs])
        return result.rowCount === 1
      })
    },
    /** 给有外部暂存副作用的工具复查同一 fencing lease；不接受仅匹配 owner/session 的旧租约。 */
    async isCurrent(lease: AgentDispatchLease): Promise<boolean> {
      const { ownerId, sessionId, runId } = lease.identity
      if (!ownerId || !/^[1-9]\d*$/.test(sessionId) || !runId || runId.length > 128
        || !lease.token || !Number.isSafeInteger(lease.fence) || lease.fence < 1) return false
      const result = await pool.query(`SELECT 1 FROM conversation_sessions s
        JOIN agent_run_dispatch d ON d.user_id=s.user_id AND d.session_id=s.id
        WHERE s.user_id=$1 AND s.id=$2 AND s.active_run_id=$3
          AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5
          AND d.lease_expires_at>clock_timestamp()`,
      [ownerId, Number(sessionId), runId, lease.token, lease.fence])
      return result.rowCount === 1
    },
    async setReconstructionStatus(lease: AgentDispatchLease, reason: 'unavailable' | 'version_conflict' | null): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        const id = lease.identity
        if (!await lockAgentRunSession(client, id)) return false
        const result = await client.query(`UPDATE agent_run_dispatch SET blocked_reason=$6::text,
          token=CASE WHEN $6::text IS NULL THEN token ELSE NULL END,
          lease_expires_at=CASE WHEN $6::text IS NULL THEN lease_expires_at ELSE clock_timestamp()+interval '30 seconds' END
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected' AND token=$4 AND fence=$5 AND lease_expires_at>clock_timestamp()`, [id.ownerId,id.sessionId,id.runId,lease.token,lease.fence,reason])
        if (result.rowCount === 1 && reason !== null && lease.interactionResume) await client.query(`UPDATE agent_interaction_resumes
          SET claim_token=NULL,claim_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4 AND claim_token=$5 AND completed_at IS NULL`,
        [id.ownerId,id.sessionId,id.runId,lease.interactionResume.promptId,lease.interactionResume.claimToken])
        return result.rowCount === 1
      })
    },
    async readReconstructionStatus(id: RunIdentity): Promise<'unavailable' | 'version_conflict' | null> {
      const result = await pool.query<{ blocked_reason: 'unavailable' | 'version_conflict' | null }>("SELECT blocked_reason FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected'", [id.ownerId,id.sessionId,id.runId])
      return result.rows[0]?.blocked_reason ?? null
    },
    /** 仅当前调度租约可记录无 checkpoint 的启动失败。 */
    async failStart(lease: AgentDispatchLease): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        const id = lease.identity
        if (!await lockAgentRunSession(client, id)) return false
        const result = await client.query(`UPDATE agent_run_startups s SET status='failed',updated_at=clock_timestamp()
          WHERE s.user_id=$1 AND s.session_id=$2 AND s.run_id=$3 AND s.status='pending'
            AND EXISTS (SELECT 1 FROM agent_run_dispatch d WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3
              AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp())
            AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3)
            AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id=$1 AND l.session_id=$2 AND l.expires_at>clock_timestamp())`,
        [id.ownerId, id.sessionId, id.runId, lease.token, lease.fence])
        return result.rowCount === 1
      })
    },
    async retryReconstruction(id: RunIdentity): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, id)) return false
        const result = await client.query(`UPDATE agent_run_dispatch d SET blocked_reason=NULL,lease_expires_at=NULL
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected' AND blocked_reason IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id=$1 AND l.session_id=$2 AND l.expires_at>clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status NOT IN ('preparing','running'))`, [id.ownerId,id.sessionId,id.runId])
        return result.rowCount === 1
      })
    },
    async cancellationRequested(lease: AgentDispatchLease): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        const id = lease.identity
        if (!await lockAgentRunSession(client, id)) throw new Error('调度租约失效')
        const result = await client.query<{ cancel_requested: boolean }>(`SELECT cancel_requested FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND state='selected' AND token=$4 AND fence=$5 AND lease_expires_at>clock_timestamp()`, [id.ownerId,id.sessionId,id.runId,lease.token,lease.fence])
        if (!result.rows[0]) throw new Error('调度租约失效')
        return result.rows[0].cancel_requested
      })
    },
    /** 精确记录当前 selected 的取消，不触碰后续 queued。 */
    async requestCancel(ownerId: string, sessionId: string, runId?: string): Promise<RunIdentity | null> {
      const scope = { ownerId, sessionId, runId: 'scope' }
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, scope)) return null
        const result = await client.query<{ run_id: string }>("UPDATE agent_run_dispatch SET cancel_requested=true WHERE user_id=$1 AND session_id=$2 AND state='selected' AND ($3::text IS NULL OR run_id=$3) RETURNING run_id", [ownerId, sessionId, runId ?? null])
        return result.rows[0] ? { ownerId, sessionId, runId: result.rows[0].run_id } : null
      })
    },
    /** 仅已提交终态或等待交互的运行可释放，且不覆盖任何活跃 Core 租约。 */
    async finish(lease: AgentDispatchLease): Promise<boolean> {
      return withPostgresTransaction(pool, async client => {
        const id = lease.identity
        if (!await lockAgentRunSession(client, id)) return false
        const receipt = lease.interactionResume?.receipt ?? null
        const result = await client.query<{ state: string }>(`UPDATE agent_run_dispatch d SET state=CASE
            WHEN EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status IN ('completed','cancelled','failed','unknown'))
              OR EXISTS (SELECT 1 FROM agent_run_startups s WHERE s.user_id=$1 AND s.session_id=$2 AND s.run_id=$3 AND s.status='failed') THEN 'done'
            ELSE 'selected' END,
          token=NULL,
          lease_expires_at=CASE WHEN (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status='waiting')
                AND (($6::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=$1 AND x.session_id=$2 AND x.run_id=$3 AND x.receipt=$6)) OR ($7::boolean AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status IN ('completed','cancelled','failed','unknown')))))
            THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,
          blocked_reason=CASE WHEN (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status='waiting')
                AND (($6::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=$1 AND x.session_id=$2 AND x.run_id=$3 AND x.receipt=$6)) OR ($7::boolean AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status IN ('completed','cancelled','failed','unknown')))))
            THEN 'unavailable' ELSE NULL END
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.state='selected' AND d.token=$4 AND d.fence=$5 AND d.lease_expires_at>clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id=$1 AND l.session_id=$2 AND l.expires_at>clock_timestamp())
          AND (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=$1 AND c.session_id=$2 AND c.run_id=$3 AND c.status IN ('waiting','completed','cancelled','failed','unknown'))
               OR EXISTS (SELECT 1 FROM agent_run_startups s WHERE s.user_id=$1 AND s.session_id=$2 AND s.run_id=$3 AND s.status='failed'))
          RETURNING state`, [id.ownerId,id.sessionId,id.runId,lease.token,lease.fence,receipt,lease.cancelRequested])
        if (result.rowCount !== 1) return false
        if (lease.interactionResume) await client.query(`UPDATE agent_interaction_resumes r SET completed_at=clock_timestamp(),claim_token=NULL,claim_expires_at=NULL
          WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.prompt_id=$4 AND r.claim_token=$5 AND r.completed_at IS NULL
            AND (EXISTS (SELECT 1 FROM agent_run_interaction_receipts x WHERE x.user_id=r.user_id AND x.session_id=r.session_id AND x.run_id=r.run_id AND x.receipt=r.receipt)
              OR EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=r.user_id AND c.session_id=r.session_id AND c.run_id=r.run_id AND c.status IN ('completed','cancelled','failed','unknown')))`,
        [id.ownerId,id.sessionId,id.runId,lease.interactionResume.promptId,lease.interactionResume.claimToken])
        if (lease.interactionResume) await client.query(`UPDATE agent_interaction_resumes SET claim_token=NULL,claim_expires_at=NULL
          WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND prompt_id=$4 AND claim_token=$5 AND completed_at IS NULL`,
        [id.ownerId,id.sessionId,id.runId,lease.interactionResume.promptId,lease.interactionResume.claimToken])
        if (result.rows[0]?.state === 'done') await promoteNext(client, id)
        else await updatePending(client, id)
        return true
      })
    },
    /** 进程退出后只结算已持久化终态，绝不重跑 Provider 或工具。 */
    async settleExpired(ownerId: string, sessionId: string): Promise<boolean> {
      const scope = { ownerId, sessionId, runId: 'scope' }
      return withPostgresTransaction(pool, async client => {
        if (!await lockAgentRunSession(client, scope)) return false
        // 等待交互和未知结果仍需原材料恢复，仅清除确定终态的过期密文。
        const cleared = await client.query(`UPDATE agent_run_dispatch d SET nonce=$3,payload=$3
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.state='done' AND d.request_expires_at<=clock_timestamp() AND octet_length(d.payload)>0
          AND (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id AND c.status IN ('completed','cancelled','failed'))
            OR (NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id) AND EXISTS (SELECT 1 FROM agent_run_startups a WHERE a.user_id=d.user_id AND a.session_id=d.session_id AND a.run_id=d.run_id AND a.status='failed')))`, [ownerId, sessionId, Buffer.alloc(0)])
        if (cleared.rowCount) return true
        const result = await client.query(`UPDATE agent_run_dispatch d SET state='done',token=NULL,lease_expires_at=NULL
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.state='selected' AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM agent_run_leases l WHERE l.user_id=$1 AND l.session_id=$2 AND l.expires_at>clock_timestamp())
          AND (EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id AND c.status IN ('completed','cancelled','failed','unknown'))
               OR EXISTS (SELECT 1 FROM agent_run_startups s WHERE s.user_id=d.user_id AND s.session_id=d.session_id AND s.run_id=d.run_id AND s.status='failed'))`, [ownerId,sessionId])
        if (result.rowCount === 1) { await promoteNext(client, scope); return true }
        const active = await client.query('SELECT 1 FROM agent_run_leases WHERE user_id=$1 AND session_id=$2 AND expires_at>clock_timestamp()', [ownerId, sessionId])
        if (active.rowCount) return false
        const session = await client.query<{ execution_state: string }>('SELECT execution_state FROM conversation_sessions WHERE user_id=$1 AND id=$2', [ownerId, sessionId])
        if (session.rows[0]?.execution_state === 'baseline_updating') return false
        const { rows: [stalled] } = await client.query<{ run_id: string; message_id: number; nonce: Buffer; payload: Buffer }>(`SELECT d.run_id,d.message_id,d.nonce,d.payload FROM agent_run_dispatch d
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.state='selected'
            AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp()) AND ${expiredInteractionResume}
          FOR UPDATE`, [ownerId, sessionId])
        if (stalled) {
          const identity = { ownerId, sessionId, runId: stalled.run_id }
          const input = decrypt(secret, identity, stalled.nonce, stalled.payload)
          if (supports(input) && agentDispatchSource(input) !== 'im' && input.userMessageId === stalled.message_id
            && await sealUnrecoverableInteraction(client, secret, identity, stalled.message_id)) {
            const args = [ownerId, sessionId, stalled.run_id]
            await client.query(`UPDATE agent_interaction_resumes SET completed_at=clock_timestamp(),claim_token=NULL,claim_expires_at=NULL
              WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND completed_at IS NULL`, args)
            await client.query(`UPDATE agent_run_dispatch SET state='done',token=NULL,lease_expires_at=NULL,blocked_reason=NULL
              WHERE user_id=$1 AND session_id=$2 AND run_id=$3`, args)
            await promoteNext(client, identity)
            return true
          }
        }
        const selected = await client.query('SELECT 1 FROM agent_run_dispatch WHERE user_id=$1 AND session_id=$2 AND state=\'selected\'', [ownerId, sessionId])
        if (!selected.rowCount) await promoteNext(client, scope)
        const expired = await client.query<{ run_id: string; message_id: number; nonce: Buffer; payload: Buffer }>(`SELECT d.run_id,d.message_id,d.nonce,d.payload FROM agent_run_dispatch d
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.state='selected' AND d.request_expires_at<=clock_timestamp()
          AND d.blocked_reason IS DISTINCT FROM 'version_conflict'
          AND (d.lease_expires_at IS NULL OR d.lease_expires_at<=clock_timestamp())
          AND NOT EXISTS (SELECT 1 FROM agent_run_checkpoints c WHERE c.user_id=d.user_id AND c.session_id=d.session_id AND c.run_id=d.run_id)
          AND EXISTS (SELECT 1 FROM agent_run_startups s WHERE s.user_id=d.user_id AND s.session_id=d.session_id AND s.run_id=d.run_id AND s.status='pending') FOR UPDATE`, [ownerId, sessionId])
        const row = expired.rows[0]
        if (!row) return false
        const identity = { ownerId, sessionId, runId: row.run_id }, input = decrypt(secret, identity, row.nonce, row.payload)
        if (input.userMessageId !== row.message_id) throw new Error('调度消息身份不匹配')
        if (agentDispatchSource(input) && !supports(input)) return false
        if (!supports(input)) {
          await client.query("UPDATE agent_run_dispatch SET blocked_reason='version_conflict',token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND run_id=$3", [ownerId, sessionId, row.run_id])
          return false
        }
        const outcome = { status: 'failed', runId: row.run_id, completedAt: new Date().toISOString(), errorCode: 'dispatch_expired' }
        const message = await client.query(`UPDATE conversation_messages m SET run_outcome=$4::jsonb WHERE m.id=$3 AND m.session_id=$2 AND m.role='user' AND m.run_outcome IS NULL
          AND EXISTS (SELECT 1 FROM conversation_sessions s WHERE s.id=m.session_id AND s.user_id=$1)`, [ownerId, sessionId, row.message_id, JSON.stringify(outcome)])
        if (message.rowCount !== 1) throw new Error('调度消息终态无法保存')
        const startup = await client.query("UPDATE agent_run_startups SET status='failed',updated_at=clock_timestamp() WHERE user_id=$1 AND session_id=$2 AND run_id=$3 AND status='pending'", [ownerId, sessionId, row.run_id])
        if (startup.rowCount !== 1) throw new Error('调度启动状态已变化')
        await client.query("UPDATE agent_run_dispatch SET state='done',nonce=$4,payload=$4,token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND session_id=$2 AND run_id=$3", [ownerId, sessionId, row.run_id, Buffer.alloc(0)])
        await promoteNext(client, identity)
        return true
      })
    },
  }
}
