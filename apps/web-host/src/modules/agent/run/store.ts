import type { Pool, PoolClient } from 'pg'
import { createAgentInboxDecoder, type AgentInboxRow, createSubagentOutcomeDecoder, createSubagentOutcomeEncoder, type SubagentDeliveryRow, RunStoreRejected } from '@gugu/core/agent'
import { createAgentRunCodec, assertRunEventTransition, assertRunIdentity as validateIdentity, sameRunIdentity as sameIdentity, assertRunCheckpoint as assertCheckpointIdentity } from '@gugu/core/agent/run/codec'
import { withBorrowedPostgresQuery } from '@gugu/core/data'
import type { Lease, RunCheckpoint, RunEvent, RunIdentity, RunStore } from '@gugu/core/agent'
import { agentRunStartupFailed, lockAgentRunSession } from './start.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import { isPostgresUniqueViolation } from '../../../adapters/database/postgres-errors.js'

export interface AgentRunHistoryWrite<C> {
  outcome: 'success' | 'interruption' | 'silent'
  context: C
  text: string
}

export interface AgentRunStoreOptions<C> {
  /** 仅在子交付成功提交后提示调度器检查持久等待。 */
  onSubagentDeliveryCommitted?(parent: RunIdentity): void | Promise<void>
  /** 私有Provider状态与每次checkpoint CAS同事务；只允许当前client与内存，不得执行网络或另借连接。 */
  persistPrivateContext?(client:PoolClient,identity:RunIdentity,next:RunCheckpoint<C>,previous:RunCheckpoint<C>|null):Promise<void>
  /** 首次 prepared checkpoint 与快照 CAS 同事务提交。 */
  applyPreparedContext?(client: PoolClient, identity: RunIdentity, context: C): Promise<void>
  /** Canonical history, usage and pending compaction must share the checkpoint transaction. */
  writeHistory(
    client: PoolClient,
    identity: RunIdentity,
    history: AgentRunHistoryWrite<C>,
    checkpoint: RunCheckpoint<C>,
  ): Promise<void>
}

interface StoredCheckpoint {
  version: string | number
  nonce: Buffer
  payload: Buffer
}

interface StoredEvent {
  event_id: string
  sequence: string | number
  nonce: Buffer
  payload: Buffer
}
const checkpointReadSql = `SELECT version, nonce, payload FROM agent_run_checkpoints
  WHERE user_id = $1 AND session_id = $2 AND run_id = $3`

function sessionNumber(sessionId: string): number {
  if (!/^[1-9]\d*$/.test(sessionId)) throw new TypeError('Agent 会话身份无效')
  const value = Number(sessionId)
  if (!Number.isSafeInteger(value)) throw new TypeError('Agent 会话身份无效')
  return value
}

async function assertLease(client: PoolClient, identity: RunIdentity, lease: Lease): Promise<void> {
  validateIdentity(identity)
  const sessionId = sessionNumber(identity.sessionId)
  const result = await client.query(
    `SELECT 1
     FROM agent_run_leases AS lease
     JOIN conversation_sessions AS session
       ON session.id = lease.session_id AND session.user_id = lease.user_id
     WHERE lease.user_id = $1 AND lease.session_id = $2 AND lease.run_id = $3
       AND lease.token = $4 AND lease.fence = $5
       AND lease.expires_at > clock_timestamp()
     FOR UPDATE OF lease`,
    [identity.ownerId, sessionId, identity.runId, lease.token, lease.fence],
  )
  if (result.rowCount !== 1) throw new RunStoreRejected('lease_lost')
}

async function insertEvents(
  client: PoolClient,
  codec: ReturnType<typeof createAgentRunCodec>,
  identity: RunIdentity,
  events: readonly RunEvent[],
): Promise<void> {
  for (const event of events) {
    if (!sameIdentity(identity, event.identity) || !Number.isSafeInteger(event.sequence) || event.sequence < 1)
      throw new TypeError('Agent run event 身份或序号无效')
    const encrypted = codec.encryptEvent(identity, event)
    await client.query(
      `INSERT INTO agent_run_events (
         user_id, session_id, run_id, event_id, sequence, nonce, payload, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())`,
      [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, event.id,
        event.sequence, encrypted.nonce, encrypted.payload],
    )
  }
}

