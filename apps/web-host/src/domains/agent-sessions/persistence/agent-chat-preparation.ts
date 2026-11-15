import type { Pool, PoolClient } from 'pg'
import type { AgentChatInput } from '../agent-chat-route.js'
import type { RunIdentity } from '@gugu/core/agent'
import { withPostgresTransaction } from '../../../adapters/postgres-transaction.js'
import type { AgentDispatchInput } from './agent-run-dispatch-postgres.js'

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
export type AgentChatScheduling = { mode: 'direct' } | { mode: 'dispatch'; origin: string | null; accessVersion: string; ttlSeconds: number }

/** Python ORM 的客户端默认值须显式写入，不能依赖数据库具有相同的默认值。 */
export async function createPostgresWebChatSession(client: PoolClient, ownerId: string, title: string): Promise<number> {
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
    await ports.claimAttachments(client, ownerId, messageId, attachments.attachIds)
    await ports.bindQueue(client, ownerId, sessionId, isNew, input)
    if (scheduling.mode === 'dispatch') await ports.enqueueDispatch(client, { ownerId, sessionId: String(sessionId), runId }, { userMessageId: messageId, locale: input.locale ?? null, origin: scheduling.origin, accessVersion: scheduling.accessVersion, v: 2, source: 'web' }, scheduling.ttlSeconds)
    return { sessionId, userMessageId: messageId, isNew, runId }
  })
}
