import { createHash, createHmac, randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { dataContext } from '../../contracts/index.js'
import { databaseTime, utc } from '../../data/codec.js'
import type { Database } from '../../data/schema.js'
import type { RunIdentity } from '../models.js'
import type { RunStore } from '../ports.js'
import { readDelegatedPromptBindings } from '../sessions/interaction-history.js'
import { delegatedTerminalOutcome } from './runner.js'
import { registerSqliteAgentRun } from '../run/sqlite-admission.js'
import { assertRunIdentity, createAgentRunCodec } from '../run/codec.js'
import type { DelegatedAgentLaunch, DelegatedAgentOutcome } from './contracts.js'

export type SubagentDeliveryRow = {
  child_id: string
  child_run_id: string
  request_digest: string
  status: 'queued' | 'running' | DelegatedAgentOutcome['status']
  updated_at: string
  nonce: Buffer | null
  payload: Buffer | null
  consumed_checkpoint_version?: number | string | null
}

function scope(parent: RunIdentity) {
  assertRunIdentity(parent)
  return sql`owner_id=${parent.ownerId} AND parent_session_id=${parent.sessionId} AND parent_run_id=${parent.runId}`
}

const reference = 'subagent:final:v1'
const stableChildCollision = Symbol('子会话短 ID 冲突')
const launchReference = 'subagent:launch:v1'
type SavedLaunch = Pick<DelegatedAgentLaunch, 'input' | 'modelIdentity' | 'workspaceFingerprint' | 'childId' | 'previousRunId'>
const deliveryIdentity = (parent: RunIdentity, childRunId: string) => ({
  ...parent, runId: createHash('sha256').update(JSON.stringify([parent.runId, childRunId])).digest('hex'),
})

export function createSubagentOutcomeEncoder(secret: string) {
  const codec = createAgentRunCodec(secret)
  return (parent: RunIdentity, childRunId: string, outcome: DelegatedAgentOutcome) =>
    codec.encryptContinuation(deliveryIdentity(parent, childRunId), reference, outcome)
}

export function createSubagentOutcomeDecoder(secret: string) {
  const codec = createAgentRunCodec(secret)
  return (parent: RunIdentity, row: Pick<SubagentDeliveryRow, 'child_id' | 'child_run_id' | 'status' | 'nonce' | 'payload'>) => {
    if (!row.nonce || !row.payload) return null
    const outcome = codec.decryptContinuation<DelegatedAgentOutcome>(deliveryIdentity(parent, row.child_run_id), reference, row.nonce, row.payload)
    if (outcome.status !== row.status) throw new Error('子运行终态与交付记录不匹配')
    return { childId: row.child_id, ...outcome }
  }
}

/** 共用两端数据库的加密交付记录。调用方须先核验父 Run 授权。 */
export function createSubagentDeliveryStore(db: Kysely<Database>, secret: string, now = () => new Date().toISOString(),
  sessionBackend?: 'postgres' | 'sqlite',
  registerRun?: (tx: Transaction<Database>, child: RunIdentity) => Promise<void>) {
  const codec = createAgentRunCodec(secret)
  const decode = createSubagentOutcomeDecoder(secret)
  const encode = createSubagentOutcomeEncoder(secret)

  async function read(parent: RunIdentity, childId: string) {
    const { rows: [row] } = await sql<SubagentDeliveryRow>`SELECT child_id,child_run_id,request_digest,status,updated_at,nonce,payload,consumed_checkpoint_version
      FROM agent_subagent_deliveries WHERE ${scope(parent)} AND child_id=${childId}`.execute(db)
    if (!row) return null
    const outcome = decode(parent, row)
    return { childId: row.child_id, runId: row.child_run_id, status: row.status, updatedAt: row.updated_at,
      consumed: row.consumed_checkpoint_version != null, outcome }
  }

  function sessionOwner(parent: RunIdentity) {
    const owner = dataContext(parent.ownerId).ownerId
    return sessionBackend === 'sqlite' ? owner.replaceAll('-', '') : owner
  }

  /** 父会话的确认入口只按可信派单和实际等待状态解析执行者。 */
  async function findWaitingInteraction(parent: RunIdentity, promptId: number, reader = db) {
    assertRunIdentity(parent)
    if (!sessionBackend || !Number.isSafeInteger(promptId) || promptId < 1) return null
    const [child] = await readDelegatedPromptBindings(reader, sessionBackend, parent.ownerId, Number(parent.sessionId),
      { parentRunId: parent.runId, promptId })
    return child?.authorized ? {
      identity: { ownerId: parent.ownerId, sessionId: String(child.child_session_id), runId: child.child_run_id },
      interactionId: child.interaction_id,
    } : null
  }

  /** 执行会话保留原绑定，父会话只用此坐标刷新交互卡。 */
  async function interactionPrompt(child: RunIdentity, interactionId: string) {
    const { rows: [row] } = await sql<{ id: number; status: string; expires_at: Date | string }>`
      SELECT p.id,p.status,p.expires_at FROM agent_interaction_bindings b
      JOIN interaction_prompts p ON p.id=b.prompt_id AND p.user_id=b.user_id AND p.session_id=b.session_id
      WHERE b.user_id=${sessionOwner(child)} AND b.session_id=${child.sessionId}
        AND b.run_id=${child.runId} AND b.interaction_id=${interactionId}
    `.execute(db)
    return row
  }

  async function bindChildSession(tx: Transaction<Database>, parent: RunIdentity, childId: string, runId: string, updatedAt: string) {
    if (!sessionBackend) throw new Error('子运行准入未绑定会话存储')
    const owner = sessionOwner(parent)
    const parentId = Number(parent.sessionId)
    const time = databaseTime(utc(updatedAt), sessionBackend)
    const locked = sessionBackend === 'postgres' ? sql`true` : sql`1`
    const privateImParent = sessionBackend === 'postgres' ? sql`OR EXISTS (
      SELECT 1 FROM gugu_im_inbound_receipts r WHERE r.user_id=conversation_sessions.user_id
        AND r.session_id=conversation_sessions.id AND r.run_id=${parent.runId}
        AND r.chat_type='c2c' AND r.state='dispatched'
    )` : sql``
    const { rows: [session] } = await sql<{ id: number }>`
      INSERT INTO conversation_sessions (user_id,title,title_locked,summary,source,context_epoch,last_message_seq,created_at,updated_at)
      SELECT user_id,'内部搜索任务',${locked},'','subagent',1,0,${time},${time}
      FROM conversation_sessions WHERE id=${parentId} AND user_id=${owner} AND (source IS NULL OR source='web' ${privateImParent})
      RETURNING id`.execute(tx)
    if (!session) throw new Error('父运行会话不可用')
    const inserted = await sql`INSERT INTO agent_subagent_conversations
      (owner_id,parent_session_id,child_id,child_session_id,current_run_id)
      VALUES(${parent.ownerId},${parent.sessionId},${childId},${session.id},${runId})
      ON CONFLICT(owner_id,parent_session_id,child_id) DO NOTHING RETURNING child_id`.execute(tx)
    if (!inserted.rows.length) throw stableChildCollision
    return session.id
  }

  async function saveExecution(tx: Transaction<Database>, parent: RunIdentity, sessionId: number, runId: string, launch: SavedLaunch) {
    const { nonce, payload } = codec.encryptContinuation(deliveryIdentity(parent, runId), launchReference, launch)
    await sql`INSERT INTO agent_subagent_executions (child_run_id,child_session_id,nonce,payload)
      VALUES(${runId},${sessionId},${nonce},${payload})`.execute(tx)
    if (registerRun) await registerRun(tx, { ownerId: parent.ownerId, sessionId: String(sessionId), runId })
    if (sessionBackend === 'sqlite') {
      const owner = sessionOwner(parent)
      const timestamp = databaseTime(utc(now()), 'sqlite')
      // 委派正文由加密执行记录保存，消息仅用作普通 Run 的准入锚点。
      const { rows: [message] } = await sql<{ id: number; conversation_seq: number }>`
        INSERT INTO conversation_messages (session_id,conversation_seq,role,content,created_at)
        SELECT id,last_message_seq+1,'user','子 Agent 委派',${timestamp}
        FROM conversation_sessions WHERE id=${sessionId} AND user_id=${owner} AND source='subagent'
          AND active_run_id IS NULL RETURNING id,conversation_seq`.execute(tx)
      if (!message) throw new Error('子会话无法登记运行')
      await registerSqliteAgentRun(tx, { ownerId: parent.ownerId, sessionId: String(sessionId), runId },
        message.id, message.conversation_seq, timestamp)
    }
  }

  async function complete(parent: RunIdentity, childRunId: string, outcome: DelegatedAgentOutcome) {
    const { nonce, payload } = encode(parent, childRunId, outcome)
    const settle = async (tx: Kysely<Database>) => {
      const result = await sql`UPDATE agent_subagent_deliveries SET status=${outcome.status},updated_at=${now()},nonce=${nonce},payload=${payload}
        WHERE ${scope(parent)} AND child_run_id=${childRunId} AND status IN ('queued','running') RETURNING child_id`.execute(tx)
      if (result.rows.length && sessionBackend === 'sqlite') await sql`
        UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
        WHERE user_id=${sessionOwner(parent)} AND source='subagent' AND active_run_id=${childRunId}`.execute(tx)
      return result.rows.length === 1
    }
    return sessionBackend === 'sqlite' ? db.transaction().execute(settle) : settle(db)
  }

  return {
    findWaitingInteraction,
    interactionPrompt,
    read,
    async readOutcomeByExecution(recipient: RunIdentity, childRunId: string, childId: string) {
      assertRunIdentity(recipient)
      const { rows: [row] } = await sql<SubagentDeliveryRow & { parent_run_id: string }>`
        SELECT parent_run_id,child_id,child_run_id,status,nonce,payload
        FROM agent_subagent_deliveries WHERE owner_id=${recipient.ownerId}
          AND parent_session_id=${recipient.sessionId} AND child_run_id=${childRunId} AND child_id=${childId}`.execute(db)
      return row ? decode({ ...recipient, runId: row.parent_run_id }, row) : null
    },
    async resolveConversation(caller: RunIdentity, childId: string) {
      assertRunIdentity(caller)
      if (!sessionBackend) return null
      const { rows: [row] } = await sql<{ parent_run_id: string; child_id: string }>`
        SELECT d.parent_run_id,d.child_id
        FROM agent_subagent_conversations c
        JOIN agent_subagent_deliveries d ON d.child_run_id=c.current_run_id
          AND d.owner_id=c.owner_id AND d.parent_session_id=c.parent_session_id
        WHERE c.owner_id=${caller.ownerId} AND c.parent_session_id=${caller.sessionId}
          AND c.child_id=${childId}`.execute(db)
      if (!row) return null
      const parent = { ...caller, runId: row.parent_run_id }
      const delivery = await read(parent, row.child_id)
      return delivery ? { parent, delivery: { ...delivery, childId } } : null
    },
    async listConversations(caller: RunIdentity) {
      assertRunIdentity(caller)
      const { rows } = await sql<SubagentDeliveryRow>`
        SELECT c.child_id,d.child_run_id,d.status,d.updated_at
        FROM agent_subagent_conversations c
        JOIN agent_subagent_deliveries d ON d.child_run_id=c.current_run_id
          AND d.owner_id=c.owner_id AND d.parent_session_id=c.parent_session_id
        WHERE c.owner_id=${caller.ownerId} AND c.parent_session_id=${caller.sessionId}
        ORDER BY d.updated_at DESC,c.child_id LIMIT 32`.execute(db)
      return rows.map(row => ({ childId: row.child_id, runId: row.child_run_id, status: row.status, updatedAt: row.updated_at }))
    },
    async list(parent: RunIdentity) {
      const { rows } = await sql<SubagentDeliveryRow>`SELECT child_id,child_run_id,status,updated_at
        FROM agent_subagent_deliveries WHERE ${scope(parent)} ORDER BY updated_at DESC,child_id LIMIT 32`.execute(db)
      return rows.map(row => ({ childId: row.child_id, runId: row.child_run_id, status: row.status, updatedAt: row.updated_at }))
    },
    async activeExecutions(parent: RunIdentity): Promise<RunIdentity[]> {
      assertRunIdentity(parent)
      if (!sessionBackend) return []
      const { rows } = await sql<{ child_session_id: number; child_run_id: string }>`
        SELECT e.child_session_id,e.child_run_id
        FROM agent_subagent_deliveries d JOIN agent_subagent_executions e USING(child_run_id)
        JOIN conversation_sessions child ON child.id=e.child_session_id
        WHERE d.owner_id=${parent.ownerId} AND d.parent_session_id=${parent.sessionId}
          AND d.parent_run_id=${parent.runId} AND d.status IN ('queued','running')
          AND child.user_id=${sessionOwner(parent)} AND child.source='subagent'`.execute(db)
      return rows.map(row => ({ ownerId: parent.ownerId, sessionId: String(row.child_session_id), runId: row.child_run_id }))
    },
    async hasPending(parent: RunIdentity) {
      const { rows } = await sql`SELECT 1 FROM agent_subagent_deliveries
        WHERE ${scope(parent)} AND status IN ('queued','running') LIMIT 1`.execute(db)
      return rows.length > 0
    },
    async isPending(parent: RunIdentity, childId: string) {
      const { rows } = await sql`SELECT 1 FROM agent_subagent_deliveries
        WHERE ${scope(parent)} AND child_id=${childId} AND status IN ('queued','running')`.execute(db)
      return rows.length > 0
    },
    async childIdentity(parent: RunIdentity, runId: string): Promise<RunIdentity | null> {
      if (!sessionBackend) return null
      const { rows: [row] } = await sql<{ id: number }>`
        SELECT child.id
        FROM agent_subagent_deliveries
        JOIN agent_subagent_executions USING(child_run_id)
        JOIN conversation_sessions child ON child.id=child_session_id
        WHERE ${scope(parent)} AND child_run_id=${runId}
          AND child.user_id=${sessionOwner(parent)} AND child.source='subagent'`.execute(db)
      return row ? { ownerId: parent.ownerId, sessionId: String(row.id), runId } : null
    },
    async pending(parent: RunIdentity) {
      assertRunIdentity(parent)
      const { rows } = await sql<SubagentDeliveryRow & { parent_run_id: string }>`
        SELECT parent_run_id,child_id,child_run_id,status,nonce,payload
        FROM agent_subagent_deliveries WHERE owner_id=${parent.ownerId} AND parent_session_id=${parent.sessionId}
          AND payload IS NOT NULL AND consumed_checkpoint_version IS NULL
        ORDER BY updated_at,child_run_id LIMIT 16`.execute(db)
      return rows.flatMap(row => {
        const outcome = decode({ ...parent, runId: row.parent_run_id }, row)
        return outcome ? [{ ...outcome, deliveryRunId: row.child_run_id }] : []
      })
    },
    async readLaunch(parent: RunIdentity, runId: string, includeTerminal = false): Promise<SavedLaunch | null> {
      if (!sessionBackend) return null
      const { rows: [row] } = await sql<{ nonce: Buffer; payload: Buffer; child_id: string }>`
        SELECT launch.nonce,launch.payload,agent_subagent_deliveries.child_id
        FROM agent_subagent_executions launch
        JOIN agent_subagent_deliveries USING(child_run_id)
        WHERE ${scope(parent)} AND child_run_id=${runId} AND launch.payload IS NOT NULL AND (${includeTerminal ? 1 : 0}=1 OR status IN ('queued','running'))`.execute(db)
      if (!row) return null
      const launch = codec.decryptContinuation<SavedLaunch>(deliveryIdentity(parent, runId), launchReference, row.nonce, row.payload)
      return { ...launch, childId: row.child_id }
    },
    async continueConversation(parent: RunIdentity, childId: string, callId: string, launch: SavedLaunch) {
      assertRunIdentity(parent)
      if (!sessionBackend) return null
      const receipt = `continue:${callId}`
      const requestDigest = createHmac('sha256', secret).update('subagent:continue:v1\0')
        .update(JSON.stringify([childId, launch.input.task])).digest('hex')
      return db.transaction().execute(async tx => {
        const { rows: [head] } = await sql<{ current_run_id: string; child_session_id: number }>`
          SELECT c.current_run_id,c.child_session_id FROM agent_subagent_conversations c
          WHERE c.owner_id=${parent.ownerId} AND c.parent_session_id=${parent.sessionId} AND c.child_id=${childId}
          ${sessionBackend === 'postgres' ? sql`FOR UPDATE` : sql``}`.execute(tx)
        if (!head) return null
        const { rows: [prior] } = await sql<{ child_run_id: string; request_digest: string }>`
          SELECT child_run_id,request_digest FROM agent_subagent_deliveries
          WHERE ${scope(parent)} AND call_id=${receipt}`.execute(tx)
        if (prior) {
          if (prior.request_digest !== requestDigest) throw new Error('子会话续跑回执与请求不匹配')
          return { runId: prior.child_run_id, created: false }
        }
        const { rows: [previous] } = await sql<{ parent_run_id: string; status: string }>`
          SELECT parent_run_id,status FROM agent_subagent_deliveries
          WHERE owner_id=${parent.ownerId} AND parent_session_id=${parent.sessionId}
            AND child_run_id=${head.current_run_id}`.execute(tx)
        if (!previous || !['completed', 'partial'].includes(previous.status)) return null
        // 同一父 Run 内已存在的等待回执继续对应原执行。
        if (previous.parent_run_id === parent.runId) return null
        const runId = randomUUID()
        const inserted = await sql`INSERT INTO agent_subagent_deliveries
          (owner_id,parent_session_id,parent_run_id,call_id,child_id,child_run_id,request_digest,status,updated_at)
          VALUES(${parent.ownerId},${parent.sessionId},${parent.runId},${receipt},${childId},${runId},${requestDigest},'queued',${now()})
          ON CONFLICT DO NOTHING RETURNING child_run_id`.execute(tx)
        if (!inserted.rows.length) return null
        await saveExecution(tx, parent, head.child_session_id, runId,
          { ...launch, childId, previousRunId: head.current_run_id })
        await sql`UPDATE agent_subagent_conversations SET current_run_id=${runId}
          WHERE owner_id=${parent.ownerId} AND parent_session_id=${parent.sessionId}
            AND child_id=${childId} AND current_run_id=${head.current_run_id}`.execute(tx)
        return { runId, created: true }
      })
    },
    async admit(parent: RunIdentity, callId: string, request: string, launch: SavedLaunch) {
      scope(parent)
      if (!sessionBackend) throw new Error('子运行准入未绑定会话存储')
      const requestDigest = createHmac('sha256', secret).update('subagent:admission:v1\0').update(request).digest('hex')
      for (;;) {
        const runId = randomUUID()
        const childId = runId.slice(0, 8), updatedAt = now()
        const created = await db.transaction().execute(async tx => {
          const result = await sql`INSERT INTO agent_subagent_deliveries
          (owner_id,parent_session_id,parent_run_id,call_id,child_id,child_run_id,request_digest,status,updated_at)
          VALUES(${parent.ownerId},${parent.sessionId},${parent.runId},${callId},${childId},${runId},${requestDigest},'queued',${updatedAt})
          ON CONFLICT DO NOTHING RETURNING child_id`.execute(tx)
          if (!result.rows.length) return false
          const sessionId = await bindChildSession(tx, parent, childId, runId, updatedAt)
          await saveExecution(tx, parent, sessionId, runId, launch)
          return true
        }).catch(error => {
          if (error === stableChildCollision) return false
          throw error
        })
        if (created) return { childId, runId, status: 'queued' as const, updatedAt, created: true }
        const { rows: [row] } = await sql<SubagentDeliveryRow>`SELECT child_id,child_run_id,request_digest,status,updated_at
          FROM agent_subagent_deliveries WHERE ${scope(parent)} AND call_id=${callId}`.execute(db)
        if (!row) continue // 短 ID 碰撞时生成新的 UUID。
        if (row.request_digest !== requestDigest) throw new Error('子运行派单回执与请求不匹配')
        return { childId: row.child_id, runId: row.child_run_id, status: row.status, updatedAt: row.updated_at, created: false }
      }
    },
    async commitTerminal(tx: Transaction<Database>, child: RunIdentity, parent: RunIdentity, outcome: DelegatedAgentOutcome) {
      assertRunIdentity(child)
      if (parent.ownerId !== child.ownerId) return false
      const { nonce, payload } = encode(parent, child.runId, outcome)
      const result = await sql`UPDATE agent_subagent_deliveries
        SET status=${outcome.status},updated_at=${now()},nonce=${nonce},payload=${payload}
        WHERE ${scope(parent)} AND child_run_id=${child.runId} AND status IN ('queued','running')
          AND EXISTS(SELECT 1 FROM agent_subagent_executions s
            WHERE s.child_run_id=${child.runId} AND s.child_session_id=${Number(child.sessionId)})
        RETURNING child_id`.execute(tx)
      return result.rows.length === 1
    },
    complete,
    async repairTerminalDeliveries(store: Pick<RunStore<unknown>, 'read'>, ownerId?: string) {
      if (!sessionBackend) throw new Error('子运行恢复未绑定会话存储')
      let cursor = ''
      for (;;) {
        const owner = ownerId ? sql`AND delivery.owner_id=${ownerId}` : sql``
        const { rows } = await sql<{ owner_id: string; parent_session_id: string; parent_run_id: string; child_run_id: string; child_session_id: number }>`
          SELECT delivery.owner_id,delivery.parent_session_id,delivery.parent_run_id,mapping.child_run_id,mapping.child_session_id
          FROM agent_subagent_executions mapping
          JOIN agent_subagent_deliveries delivery USING(child_run_id)
          JOIN agent_run_checkpoints checkpoint ON checkpoint.session_id=mapping.child_session_id AND checkpoint.run_id=mapping.child_run_id
          WHERE mapping.child_run_id>${cursor} AND delivery.status IN ('queued','running')
            AND replace(CAST(checkpoint.user_id AS TEXT),'-','')=replace(delivery.owner_id,'-','')
            AND checkpoint.status IN ('completed','cancelled','failed','unknown') ${owner}
          ORDER BY mapping.child_run_id LIMIT 64`.execute(db)
        if (!rows.length) return
        for (const row of rows) {
          const parent = { ownerId: row.owner_id, sessionId: row.parent_session_id, runId: row.parent_run_id }
          const checkpoint = await store.read({ ownerId: row.owner_id, sessionId: String(row.child_session_id), runId: row.child_run_id })
          const outcome = checkpoint && delegatedTerminalOutcome(checkpoint)
          if (outcome) await complete(parent, row.child_run_id, outcome)
        }
        cursor = rows.at(-1)!.child_run_id
      }
    },
    /** 由父会话保留策略提供已过期的父运行及其确认安全的保存版本。 */
    async pruneConsumed(tx: Transaction<Database>, parent: RunIdentity, throughCheckpointVersion: number) {
      if (!Number.isSafeInteger(throughCheckpointVersion) || throughCheckpointVersion < 1)
        throw new TypeError('父运行清理版本无效')
      const result = await sql`DELETE FROM agent_subagent_deliveries
        WHERE ${scope(parent)} AND consumed_checkpoint_version<=${throughCheckpointVersion} RETURNING child_id`.execute(tx)
      return result.rows.length
    },
    /** 只能由持久化父工具结果的同一事务调用。 */
    async markConsumed(tx: Transaction<Database>, parent: RunIdentity, childId: string, checkpointVersion: number) {
      if (!Number.isSafeInteger(checkpointVersion) || checkpointVersion < 1) throw new TypeError('父运行保存版本无效')
      const selected = childId.startsWith('run:')
        ? sql`owner_id=${parent.ownerId} AND parent_session_id=${parent.sessionId}
            AND child_run_id=${childId.slice(4)} AND consumed_checkpoint_version IS NULL`
        : sql`${scope(parent)} AND child_id=${childId}`
      const result = await sql`UPDATE agent_subagent_deliveries
        SET consumed_checkpoint_version=coalesce(consumed_checkpoint_version,${checkpointVersion})
        WHERE ${selected} AND payload IS NOT NULL RETURNING child_id`.execute(tx)
      return result.rows.length === 1
    },
  }
}