/** 调度层持有会话锁，且已确认没有生效的执行租约。 */
export async function sealUnrecoverableInteraction(
  client: PoolClient, secret: string, identity: RunIdentity, messageId: number,
): Promise<boolean> {
  const scope = [identity.ownerId, sessionNumber(identity.sessionId), identity.runId]
  const { rows: [row] } = await client.query<StoredCheckpoint>(`${checkpointReadSql}
    AND status IN ('waiting','running','preparing') FOR UPDATE`, scope)
  if (!row) return false
  const codec = createAgentRunCodec(secret)
  const previous = codec.decryptCheckpoint<unknown>(identity, Number(row.version), row.nonce, row.payload)
  const updatedAt = new Date().toISOString()
  const displayTimeline = previous.displayTimeline.map(item => item.kind === 'tool'
    && ['queued', 'running', 'waiting'].includes(item.toolStatus ?? '') ? { ...item, toolStatus: 'unknown' as const, updatedAt } : item)
  const sealedTools = displayTimeline.filter((item, index) => item !== previous.displayTimeline[index])
  const errorCode = 'interaction_resume_timeout'
  const checkpoint = { ...previous, version: previous.version + 1, sequence: previous.sequence + 1,
    status: 'unknown' as const, phase: 'idle' as const, errorCode, remoteStatusUnknown: true,
    displayTimeline, pending: null, queuedInteractions: [], resolution: null, resolutionClosure: null }
  const encrypted = codec.encryptCheckpoint(checkpoint)
  await client.query(`UPDATE agent_run_checkpoints SET version=$4,sequence=$5,status='unknown',phase='idle',nonce=$6,payload=$7,updated_at=clock_timestamp()
    WHERE user_id=$1 AND session_id=$2 AND run_id=$3`, [...scope, checkpoint.version, checkpoint.sequence, encrypted.nonce, encrypted.payload])
  await insertEvents(client, codec, identity, [{ id: `resume-timeout:${checkpoint.sequence}`, identity,
    sequence: checkpoint.sequence, round: checkpoint.round, type: 'final',
    payload: { status: 'unknown', errorCode, remoteStatusUnknown: true, sealedTools,
      text: '确认后任务未能恢复，操作结果无法确认。请核对后再试。' } }])
  await client.query(`UPDATE conversation_messages SET run_outcome=$4::jsonb WHERE session_id=$2 AND id=$3 AND role='user' AND run_outcome IS NULL
    AND EXISTS (SELECT 1 FROM conversation_sessions WHERE user_id=$1 AND id=$2)`,
  [scope[0], scope[1], messageId, JSON.stringify({ status: 'unknown', runId: identity.runId, errorCode, completedAt: updatedAt })])
  await client.query(`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
    WHERE user_id=$1 AND id=$2 AND active_run_id=$3`, scope)
  return true
}

