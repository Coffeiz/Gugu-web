import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../../data/schema.js'
import type { RunIdentity } from '../models.js'
import { assertRunIdentity, createAgentRunCodec } from '../run/codec.js'

export type AgentInboxTarget = { childId: string } | { parent: true }
export type AgentInboxRow = { message_id: string; sender_session_id: string; sender_run_id: string; nonce: Buffer; payload: Buffer }
const reference = 'agent:inbox:v1'

function cipherIdentity(recipient: RunIdentity, row: Pick<AgentInboxRow, 'message_id' | 'sender_session_id' | 'sender_run_id'>) {
  const runId = createHash('sha256').update(JSON.stringify([recipient.runId, row.sender_session_id, row.sender_run_id, row.message_id])).digest('hex')
  return { ...recipient, runId }
}

export function createAgentInboxDecoder(secret: string) {
  const codec = createAgentRunCodec(secret)
  return (recipient: RunIdentity, row: AgentInboxRow) => ({
    id: row.message_id,
    ...codec.decryptContinuation<{ message: string; target: AgentInboxTarget }>(cipherIdentity(recipient, row), reference, row.nonce, row.payload),
  })
}

export function createAgentInbox(db: Kysely<Database>, secret: string, options: {
  onMessageCommitted?(recipient: RunIdentity): void | Promise<void>
} = {}) {
  const codec = createAgentRunCodec(secret)
  const decode = createAgentInboxDecoder(secret)
  return {
    async pending(recipient: RunIdentity) {
      assertRunIdentity(recipient)
      const { rows } = await sql<AgentInboxRow & { recipient_run_id: string }>`
        SELECT message_id,sender_session_id,sender_run_id,recipient_run_id,nonce,payload
        FROM agent_inbox_messages m WHERE owner_id=${recipient.ownerId} AND recipient_session_id=${recipient.sessionId}
          AND consumed_checkpoint_version IS NULL AND (recipient_run_id=${recipient.runId} OR EXISTS (
            SELECT 1 FROM agent_subagent_deliveries d WHERE d.owner_id=m.owner_id
              AND d.parent_session_id=m.recipient_session_id AND d.parent_run_id=m.recipient_run_id
              AND d.child_run_id=m.sender_run_id
          ))
        ORDER BY sequence LIMIT 16`.execute(db)
      return rows.map(row => decode({ ...recipient, runId: row.recipient_run_id }, row))
    },
    async send(sender: RunIdentity, target: AgentInboxTarget, callId: string, message: string, replayOnly = false) {
      assertRunIdentity(sender)
      const from = sql`owner_id=${sender.ownerId} AND sender_session_id=${sender.sessionId} AND sender_run_id=${sender.runId} AND call_id=${callId}`
      const saved = await db.transaction().execute(async tx => {
        async function replay() {
          const { rows: [row] } = await sql<AgentInboxRow & { recipient_session_id: string; recipient_run_id: string }>`
            SELECT message_id,sender_session_id,sender_run_id,recipient_session_id,recipient_run_id,nonce,payload
            FROM agent_inbox_messages WHERE ${from}`.execute(tx)
          if (!row) return null
          const saved = decode({ ownerId: sender.ownerId, sessionId: row.recipient_session_id, runId: row.recipient_run_id }, row)
          if (saved.message !== message || JSON.stringify(saved.target) !== JSON.stringify(target))
            throw new Error('子运行消息回执与请求不匹配')
          return saved.id
        }
        const prior = await replay()
        if (prior) return { messageId: prior }
        if (replayOnly) return null
        const relation = 'childId' in target
          ? sql`d.parent_session_id=${sender.sessionId} AND EXISTS (
            SELECT 1 FROM agent_subagent_conversations c
            WHERE c.owner_id=d.owner_id AND c.parent_session_id=d.parent_session_id
              AND c.child_id=${target.childId} AND c.current_run_id=d.child_run_id
              AND c.child_session_id=s.child_session_id
          )`
          : sql`s.child_session_id=${Number(sender.sessionId)} AND d.child_run_id=${sender.runId}`
        const { rows: [link] } = await sql<{ child_session_id: number; child_run_id: string; parent_session_id: string; parent_run_id: string; status: string }>`
          SELECT s.child_session_id,d.child_run_id,d.parent_session_id,d.parent_run_id,d.status
          FROM agent_subagent_deliveries d JOIN agent_subagent_executions s USING(child_run_id)
          WHERE d.owner_id=${sender.ownerId} AND ${relation}`.execute(tx)
        if (!link) return null
        if (link.status !== 'queued' && link.status !== 'running') return null
        const recipient = 'childId' in target
          ? { ownerId: sender.ownerId, sessionId: String(link.child_session_id), runId: link.child_run_id }
          : { ownerId: sender.ownerId, sessionId: link.parent_session_id, runId: link.parent_run_id }
        const messageId = randomUUID()
        const { nonce, payload } = codec.encryptContinuation(cipherIdentity(recipient, {
          message_id: messageId, sender_session_id: sender.sessionId, sender_run_id: sender.runId,
        }), reference, { target, message })
        const { rows } = await sql`INSERT INTO agent_inbox_messages
          (owner_id,sender_session_id,sender_run_id,recipient_session_id,recipient_run_id,call_id,message_id,nonce,payload)
          VALUES(${sender.ownerId},${sender.sessionId},${sender.runId},${recipient.sessionId},${recipient.runId},${callId},${messageId},${nonce},${payload})
          ON CONFLICT(owner_id,sender_session_id,sender_run_id,call_id) DO NOTHING RETURNING message_id`.execute(tx)
        if (rows.length) return { messageId, recipient }
        const existing = await replay()
        if (!existing) throw new Error('子运行消息回执不存在')
        return { messageId: existing }
      })
      if (saved && 'recipient' in saved && saved.recipient && options.onMessageCommitted) {
        try { await options.onMessageCommitted(saved.recipient) }
        catch { /* 消息已保存，恢复时可再次读取。 */ }
      }
      return saved ? { messageId: saved.messageId } : null
    },
  }
}
