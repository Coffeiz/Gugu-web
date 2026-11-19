import type { Pool, PoolClient } from 'pg'
import type { AgentChatInput } from './routes.js'
import type { RunIdentity } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import type { AgentDispatchInput, RunModelPin } from '../run/dispatch.js'
import { enqueuePostgresAgentRagRebuild } from '../rag/jobs.js'

export interface AgentChatPreparationPorts {
  /** 按 Python 会话默认值创建会话；调用方不得提交或关闭事务。 */
  createSession(client: PoolClient, ownerId: string, title: string): Promise<number>
  registerStartup(client: PoolClient, identity: RunIdentity): Promise<boolean>
  resolveAttachments(client: PoolClient, ownerId: string, input: AgentChatInput): Promise<{ cards: readonly Record<string, unknown>[]; attachIds: readonly string[] }>
  resolveReferences(client: PoolClient, ownerId: string, input: AgentChatInput): Promise<readonly unknown[] | null>
  claimAttachments(client: PoolClient, ownerId: string, messageId: number, attachIds: readonly string[]): Promise<void>
  bindQueue(client: PoolClient, ownerId: string, sessionId: number, isNew: boolean, input: AgentChatInput): Promise<void>
  enqueueDispatch(client: PoolClient, identity: RunIdentity, input: AgentDispatchInput, ttlSeconds: number): Promise<void>
}
export type AgentChatScheduling = { mode: 'direct' } | {
  mode: 'dispatch'
  origin: string | null
  /**
   * 固定值仅用于已在可信入口快照中计算过的版本；生产 Host 可在会话身份确立后
   * 解析范围版本，使队列材料绑定本次真实模型/凭据/权限快照。
   */
  accessVersion: string | ((identity: RunIdentity) => Promise<string>)
  pin?(identity: RunIdentity, credentialId?: number): Promise<RunModelPin & { accessVersion: string }>
  ttlSeconds: number
}

/** Python ORM 的客户端默认值须显式写入，不能依赖数据库具有相同的默认值。 */
export async function createPostgresWebChatSession(client: PoolClient, ownerId: string, title: string): Promise<number> {
  // IM保留在同一owner行锁内计数和替换；Web也必须参与，避免尚未提交的新会话漏入计数。
  // 调用方可能已持Session锁，NOWAIT避免与IM淘汰候选形成反序等待；失败由外层事务回滚。
  const owner = await client.query('SELECT id FROM users WHERE id=$1::uuid FOR NO KEY UPDATE NOWAIT', [ownerId])
  if (owner.rows.length !== 1) throw new Error('会话创建身份无效')
  const result = await client.query<{ id: number }>(
    `INSERT INTO conversation_sessions (user_id, title, title_locked, summary, source, context_epoch,
       baseline_message_seq, last_message_seq, execution_state, pending_message_count, created_at, updated_at)
     VALUES ($1, $2, false, '', 'web', 1, 0, 0, 'idle', 0, clock_timestamp(), clock_timestamp()) RETURNING id`,
    [ownerId, title],
  )
  const id = Number(result.rows[0]?.id)
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('会话创建失败')
  return id
}

/** 用户消息、附件 claim 和队列确认共用事务；任何端口失败均回滚。 */
export function createPostgresAgentChatPreparation(pool: Pick<Pool, 'connect'>, ports: AgentChatPreparationPorts) {
  return async (ownerId: string, input: AgentChatInput, runId: string, scheduling: AgentChatScheduling) => withPostgresTransaction(pool, async client => {
    if (!ownerId || !runId || runId.length > 128) throw new TypeError('用户或运行身份无效')
    let sessionId = input.session_id ?? null
    let isNew = false
    if (sessionId) {
      const owned = await client.query('SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE', [sessionId, ownerId])
      if (!owned.rowCount) sessionId = null
    }
    if (!sessionId) {
      sessionId = await ports.createSession(client, ownerId, Array.from(input.message).slice(0, 50).join(''))
      isNew = true
      const owned = await client.query('SELECT id FROM conversation_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE', [sessionId, ownerId])
      if (!owned.rowCount) throw new Error('会话创建身份无效')
    }
    if (!await ports.registerStartup(client, { ownerId, sessionId: String(sessionId), runId }))
      throw new Error('运行启动登记冲突')
    const greeting = isNew ? input.greeting?.trim() : ''
    const attachments = await ports.resolveAttachments(client, ownerId, input)
    const referenceContent = await ports.resolveReferences(client, ownerId, input)
    const count = greeting ? 2 : 1
    const allocation = await client.query<{ last_message_seq: string | number }>('UPDATE conversation_sessions SET last_message_seq = last_message_seq + $3 WHERE id = $1 AND user_id = $2 RETURNING last_message_seq', [sessionId, ownerId, count])
    const end = Number(allocation.rows[0]?.last_message_seq)
    if (!Number.isSafeInteger(end) || end < count) throw new Error('会话消息序号分配失败')
    if (greeting) await client.query("INSERT INTO conversation_messages (session_id, conversation_seq, role, content, created_at, sent_at) VALUES ($1,$2,'assistant',$3,clock_timestamp(),clock_timestamp())", [sessionId, end - 1, greeting])
    const inserted = await client.query<{ id: string | number }>("INSERT INTO conversation_messages (session_id, conversation_seq, role, content, client_message_id, files, references_json, content_json, created_at, sent_at) VALUES ($1,$2,'user',$3,$4,$5::json,$6::json,$7::json,clock_timestamp(),clock_timestamp()) RETURNING id", [sessionId, end, input.message, input.client_message_id ?? null, attachments.cards.length ? JSON.stringify(attachments.cards) : null, input.references?.length ? JSON.stringify(input.references) : null, referenceContent === null ? null : JSON.stringify(referenceContent)])
    const messageId = Number(inserted.rows[0]?.id)
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('用户消息创建失败')
    await enqueuePostgresAgentRagRebuild(client, ownerId, 'conversation')
    await ports.claimAttachments(client, ownerId, messageId, attachments.attachIds)
    await ports.bindQueue(client, ownerId, sessionId, isNew, input)
    if (scheduling.mode === 'dispatch') {
      const identity = { ownerId, sessionId: String(sessionId), runId }
      const pin = await scheduling.pin?.(identity, input.credential_id)
      if (input.credential_id !== undefined && !pin) throw new Error('指定凭据无法绑定到运行')
      const accessVersion = pin?.accessVersion ?? (typeof scheduling.accessVersion === 'function'
        ? await scheduling.accessVersion(identity)
        : scheduling.accessVersion)
      const model = pin && { modelIdentity: pin.modelIdentity, accessScopeHash: pin.accessScopeHash }
      if (!/^[a-f0-9]{64}$/.test(accessVersion)) throw new TypeError('运行访问范围版本无效')
      await ports.enqueueDispatch(client, identity, { userMessageId: messageId, locale: input.locale ?? null, origin: scheduling.origin, accessVersion, v: 2, source: 'web', ...(model && { model }) }, scheduling.ttlSeconds)
    }
    return { sessionId, userMessageId: messageId, isNew, runId }
  })
}