/** PostgreSQL RunStore：加密保存完整 checkpoint/outbox，并以租约 fencing + version CAS 原子写入。 */
export function createPostgresAgentRunStore<C>(
  pool: Pick<Pool, 'connect' | 'query'>,
  secretKey: string,
  options: AgentRunStoreOptions<C>,
): RunStore<C> & { readEventsAfter(identity: RunIdentity, sequence: number): Promise<readonly RunEvent[]>; readForUpdate(client: PoolClient, identity: RunIdentity): Promise<RunCheckpoint<C> | null> } {
  const codec = createAgentRunCodec(secretKey)
  const decodeInbox = createAgentInboxDecoder(secretKey)
  const encodeSubagentOutcome = createSubagentOutcomeEncoder(secretKey)
  const decodeSubagentOutcome = createSubagentOutcomeDecoder(secretKey)
  const decodeCheckpoint = (identity: RunIdentity, row: StoredCheckpoint | undefined): RunCheckpoint<C> | null =>
    row ? codec.decryptCheckpoint<C>(identity, Number(row.version), row.nonce, row.payload) : null

  async function loadEvents(identity: RunIdentity, after: number | null): Promise<readonly RunEvent[]> {
    validateIdentity(identity)
    const result = after === null
      ? await pool.query<StoredEvent>(`SELECT event_id, sequence, nonce, payload
         FROM agent_run_events
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND acknowledged_at IS NULL
         ORDER BY sequence ASC`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId])
      : await pool.query<StoredEvent>(`SELECT event_id, sequence, nonce, payload FROM agent_run_events
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND sequence > $4
         ORDER BY sequence ASC LIMIT 256`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, after])
    return result.rows.map(row => codec.decryptEvent(identity, row.event_id, Number(row.sequence), row.nonce, row.payload))
  }

  return {
    async hasPendingSubagents(identity) {
      validateIdentity(identity)
      const result = await pool.query(`SELECT 1 FROM agent_subagent_deliveries
        WHERE owner_id=$1 AND parent_session_id=$2 AND parent_run_id=$3 AND status IN ('queued','running') LIMIT 1`,
      [identity.ownerId, identity.sessionId, identity.runId])
      return result.rowCount === 1
    },
    async isSubagentPending(identity, childId) {
      validateIdentity(identity)
      const result = await pool.query(`SELECT 1 FROM agent_subagent_deliveries
        WHERE owner_id=$1 AND parent_session_id=$2 AND parent_run_id=$3 AND child_id=$4 AND status IN ('queued','running')`,
      [identity.ownerId, identity.sessionId, identity.runId, childId])
      return result.rowCount === 1
    },
    async readAgentInbox(identity) {
      validateIdentity(identity)
      const { rows } = await pool.query<AgentInboxRow & { recipient_run_id: string }>(`
        SELECT message_id,sender_session_id,sender_run_id,recipient_run_id,nonce,payload
        FROM agent_inbox_messages m WHERE owner_id=$1 AND recipient_session_id=$2 AND consumed_checkpoint_version IS NULL
          AND (recipient_run_id=$3 OR EXISTS (SELECT 1 FROM agent_subagent_deliveries d
            WHERE d.owner_id=m.owner_id AND d.parent_session_id=m.recipient_session_id
              AND d.parent_run_id=m.recipient_run_id AND d.child_run_id=m.sender_run_id))
        ORDER BY sequence LIMIT 16`, [identity.ownerId, identity.sessionId, identity.runId])
      return rows.map(row => decodeInbox({ ...identity, runId: row.recipient_run_id }, row))
    },
    async readSubagentFinals(identity) {
      validateIdentity(identity)
      const { rows } = await pool.query<SubagentDeliveryRow & { parent_run_id: string }>(`
        SELECT parent_run_id,child_id,child_run_id,status,nonce,payload FROM agent_subagent_deliveries
        WHERE owner_id=$1 AND parent_session_id=$2 AND payload IS NOT NULL AND consumed_checkpoint_version IS NULL
        ORDER BY updated_at,child_run_id LIMIT 16`, [identity.ownerId, identity.sessionId])
      return rows.flatMap(row => {
        const outcome = decodeSubagentOutcome({ ...identity, runId: row.parent_run_id }, row)
        return outcome ? [{ ...outcome, deliveryRunId: row.child_run_id }] : []
      })
    },
    async readForUpdate(client, identity) {
      validateIdentity(identity)
      return withBorrowedPostgresQuery(client, async query => {
        const result = await query.query<StoredCheckpoint>(`${checkpointReadSql} FOR UPDATE`, [identity.ownerId, sessionNumber(identity.sessionId), identity.runId])
        return decodeCheckpoint(identity, result.rows[0])
      })
    },
    async read(identity) {
      validateIdentity(identity)
      const result = await pool.query<StoredCheckpoint>(
        checkpointReadSql,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
      )
      return decodeCheckpoint(identity, result.rows[0])
    },

    async create(checkpoint, lease, events) {
      assertCheckpointIdentity(checkpoint.identity, checkpoint)
      if (checkpoint.version !== 0) throw new TypeError('Agent run 初始 checkpoint 版本必须为 0')
      const identity = checkpoint.identity
      assertRunEventTransition(identity, 0, checkpoint.sequence, events)
      const encrypted = codec.encryptCheckpoint(checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        if (!await lockAgentRunSession(client, identity) || await agentRunStartupFailed(client, identity)) throw new RunStoreRejected('conflict')
        await assertLease(client, identity, lease)
        await client.query(
          `INSERT INTO agent_run_checkpoints (
             user_id, session_id, run_id, version, sequence, status, phase,
             nonce, payload, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp(), clock_timestamp())`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, checkpoint.version,
            checkpoint.sequence, checkpoint.status, checkpoint.phase, encrypted.nonce, encrypted.payload],
        )
        await insertEvents(client, codec, identity, events)
        if (checkpoint.context !== null && options.applyPreparedContext)
          await options.applyPreparedContext(client, identity, checkpoint.context)
        await options.persistPrivateContext?.(client,identity,checkpoint,null)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
    },

    async commit(change) {
      assertCheckpointIdentity(change.identity, change.checkpoint)
      if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0
        || change.checkpoint.version !== change.expectedVersion + 1)
        throw new TypeError('Agent run checkpoint CAS 版本无效')
      const identity = change.identity
      const encrypted = codec.encryptCheckpoint(change.checkpoint)
      await withPostgresTransaction(pool, async (client) => {
        // 与租约获取和释放保持一致的 session → lease → checkpoint 锁顺序。
        if (!await lockAgentRunSession(client, identity)) throw new RunStoreRejected('lease_lost')
        await assertLease(client, identity, change.lease)
        const current = await client.query<{ version: string | number; sequence: string | number; nonce: Buffer; payload: Buffer }>(
          `SELECT version, sequence, nonce, payload FROM agent_run_checkpoints
           WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           FOR UPDATE`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId],
        )
        if (!current.rows[0]) throw new RunStoreRejected('not_found')
        if (Number(current.rows[0].version) !== change.expectedVersion)
          throw new RunStoreRejected('conflict')
        assertRunEventTransition(
          identity,
          Number(current.rows[0].sequence),
          change.checkpoint.sequence,
          change.events,
        )

        if (change.interactionReceipt !== null) {
          await client.query(
            `INSERT INTO agent_run_interaction_receipts (
               user_id, session_id, run_id, receipt, created_at
             ) VALUES ($1, $2, $3, $4, clock_timestamp())`,
            [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, change.interactionReceipt],
          )
        }

        const updated = await client.query(
          `UPDATE agent_run_checkpoints
           SET version = $4, sequence = $5, status = $6, phase = $7,
               nonce = $8, payload = $9, updated_at = clock_timestamp()
           WHERE user_id = $1 AND session_id = $2 AND run_id = $3 AND version = $10`,
          [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, change.checkpoint.version,
            change.checkpoint.sequence, change.checkpoint.status, change.checkpoint.phase,
            encrypted.nonce, encrypted.payload, change.expectedVersion],
        )
        if (updated.rowCount !== 1) throw new RunStoreRejected('conflict')
        if (change.agentInboxWaiting === true) await client.query(`
          INSERT INTO agent_inbox_waits(owner_id,session_id,run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [identity.ownerId, identity.sessionId, identity.runId])
        else if (change.agentInboxWaiting === false) await client.query(`DELETE FROM agent_inbox_waits
          WHERE owner_id=$1 AND session_id=$2 AND run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])
        if (change.subagentWaitChildId === null) await client.query(`DELETE FROM agent_subagent_waits
          WHERE owner_id=$1 AND parent_session_id=$2 AND parent_run_id=$3`, [identity.ownerId, identity.sessionId, identity.runId])
        else if (change.subagentWaitChildId !== undefined) await client.query(`
          INSERT INTO agent_subagent_waits(owner_id,parent_session_id,parent_run_id,child_id) VALUES($1,$2,$3,$4)
          ON CONFLICT(owner_id,parent_session_id,parent_run_id) DO UPDATE SET child_id=excluded.child_id`,
        [identity.ownerId, identity.sessionId, identity.runId, change.subagentWaitChildId])
        const delivered = [...new Set(change.subagentFinalIds ?? [])]
        if (delivered.length) {
          const consumed = await client.query(`UPDATE agent_subagent_deliveries
            SET consumed_checkpoint_version=coalesce(consumed_checkpoint_version,$5)
            WHERE owner_id=$1 AND parent_session_id=$2 AND payload IS NOT NULL
              AND ((parent_run_id=$3 AND child_id=ANY($4::text[]))
                OR (consumed_checkpoint_version IS NULL AND ('run:' || child_run_id)=ANY($4::text[])))`,
          [identity.ownerId, identity.sessionId, identity.runId, delivered, change.checkpoint.version])
          if (consumed.rowCount !== delivered.length) throw new RunStoreRejected('conflict')
        }
        const messages = [...new Set(change.inboxMessageIds ?? [])]
        if (messages.length) {
          const consumed = await client.query(`UPDATE agent_inbox_messages SET consumed_checkpoint_version=$4
            WHERE owner_id=$1 AND recipient_session_id=$2
              AND message_id=ANY($3::text[]) AND consumed_checkpoint_version IS NULL`,
          [identity.ownerId, identity.sessionId, messages, change.checkpoint.version])
          if (consumed.rowCount !== messages.length) throw new RunStoreRejected('conflict')
        }
        const terminal = change.subagentTerminalDelivery
        if (terminal) {
          const { parent, outcome } = terminal
          if (parent.ownerId !== identity.ownerId) throw new RunStoreRejected('conflict')
          const { nonce, payload } = encodeSubagentOutcome(parent, identity.runId, outcome)
          const delivery = await client.query(`UPDATE agent_subagent_deliveries
            SET status=$5,updated_at=$9,nonce=$6,payload=$7
            WHERE owner_id=$1 AND parent_session_id=$2 AND parent_run_id=$3 AND child_run_id=$4
              AND status IN ('queued','running') AND EXISTS(SELECT 1 FROM agent_subagent_executions
                WHERE child_run_id=$4 AND child_session_id=$8)`,
          [parent.ownerId, parent.sessionId, parent.runId, identity.runId, outcome.status, nonce, payload, sessionNumber(identity.sessionId), new Date().toISOString()])
          if (delivery.rowCount !== 1) throw new RunStoreRejected('conflict')
        }
        await insertEvents(client, codec, identity, change.events)
        if (change.checkpoint.context !== null && options.applyPreparedContext) {
          const previous = codec.decryptCheckpoint<C>(identity, Number(current.rows[0].version), current.rows[0].nonce, current.rows[0].payload)
          if (previous.context === null)
            await options.applyPreparedContext(client, identity, change.checkpoint.context)
        }
        if(options.persistPrivateContext)await options.persistPrivateContext(client,identity,change.checkpoint,codec.decryptCheckpoint<C>(identity,Number(current.rows[0].version),current.rows[0].nonce,current.rows[0].payload))
        if (change.history !== null)
          await options.writeHistory(client, identity, change.history, change.checkpoint)
      }, (error) => isPostgresUniqueViolation(error) ? new RunStoreRejected('conflict') : error)
      if (change.subagentTerminalDelivery && options.onSubagentDeliveryCommitted) {
        try { await options.onSubagentDeliveryCommitted(change.subagentTerminalDelivery.parent) }
        catch { /* 通知丢失由调度扫描补偿，事务已提交。 */ }
      }
    },

    async pendingEvents(identity) {
      return loadEvents(identity, null)
    },

    async readEventsAfter(identity, sequence) {
      validateIdentity(identity)
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError('Agent run 事件序号无效')
      return loadEvents(identity, sequence)
    },

    async acknowledgeEvents(identity, ids) {
      validateIdentity(identity)
      if (ids.length === 0) return
      await pool.query(
        `UPDATE agent_run_events SET acknowledged_at = clock_timestamp()
         WHERE user_id = $1 AND session_id = $2 AND run_id = $3
           AND event_id = ANY($4::text[]) AND acknowledged_at IS NULL`,
        [identity.ownerId, sessionNumber(identity.sessionId), identity.runId, [...new Set(ids)]],
      )
    },
  }
}
