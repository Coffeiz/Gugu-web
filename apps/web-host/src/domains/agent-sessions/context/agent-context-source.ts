import { createCanonicalSourceLoader } from '@gugu/core/agent'
import type { ContextSourcePorts, CurrentTurnSources, Json, RunIdentity, SessionSnapshotState } from '@gugu/core/agent'
import type { Pool } from 'pg'
import { createPostgresCanonicalHistoryReader } from '../persistence/agent-canonical-history-postgres.js'
import { withAgentHistoryReferences } from './agent-history-references.js'

interface SnapshotRow {
  context_epoch: number; session_context: Record<string, Json> | null; snapshot_hash: string | null
  session_info_hash: string | null; snapshot_expires_at: Date | string | null; baseline_message_seq: string | number
}
export interface OwnedCurrentMessage {
  id: string; content: string; contentJson: unknown; files: unknown; references: unknown
}
function valid(identity: RunIdentity) {
  if (!identity.ownerId || !identity.runId || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))) throw new TypeError('运行身份无效')
}

/** 快照查询只访问当前 owner 的会话；数据损坏不可伪装为空快照。 */
export function createPostgresSnapshotReader(pool: Pick<Pool, 'query'>): ContextSourcePorts['readSnapshot'] {
  return async (identity, signal) => {
    valid(identity); signal?.throwIfAborted()
    const result = await pool.query<SnapshotRow>(`SELECT context_epoch,session_context,snapshot_hash,session_info_hash,snapshot_expires_at,baseline_message_seq
      FROM conversation_sessions WHERE user_id=$1 AND id=$2`, [identity.ownerId, identity.sessionId])
    signal?.throwIfAborted()
    const row = result.rows[0]
    if (!row) return null
    const baseline = Number(row.baseline_message_seq), epoch = Number(row.context_epoch)
    const expires = row.snapshot_expires_at === null ? null : new Date(row.snapshot_expires_at).getTime()
    if (!Number.isSafeInteger(baseline) || baseline < 0 || !Number.isSafeInteger(epoch) || epoch < 0 || (expires !== null && !Number.isFinite(expires))) throw new Error('会话快照无效')
    return { ownerId: identity.ownerId, sessionId: identity.sessionId, contextEpoch: epoch, context: row.session_context, snapshotHash: row.snapshot_hash, sessionInfoHash: row.session_info_hash, snapshotExpiresAt: expires, baselineMessageSeq: baseline } satisfies SessionSnapshotState
  }
}

/** 持久化消息锚点由 Host 传入；附件、引用仍由显式授权的适配器解析。 */
export function createPostgresCurrentTurnReader(pool: Pick<Pool, 'query'>, messageId: string, materialize: (identity: RunIdentity, message: OwnedCurrentMessage, signal?: AbortSignal) => Promise<CurrentTurnSources>): ContextSourcePorts['currentTurn'] {
  if (!/^[1-9]\d*$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) throw new TypeError('消息锚点无效')
  return async (identity, signal) => {
    valid(identity); signal?.throwIfAborted()
    const result = await pool.query<{ id: string; content: string; content_json: unknown; files: unknown; references_json: unknown }>(`SELECT m.id::text,m.content,m.content_json,m.files,m.references_json
      FROM conversation_messages m JOIN conversation_sessions s ON s.id=m.session_id
      WHERE s.user_id=$1 AND s.id=$2 AND m.id=$3 AND m.role='user'`, [identity.ownerId, identity.sessionId, messageId])
    signal?.throwIfAborted()
    const row = result.rows[0]
    if (!row) throw new Error('用户消息不存在')
    const current = await materialize(identity, { id: row.id, content: row.content, contentJson: row.content_json, files: row.files, references: row.references_json }, signal)
    if (current.currentUser?.persistedMessageId !== messageId) throw new Error('用户消息锚点不一致')
    return current
  }
}

/** 不提供业务源或附件读取的空实现；缺失端口时不能装配生产上下文。 */
export function createWebAgentSourceLoader(pool: Pick<Pool, 'query' | 'connect'>, ports: Omit<ContextSourcePorts, 'readSnapshot' | 'historyReader'>) {
  return createCanonicalSourceLoader({ ...ports, readSnapshot: createPostgresSnapshotReader(pool), historyReader: withAgentHistoryReferences(pool, createPostgresCanonicalHistoryReader(pool)) })
}
